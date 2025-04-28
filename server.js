const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }, // Cho phép kết nối từ mọi nguồn (nên giới hạn trong production)
});

const rooms = {}; // Lưu trữ thông tin các phòng chơi trong bộ nhớ
const matchQueue = []; // Hàng đợi tìm trận
const REJOIN_TIMEOUT = 60000; // Thời gian chờ kết nối lại (60 giây)
const INITIAL_TIME = 900; // Thời gian ban đầu mỗi người chơi (giây) - 15 phút

// --- Helper Functions for Timer ---

// Dừng timer cho phòng và tính toán thời gian cuối cùng
function stopPlayerTimer(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    // Dừng interval hiện tại nếu đang chạy
    if (room.timerIntervalId) {
        clearInterval(room.timerIntervalId);
        room.timerIntervalId = null;
        console.log(`[${roomId}] Timer interval cleared by stopPlayerTimer.`);
    }

    // Tính toán và cập nhật thời gian chính xác khi dừng (dựa trên thời gian bắt đầu lượt)
    const now = Date.now();
    if (room.turnStartTime && room.turn) { // Chỉ tính nếu lượt đã bắt đầu và có người đang đến lượt
        const elapsedThisTurn = (now - room.turnStartTime) / 1000; // Giây
        const currentPlayer = room.players.find(p => p.id === room.turn); // Tìm người chơi có lượt

        if (currentPlayer) {
            if (currentPlayer.color === 'white') {
                // Cập nhật thời gian còn lại
                room.whiteTime = Math.max(0, room.initialWhiteTime - elapsedThisTurn);
                // Cập nhật thời gian gốc cho lượt sau (hoặc giữ nguyên nếu game over)
                room.initialWhiteTime = room.whiteTime;
            } else {
                room.blackTime = Math.max(0, room.initialBlackTime - elapsedThisTurn);
                room.initialBlackTime = room.blackTime;
            }
             console.log(`[${roomId}] Timer stopped for ${room.turn}. Exact time left: W=${room.whiteTime.toFixed(1)}s, B=${room.blackTime.toFixed(1)}s`);
        }
    }
    room.turnStartTime = null; // Reset thời gian bắt đầu lượt
}

// Bắt đầu timer cho người chơi đang có lượt trong phòng
function startPlayerTimer(roomId) {
    const room = rooms[roomId];
    // Các điều kiện không bắt đầu timer
    if (!room || room.timerIntervalId || room.game.isGameOver() || !room.turn) {
         console.log(`[${roomId}] Timer start prevented: Room invalid, timer exists, game over, or no turn.`);
        return;
    }

    // Tìm người chơi hiện tại và kiểm tra trạng thái kết nối
    const currentPlayer = room.players.find(p => p.id === room.turn);
    if (!currentPlayer || currentPlayer.status !== 'connected') {
        console.log(`[${roomId}] Timer not started: Player ${room.turn} is not connected.`);
        return;
    }
    // Tìm đối thủ và kiểm tra trạng thái kết nối (thường không cần timer nếu đối thủ disconnect)
     const opponent = room.players.find(p => p.id !== room.turn);
     if (!opponent || opponent.status !== 'connected') {
         console.log(`[${roomId}] Timer not started: Opponent ${opponent?.id} is not connected.`);
         return;
     }


    // Đặt thời gian bắt đầu lượt và khởi chạy interval
    room.turnStartTime = Date.now();
    console.log(`[${roomId}] Timer starting for ${room.turn} (Color: ${currentPlayer.color}) at ${room.turnStartTime}. Initial time for turn: ${currentPlayer.color === 'white' ? room.initialWhiteTime.toFixed(1) : room.initialBlackTime.toFixed(1)}s`);

    room.timerIntervalId = setInterval(() => {
        const currentRoom = rooms[roomId]; // Lấy trạng thái phòng mới nhất bên trong interval

        // Kiểm tra điều kiện dừng interval
        if (!currentRoom || currentRoom.game.isGameOver() || !currentRoom.turn || currentRoom.timerIntervalId !== room.timerIntervalId) { // Kiểm tra ID để tránh interval cũ chạy
            if(currentRoom && currentRoom.timerIntervalId) { // Chỉ clear nếu ID khớp
                 clearInterval(currentRoom.timerIntervalId);
                 currentRoom.timerIntervalId = null; // Quan trọng: đặt lại ID
                 console.log(`[${roomId}] Timer interval ${room.timerIntervalId} cleared (game over, no turn, or new timer started).`);
            } else if (!currentRoom) {
                 console.log(`[${roomId}] Timer interval could not be cleared: Room gone.`);
            }
            return; // Dừng interval này
        }

        const now = Date.now();
        // Tính thời gian trôi qua kể từ đầu lượt
        const elapsedThisTurn = (now - currentRoom.turnStartTime) / 1000;
        let timeToUpdate = 0; // Thời gian còn lại của người chơi hiện tại
        let isTimeout = false;

        // Cập nhật thời gian dựa trên người có lượt
        if (currentRoom.turn === currentRoom.players[0].id) { // Lượt Trắng
            currentRoom.whiteTime = Math.max(0, currentRoom.initialWhiteTime - elapsedThisTurn);
            timeToUpdate = currentRoom.whiteTime;
        } else { // Lượt Đen
            currentRoom.blackTime = Math.max(0, currentRoom.initialBlackTime - elapsedThisTurn);
            timeToUpdate = currentRoom.blackTime;
        }

        // Gửi cập nhật cho clients
        io.to(roomId).emit("timerUpdate", {
            whiteTime: currentRoom.whiteTime,
            blackTime: currentRoom.blackTime,
        });

        // Kiểm tra hết giờ
        if (timeToUpdate <= 0) {
            isTimeout = true;
            const loserId = currentRoom.turn;
            const winnerId = currentRoom.players.find(p => p.id !== loserId)?.id;

            console.log(`[${roomId}] Timer ended for ${loserId}. Winner: ${winnerId}`);
            io.to(roomId).emit("gameOver", {
                result: "win",
                winner: winnerId,
                loser: loserId,
                reason: "timeout",
                message: `Người chơi ${winnerId || 'Không xác định'} thắng do ${loserId} hết thời gian!`,
            });

            stopPlayerTimer(roomId); // Dừng và tính toán thời gian cuối cùng
        }

    }, 1000); // Chạy mỗi giây
}

// --- Socket Handlers ---

io.on("connection", (socket) => {
    console.log(`🟢 Người chơi đã kết nối: ${socket.id}`);

    // --- Matchmaking ---
    socket.on("startMatch", () => {
        console.log(`👤 Người chơi ${socket.id} bắt đầu tìm trận`);
        if (matchQueue.some(player => player.id === socket.id) || Object.values(rooms).some(room => room.players.some(p => p.currentSocketId === socket.id && p.status === 'connected'))) {
             console.log(`[${socket.id}] Already in queue or active game.`);
             return; // Tránh thêm người chơi đã có trong hàng đợi hoặc đang chơi
        }
        matchQueue.push(socket);

        if (matchQueue.length >= 2) {
            const player1Socket = matchQueue.shift();
            const player2Socket = matchQueue.shift();
            // Kiểm tra xem socket còn kết nối không trước khi tạo phòng
            if (!player1Socket.connected || !player2Socket.connected) {
                 console.error("One or both players disconnected before match could start. Returning remaining player to queue.");
                 if (player1Socket.connected) matchQueue.unshift(player1Socket);
                 if (player2Socket.connected) matchQueue.unshift(player2Socket);
                 return;
            }

            const roomId = `room_${Date.now()}`;
            const player1 = { id: player1Socket.id, currentSocketId: player1Socket.id, color: 'white', status: 'connected' };
            const player2 = { id: player2Socket.id, currentSocketId: player2Socket.id, color: 'black', status: 'connected' };

            rooms[roomId] = {
                roomId: roomId, // Thêm ID phòng vào object room để dễ truy cập
                players: [player1, player2],
                game: new Chess(),
                history: [],
                turn: player1.id, // Trắng đi trước
                whiteTime: INITIAL_TIME, blackTime: INITIAL_TIME,
                initialWhiteTime: INITIAL_TIME, initialBlackTime: INITIAL_TIME, // Thời gian gốc khi bắt đầu lượt
                turnStartTime: null,
                timerIntervalId: null,
                rejoinTimeoutId: {}, // { playerId: timeoutId }
                playerStatus: { [player1.id]: 'connected', [player2.id]: 'connected' },
                disconnectTime: {} // { playerId: timestamp }
            };

            player1Socket.join(roomId);
            player2Socket.join(roomId);
            console.log(`🎉 Ghép cặp thành công! Phòng ${roomId}: ${player1.id} (Trắng) vs ${player2.id} (Đen)`);

            // Gửi thông tin bắt đầu game cho từng người
            player1Socket.emit("gameStart", { color: player1.color, turn: rooms[roomId].turn, roomId, playerToken: player1.id, whiteTime: INITIAL_TIME, blackTime: INITIAL_TIME });
            player2Socket.emit("gameStart", { color: player2.color, turn: rooms[roomId].turn, roomId, playerToken: player2.id, whiteTime: INITIAL_TIME, blackTime: INITIAL_TIME });

            startPlayerTimer(roomId); // Bắt đầu timer cho Trắng
        }
    });

    socket.on("cancelMatch", () => {
        console.log(`👤 Người chơi ${socket.id} hủy tìm trận`);
        const index = matchQueue.findIndex(player => player.id === socket.id);
        if (index !== -1) {
            matchQueue.splice(index, 1);
            console.log(`[${socket.id}] Removed from queue.`);
        }
    });

    // --- Game Actions ---
    socket.on("move", ({ roomId, move }) => {
        const room = rooms[roomId];
        if (!room) { console.error(`[${roomId}] Phòng không tồn tại khi nhận nước đi.`); return; }
        if (room.game.isGameOver()) { console.warn(`[${roomId}] Nhận nước đi khi game đã kết thúc.`); return; }

        const player = room.players.find(p => p.currentSocketId === socket.id);
        if (!player) { console.error(`[${roomId}] Không tìm thấy người chơi ${socket.id} trong phòng.`); return; }
        if (player.id !== room.turn) { console.warn(`[${roomId}] ${player.id} đi sai lượt (lượt của ${room.turn}).`); return; }

        const opponent = room.players.find(p => p.id !== player.id);
        if (opponent && opponent.status === 'disconnected') {
             console.warn(`[${roomId}] ${player.id} cố đi khi ${opponent.id} đang disconnected.`);
             socket.emit("opponentStillDisconnected", { message: "Đối thủ đang tạm thời ngắt kết nối, vui lòng đợi." });
             return;
         }

        console.log(`[${roomId}] Nước đi nhận từ ${player.id}: ${JSON.stringify(move)}, FEN trước: ${room.game.fen()}`);

        // Dừng timer người chơi hiện tại TRƯỚC khi thực hiện nước đi
        stopPlayerTimer(roomId);

        const game = room.game;
        const validMoveResult = game.move(move); // Thử thực hiện nước đi

        if (validMoveResult === null) { // Nước đi không hợp lệ
            console.error(`[${roomId}] Nước đi không hợp lệ từ ${player.id}: ${JSON.stringify(move)}`);
            socket.emit("invalidMove", { move, message: "Nước đi không hợp lệ!" });
            // Khởi động lại timer cho người chơi hiện tại vì nước đi không thành công
            startPlayerTimer(roomId);
            return;
        }

        // Nước đi hợp lệ
        console.log(`[${roomId}] ✅ Nước đi hợp lệ bởi ${player.id}:`, validMoveResult.san);
        room.history.push(validMoveResult); // Lưu nước đi đầy đủ

        // Cập nhật thời gian ban đầu cho lượt sau (đã được tính trong stopPlayerTimer)

        const fen = game.fen();
        io.to(roomId).emit("opponentMove", { move: validMoveResult, fen }); // Gửi nước đi và FEN mới

        // Kiểm tra kết thúc game
        let gameOverHandled = false;
        if (game.isCheckmate()) {
             const winnerId = opponent.id; // Người vừa đi là người thắng
             const loserId = player.id;
             console.log(`[${roomId}] Checkmate! Winner: ${winnerId}`);
             io.to(roomId).emit("gameOver", { result: "win", winner: winnerId, loser: loserId, reason: "checkmate", message: `Người chơi ${winnerId} thắng do chiếu hết!` });
             gameOverHandled = true;
         } else if (game.isStalemate() || game.isDraw() || game.isInsufficientMaterial()) {
             console.log(`[${roomId}] Draw! Reason: ${game.isStalemate() ? "stalemate" : game.isInsufficientMaterial() ? "insufficient material" : "draw"}`);
             io.to(roomId).emit("gameOver", { result: "draw", reason: game.isStalemate() ? "stalemate" : game.isInsufficientMaterial() ? "insufficient material" : "draw", message: "Ván cờ hòa!" });
             gameOverHandled = true;
         }

        // Nếu game chưa kết thúc, chuyển lượt và bắt đầu timer mới
        if (!gameOverHandled) {
            room.turn = opponent.id; // Chuyển lượt sang đối thủ
            // Cập nhật thời gian gốc cho lượt mới của đối thủ
             if(opponent.color === 'white'){ room.initialWhiteTime = room.whiteTime; }
             else { room.initialBlackTime = room.blackTime; }
             console.log(`[${roomId}] ➡ Lượt tiếp theo: ${room.turn}, FEN sau: ${fen}`);
             io.to(roomId).emit("updateTurn", { turn: room.turn });
             startPlayerTimer(roomId); // Bắt đầu timer cho người chơi tiếp theo
        } else {
            // Dọn dẹp nếu game đã kết thúc
             stopPlayerTimer(roomId); // Đảm bảo timer đã dừng hẳn
             Object.values(room.rejoinTimeoutId).forEach(clearTimeout); // Clear mọi timeout rejoin
             room.rejoinTimeoutId = {};
             console.log(`[${roomId}] Game ended. Rejoin timeouts cleared.`);
             // Không xóa phòng ngay lập tức
        }
    });

    // --- Rejoin Logic ---
    socket.on("rejoinGame", ({ roomId, playerToken }) => {
        console.log(`[${roomId}] Yêu cầu rejoin từ Token: ${playerToken}, Socket: ${socket.id}.`);
        const room = rooms[roomId];

        if (!room) { console.log(`[${roomId}] Rejoin Fail: Phòng không tồn tại.`); socket.emit("rejoinFailed", { reason: "room_not_found", message: "Phòng không tồn tại hoặc đã kết thúc." }); return; }
        const player = room.players.find(p => p.id === playerToken);
        if (!player) { console.log(`[${roomId}] Rejoin Fail: Token không hợp lệ (${playerToken}).`); socket.emit("rejoinFailed", { reason: "invalid_token", message: "Thông tin người chơi không hợp lệ." }); return; }

        if (player.status !== 'disconnected') {
             console.log(`[${roomId}] Rejoin Info: Người chơi ${playerToken} đang ${player.status}. Cập nhật socket ID nếu cần.`);
             if (player.currentSocketId !== socket.id) { player.currentSocketId = socket.id; socket.join(roomId); } // Cập nhật socket và join lại phòng
             socket.emit("rejoinStatus", { message: `Bạn đang ở trạng thái ${player.status}.`, currentStatus: player.status});
             // Gửi lại trạng thái game cho người chơi này để đảm bảo đồng bộ
             const opponent = room.players.find(p => p.id !== player.id);
              socket.emit("gameRejoined", {
                   color: player.color, turn: room.turn, roomId, playerToken: player.id,
                   fen: room.game.fen(), history: room.history,
                   whiteTime: room.whiteTime, blackTime: room.blackTime,
                   opponentStatus: opponent?.status ?? 'unknown'
               });
             return;
         }

        const disconnectTime = room.disconnectTime[player.id];
        if (disconnectTime && (Date.now() - disconnectTime > REJOIN_TIMEOUT)) {
             console.log(`[${roomId}] Rejoin Fail: Hết ${REJOIN_TIMEOUT / 1000}s chờ cho ${player.id}.`);
             socket.emit("rejoinFailed", { reason: "timeout_expired", message: "Đã hết thời gian chờ để kết nối lại." });
             // Dọn phòng nếu timeout chưa kịp chạy
              if (rooms[roomId]) {
                   const winner = room.players.find(p => p.id !== player.id);
                   io.to(roomId).emit("gameOver", { result: "win", winner: winner?.id, loser: player.id, reason: "abandoned", message: `Người chơi ${winner?.id || 'Không xác định'} thắng do ${player.id} thoát trận!` });
                   stopPlayerTimer(roomId); delete rooms[roomId]; console.log(`[${roomId}] Phòng xóa do timeout (kiểm tra trong rejoinGame).`);
              }
             return;
         }

        // --- Rejoin Success ---
        console.log(`[${roomId}] Rejoin check OK cho ${player.id}.`);
        if (room.rejoinTimeoutId[player.id]) { clearTimeout(room.rejoinTimeoutId[player.id]); delete room.rejoinTimeoutId[player.id]; console.log(`[${roomId}] Timeout rejoin đã hủy cho ${player.id}.`); }

        player.status = 'connected'; player.currentSocketId = socket.id; room.playerStatus[player.id] = 'connected'; delete room.disconnectTime[player.id];
        socket.join(roomId);
        console.log(`[${roomId}] ✅ ${player.id} rejoin thành công với socket ${socket.id}.`);

        const opponent = room.players.find(p => p.id !== player.id);
        socket.emit("gameRejoined", {
            color: player.color, turn: room.turn, roomId, playerToken: player.id,
            fen: room.game.fen(), history: room.history,
            whiteTime: room.whiteTime, blackTime: room.blackTime,
            opponentStatus: opponent?.status ?? 'unknown'
        });
        if (opponent && opponent.status === 'connected') { io.to(opponent.currentSocketId).emit("playerReconnected", { reconnectedPlayerId: player.id }); }

         // Khởi động lại timer nếu cả 2 cùng connected
         if (opponent && opponent.status === 'connected') {
             console.log(`[${roomId}] Both players connected after rejoin. Ensuring timer runs.`);
              startPlayerTimer(roomId);
          } else {
              console.log(`[${roomId}] Timer not restarted after rejoin: Opponent (${opponent?.id}) is ${opponent?.status}.`);
          }
    });

    // --- Disconnect Handling ---
    socket.on("disconnect", (reason) => {
        console.log(`🔴 Người chơi ngắt kết nối: ${socket.id}. Lý do: ${reason}`);
        const queueIndex = matchQueue.findIndex(player => player.id === socket.id);
        if (queueIndex !== -1) { matchQueue.splice(queueIndex, 1); console.log(`[${socket.id}] Đã xóa khỏi hàng đợi do disconnect.`); }

        let roomIdFound = null; let playerInfo = null;
        for (const id in rooms) {
             const room = rooms[id];
             const playerIndex = room.players.findIndex(p => p.currentSocketId === socket.id);
              if (playerIndex !== -1) { roomIdFound = id; playerInfo = room.players[playerIndex]; break; }
         }

        if (roomIdFound && playerInfo) {
            const room = rooms[roomIdFound];
            console.log(`[${roomIdFound}] Người chơi ${playerInfo.id} (socket ${socket.id}) disconnected.`);

            if (!room.game.isGameOver() && playerInfo.status === 'connected') {
                 playerInfo.status = 'disconnected'; room.playerStatus[playerInfo.id] = 'disconnected'; room.disconnectTime[playerInfo.id] = Date.now();
                 stopPlayerTimer(roomIdFound); // Dừng đồng hồ ngay

                 const opponent = room.players.find(p => p.id !== playerInfo.id);
                 if (opponent && opponent.status === 'connected') { io.to(opponent.currentSocketId).emit("opponentDisconnected", { disconnectedPlayerId: playerInfo.id }); }

                 if (!room.rejoinTimeoutId[playerInfo.id]) {
                      console.log(`[${roomIdFound}] Bắt đầu ${REJOIN_TIMEOUT / 1000}s timeout chờ rejoin cho ${playerInfo.id}.`);
                      room.rejoinTimeoutId[playerInfo.id] = setTimeout(() => { 
                            const currentRoom = rooms[roomIdFound]; if (!currentRoom) return;
                             if (currentRoom.playerStatus[playerInfo.id] === 'disconnected') {
                                 console.log(`[${roomIdFound}] Timeout: ${playerInfo.id} không rejoin. Game over.`);
                                 const winner = currentRoom.players.find(p => p.id !== playerInfo.id);
                                 io.to(roomIdFound).emit("gameOver", { result: "win", winner: winner?.id, loser: playerInfo.id, reason: "abandoned", message: `Người chơi ${winner?.id || 'Không xác định'} thắng do ${playerInfo.id} thoát trận!` });
                                 stopPlayerTimer(roomIdFound); delete currentRoom.rejoinTimeoutId[playerInfo.id]; delete rooms[roomIdFound]; console.log(`[${roomIdFound}] Phòng xóa do bỏ cuộc (timeout).`);
                             } else { delete currentRoom.rejoinTimeoutId[playerInfo.id]; console.log(`[${roomIdFound}] Timeout hủy cho ${playerInfo.id} vì trạng thái thay đổi.`); }
                       }, REJOIN_TIMEOUT);
                  }
            } else {
                if (playerInfo.status === 'connected') { // Chỉ cập nhật nếu đang là connected
                     playerInfo.status = 'disconnected'; room.playerStatus[playerInfo.id] = 'disconnected'; room.disconnectTime[playerInfo.id] = Date.now();
                     console.log(`[${roomIdFound}] Player ${playerInfo.id} disconnected after game ended.`);
                 }
                 const allDisconnected = room.players.every(p => p.status === 'disconnected');
                 if (allDisconnected) { console.log(`[${roomIdFound}] Cả hai đã disconnect sau game over. Xóa phòng.`); stopPlayerTimer(roomIdFound); Object.values(room.rejoinTimeoutId).forEach(clearTimeout); delete rooms[roomIdFound]; }
             }
        } else { console.log(`[${socket.id}] Disconnected player not in any active room.`); }
    });

    // --- Other Events (Chat, New Game) ---
    socket.on("sendMessage", ({ roomId, message }) => { 
         const room = rooms[roomId]; if (!room) return; const senderPlayer = room.players.find(p => p.currentSocketId === socket.id); if (!senderPlayer) return;
          const opponent = room.players.find(p => p.id !== senderPlayer.id);
          if (opponent && opponent.status === 'connected') { console.log(`[${roomId}] 💬 ${senderPlayer.id}: ${message.message}`); io.to(opponent.currentSocketId).emit("receiveMessage", { sender: senderPlayer.id, message: message.message }); }
    });
});


// --- Cleanup Interval ---
setInterval(() => {
     const now = Date.now();
     console.log("Running cleanup task...");
     let deletedCount = 0;
     for (let roomId in rooms) {
         const room = rooms[roomId];
         let shouldDelete = false;
         const allDisconnected = room.players.every(p => p.status === 'disconnected');

         if (allDisconnected && room.game.isGameOver()) {
             const lastDisconnectTime = Math.max(0, ...Object.values(room.disconnectTime));
             if (now - lastDisconnectTime > 300000) { // 5 phút sau disconnect cuối cùng (khi game đã end)
                 console.log(`[${roomId}] Dọn phòng cũ (cả 2 disconnected > 5 phút sau game over).`);
                 shouldDelete = true;
             }
         } else if (room.players.length === 0) {
              console.log(`[${roomId}] Dọn phòng không có người chơi.`);
              shouldDelete = true;
         }

         if (shouldDelete) {
             stopPlayerTimer(roomId); // Dừng timer nếu còn
             Object.values(room.rejoinTimeoutId).forEach(clearTimeout); // Clear timeout rejoin
             delete rooms[roomId];
             deletedCount++;
         }
     }
      if(deletedCount > 0) console.log(`Cleanup task finished. Deleted ${deletedCount} rooms.`);
 }, 300000); // Chạy mỗi 5 phút

server.listen(5000, "0.0.0.0", () => {
    console.log("🚀 Máy chủ đang chạy trên cổng 5000");
});