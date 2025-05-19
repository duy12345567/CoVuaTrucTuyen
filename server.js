const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
});

const rooms = {};
const matchQueue = [];
const REJOIN_TIMEOUT = 60000;
const INITIAL_TIME = 900;

// --- Helper Function to get active room details ---
function getActiveRoomsDetails() {
    const activeRoomsList = [];
    for (const roomId in rooms) {
        const room = rooms[roomId];
        if (room && room.players && room.players.length === 2 && room.game && !room.game.isGameOver() && room.players.every(p => p.status === 'connected')) {
            
            let player1Name = room.players.find(p => p.color === 'white')?.id.substring(0, 5) || 'P1';
            let player2Name = room.players.find(p => p.color === 'black')?.id.substring(0, 5) || 'P2';

            activeRoomsList.push({
                id: roomId,
                name: `Phòng ${roomId.substring(5)} (${player1Name} vs ${player2Name})`,
            });
        }
    }
    return activeRoomsList;
}

// --- Helper Functions for Timer ---
function stopPlayerTimer(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    if (room.timerIntervalId) {
        clearInterval(room.timerIntervalId);
        room.timerIntervalId = null;
    }
    const now = Date.now();
    if (room.turnStartTime && room.turn) {
        const elapsedThisTurn = (now - room.turnStartTime) / 1000;
        const currentPlayer = room.players.find(p => p.id === room.turn);
        if (currentPlayer) {
            if (currentPlayer.color === 'white') {
                room.whiteTime = Math.max(0, room.initialWhiteTime - elapsedThisTurn);
                room.initialWhiteTime = room.whiteTime;
            } else {
                room.blackTime = Math.max(0, room.initialBlackTime - elapsedThisTurn);
                room.initialBlackTime = room.blackTime;
            }
        }
    }
    room.turnStartTime = null;
}

function startPlayerTimer(roomId) {
    const room = rooms[roomId];
    if (!room || room.timerIntervalId || room.game.isGameOver() || !room.turn) {
        return;
    }
    const currentPlayer = room.players.find(p => p.id === room.turn);
    if (!currentPlayer || currentPlayer.status !== 'connected') {
        return;
    }
    const opponent = room.players.find(p => p.id !== room.turn);
    if (!opponent || opponent.status !== 'connected') {
         return;
     }

    room.turnStartTime = Date.now();
    room.timerIntervalId = setInterval(() => {
        const currentRoom = rooms[roomId];
        if (!currentRoom || currentRoom.game.isGameOver() || !currentRoom.turn || currentRoom.timerIntervalId !== room.timerIntervalId) {
            if(currentRoom && currentRoom.timerIntervalId) {
                 clearInterval(currentRoom.timerIntervalId);
                 currentRoom.timerIntervalId = null;
            }
            return;
        }
        const now = Date.now();
        const elapsedThisTurn = (now - currentRoom.turnStartTime) / 1000;
        let timeToUpdate = 0;

        if (currentRoom.turn === currentRoom.players[0].id) { 
            currentRoom.whiteTime = Math.max(0, currentRoom.initialWhiteTime - elapsedThisTurn);
            timeToUpdate = currentRoom.whiteTime;
        } else {
            currentRoom.blackTime = Math.max(0, currentRoom.initialBlackTime - elapsedThisTurn);
            timeToUpdate = currentRoom.blackTime;
        }
        io.to(roomId).emit("timerUpdate", { whiteTime: currentRoom.whiteTime, blackTime: currentRoom.blackTime });
        if (timeToUpdate <= 0) {
            const loserId = currentRoom.turn;
            const winnerId = currentRoom.players.find(p => p.id !== loserId)?.id;
            io.to(roomId).emit("gameOver", { result: "win", winner: winnerId, loser: loserId, reason: "timeout", message: `Người chơi ${winnerId || 'Không xác định'} thắng do ${loserId} hết thời gian!` });
            stopPlayerTimer(roomId);
            io.emit("roomListUpdated", getActiveRoomsDetails()); // Cập nhật khi game kết thúc
        }
    }, 1000);
}


io.on("connection", (socket) => {
    console.log(`🟢 Người chơi đã kết nối: ${socket.id}`);

    // --- Client requests list of active rooms ---
    socket.on("requestActiveRooms", () => {
        console.log(`[${socket.id}] requests active rooms list.`);
        socket.emit("activeRoomsList", getActiveRoomsDetails());
    });

    socket.on("spectateGame", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit("spectateFailed", { reason: "not_found", message: "Phòng không tồn tại." });
            return;
        }
        socket.join(roomId);
        console.log(`👀 Người xem ${socket.id} đã vào phòng ${roomId}`);
        socket.emit("spectateStarted", {
            roomId,
            fen: room.game.fen(),
            history: room.history,
            turn: room.turn,
            // Xác định màu dựa trên người chơi đầu tiên nếu có thể, hoặc mặc định là 'white' cho người xem
            color: room.players[0]?.color || 'white', // Người xem sẽ thấy bàn cờ theo hướng của quân trắng
            whiteTime: room.whiteTime,
            blackTime: room.blackTime,
        });
    });

    socket.on("startMatch", () => {
        console.log(`👤 Người chơi ${socket.id} bắt đầu tìm trận`);
        if (matchQueue.some(player => player.id === socket.id) || Object.values(rooms).some(room => room.players.some(p => p.currentSocketId === socket.id && p.status === 'connected'))) {
             return;
        }
        matchQueue.push(socket);

        if (matchQueue.length >= 2) {
            const player1Socket = matchQueue.shift();
            const player2Socket = matchQueue.shift();
            if (!player1Socket.connected || !player2Socket.connected) {
                 if (player1Socket.connected) matchQueue.unshift(player1Socket);
                 if (player2Socket.connected) matchQueue.unshift(player2Socket);
                 return;
            }

            const roomId = `room_${Date.now()}`;
            const player1 = { id: player1Socket.id, currentSocketId: player1Socket.id, color: 'white', status: 'connected' };
            const player2 = { id: player2Socket.id, currentSocketId: player2Socket.id, color: 'black', status: 'connected' };

            rooms[roomId] = {
                roomId: roomId,
                players: [player1, player2],
                game: new Chess(),
                history: [],
                turn: player1.id,
                whiteTime: INITIAL_TIME, blackTime: INITIAL_TIME,
                initialWhiteTime: INITIAL_TIME, initialBlackTime: INITIAL_TIME,
                turnStartTime: null, timerIntervalId: null,
                rejoinTimeoutId: {}, playerStatus: { [player1.id]: 'connected', [player2.id]: 'connected' },
                disconnectTime: {}
            };

            player1Socket.join(roomId);
            player2Socket.join(roomId);
            console.log(`🎉 Ghép cặp thành công! Phòng ${roomId}: ${player1.id} (Trắng) vs ${player2.id} (Đen)`);

            player1Socket.emit("gameStart", { color: player1.color, turn: rooms[roomId].turn, roomId, playerToken: player1.id, whiteTime: INITIAL_TIME, blackTime: INITIAL_TIME });
            player2Socket.emit("gameStart", { color: player2.color, turn: rooms[roomId].turn, roomId, playerToken: player2.id, whiteTime: INITIAL_TIME, blackTime: INITIAL_TIME });

            startPlayerTimer(roomId);
            io.emit("roomListUpdated", getActiveRoomsDetails()); // Cập nhật khi có phòng mới
        }
    });

    socket.on("cancelMatch", () => {
        console.log(`👤 Người chơi ${socket.id} hủy tìm trận`);
        const index = matchQueue.findIndex(player => player.id === socket.id);
        if (index !== -1) matchQueue.splice(index, 1);
    });

    socket.on("move", ({ roomId, move }) => {
        const room = rooms[roomId];
        if (!room || room.game.isGameOver()) return;
        const player = room.players.find(p => p.currentSocketId === socket.id);
        if (!player || player.id !== room.turn) return;
        const opponent = room.players.find(p => p.id !== player.id);
        if (opponent && opponent.status === 'disconnected') {
             socket.emit("opponentStillDisconnected", { message: "Đối thủ đang tạm thời ngắt kết nối, vui lòng đợi." });
             return;
        }

        stopPlayerTimer(roomId);
        const game = room.game;
        const validMoveResult = game.move(move);

        if (validMoveResult === null) {
            socket.emit("invalidMove", { move, message: "Nước đi không hợp lệ!" });
            startPlayerTimer(roomId); // Restart timer cho người đi sai
            return;
        }

        room.history.push(validMoveResult);
        const fen = game.fen();
        io.to(roomId).emit("opponentMove", { move: validMoveResult, fen });

        let gameOverHandled = false;
        if (game.isCheckmate()) {
             const winnerId = opponent.id;
             const loserId = player.id;
             io.to(roomId).emit("gameOver", { result: "win", winner: winnerId, loser: loserId, reason: "checkmate", message: `Người chơi ${winnerId} thắng do chiếu hết!` });
             gameOverHandled = true;
         } else if (game.isStalemate() || game.isDraw() || game.isInsufficientMaterial()) {
             io.to(roomId).emit("gameOver", { result: "draw", reason: game.isStalemate() ? "stalemate" : game.isInsufficientMaterial() ? "insufficient material" : "draw", message: "Ván cờ hòa!" });
             gameOverHandled = true;
         }

        if (!gameOverHandled) {
            room.turn = opponent.id;
            if(opponent.color === 'white'){ room.initialWhiteTime = room.whiteTime; }
            else { room.initialBlackTime = room.blackTime; }
            io.to(roomId).emit("updateTurn", { turn: room.turn });
            startPlayerTimer(roomId);
        } else {
            stopPlayerTimer(roomId);
            Object.values(room.rejoinTimeoutId).forEach(clearTimeout);
            room.rejoinTimeoutId = {};
            io.emit("roomListUpdated", getActiveRoomsDetails()); // Cập nhật khi game kết thúc
        }
    });

    socket.on("rejoinGame", ({ roomId, playerToken }) => {
        const room = rooms[roomId];
        if (!room) { socket.emit("rejoinFailed", { reason: "room_not_found", message: "Phòng không tồn tại hoặc đã kết thúc." }); return; }
        const player = room.players.find(p => p.id === playerToken);
        if (!player) { socket.emit("rejoinFailed", { reason: "invalid_token", message: "Thông tin người chơi không hợp lệ." }); return; }

        if (player.status !== 'disconnected') {
             if (player.currentSocketId !== socket.id) { player.currentSocketId = socket.id; socket.join(roomId); }
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
             socket.emit("rejoinFailed", { reason: "timeout_expired", message: "Đã hết thời gian chờ để kết nối lại." });
              if (rooms[roomId]) { 
                   const winner = room.players.find(p => p.id !== player.id);
                   io.to(roomId).emit("gameOver", { result: "win", winner: winner?.id, loser: player.id, reason: "abandoned", message: `Người chơi ${winner?.id || 'Không xác định'} thắng do ${player.id} thoát trận!` });
                   stopPlayerTimer(roomId); delete rooms[roomId];
                   io.emit("roomListUpdated", getActiveRoomsDetails()); // Cập nhật khi phòng bị xóa
              }
             return;
         }

        if (room.rejoinTimeoutId[player.id]) { clearTimeout(room.rejoinTimeoutId[player.id]); delete room.rejoinTimeoutId[player.id]; }
        player.status = 'connected'; player.currentSocketId = socket.id; room.playerStatus[player.id] = 'connected'; delete room.disconnectTime[player.id];
        socket.join(roomId);
        const opponent = room.players.find(p => p.id !== player.id);
        socket.emit("gameRejoined", {
            color: player.color, turn: room.turn, roomId, playerToken: player.id,
            fen: room.game.fen(), history: room.history,
            whiteTime: room.whiteTime, blackTime: room.blackTime,
            opponentStatus: opponent?.status ?? 'unknown'
        });
        if (opponent && opponent.status === 'connected') {
            io.to(opponent.currentSocketId).emit("playerReconnected", { reconnectedPlayerId: player.id });
            startPlayerTimer(roomId); // Khởi động lại timer nếu cả 2 đã kết nối
        }
         io.emit("roomListUpdated", getActiveRoomsDetails()); // Cập nhật danh sách phòng khi có người rejoin
    });

    socket.on("disconnect", (reason) => {
        console.log(`🔴 Người chơi ngắt kết nối: ${socket.id}. Lý do: ${reason}`);
        const queueIndex = matchQueue.findIndex(player => player.id === socket.id);
        if (queueIndex !== -1) matchQueue.splice(queueIndex, 1);

        let roomIdFound = null; let playerInfo = null;
        for (const id in rooms) {
             const room = rooms[id];
             const playerIndex = room.players.findIndex(p => p.currentSocketId === socket.id);
              if (playerIndex !== -1) { roomIdFound = id; playerInfo = room.players[playerIndex]; break; }
         }

        if (roomIdFound && playerInfo) {
            const room = rooms[roomIdFound];
            let roomListNeedsUpdate = false;

            if (!room.game.isGameOver() && playerInfo.status === 'connected') {
                 playerInfo.status = 'disconnected'; room.playerStatus[playerInfo.id] = 'disconnected'; room.disconnectTime[playerInfo.id] = Date.now();
                 stopPlayerTimer(roomIdFound);
                 roomListNeedsUpdate = true; 

                 const opponent = room.players.find(p => p.id !== playerInfo.id);
                 if (opponent && opponent.status === 'connected') {
                    io.to(opponent.currentSocketId).emit("opponentDisconnected", { disconnectedPlayerId: playerInfo.id });
                 }

                 if (!room.rejoinTimeoutId[playerInfo.id]) {
                      room.rejoinTimeoutId[playerInfo.id] = setTimeout(() => {
                            const currentRoom = rooms[roomIdFound]; if (!currentRoom) return;
                             if (currentRoom.playerStatus[playerInfo.id] === 'disconnected') {
                                 const winner = currentRoom.players.find(p => p.id !== playerInfo.id);
                                 io.to(roomIdFound).emit("gameOver", { result: "win", winner: winner?.id, loser: playerInfo.id, reason: "abandoned", message: `Người chơi ${winner?.id || 'Không xác định'} thắng do ${playerInfo.id} thoát trận!` });
                                 stopPlayerTimer(roomIdFound); delete currentRoom.rejoinTimeoutId[playerInfo.id]; delete rooms[roomIdFound];
                                 io.emit("roomListUpdated", getActiveRoomsDetails()); // Cập nhật khi phòng bị xóa
                             } else { delete currentRoom.rejoinTimeoutId[playerInfo.id]; }
                       }, REJOIN_TIMEOUT);
                  }
            } else if (playerInfo.status === 'connected') {
                 playerInfo.status = 'disconnected'; room.playerStatus[playerInfo.id] = 'disconnected'; room.disconnectTime[playerInfo.id] = Date.now();
                 roomListNeedsUpdate = true;
            }

            const allPlayersInRoomDisconnected = room.players.every(p => p.status === 'disconnected');
            if (allPlayersInRoomDisconnected) {
                roomListNeedsUpdate = true;
            }

            if(roomListNeedsUpdate){
                io.emit("roomListUpdated", getActiveRoomsDetails());
            }

        }
    });

    socket.on("sendMessage", ({ roomId, message }) => {
         const room = rooms[roomId]; if (!room) return; const senderPlayer = room.players.find(p => p.currentSocketId === socket.id); if (!senderPlayer) return;
          const opponent = room.players.find(p => p.id !== senderPlayer.id);
          if (opponent && opponent.status === 'connected') { io.to(opponent.currentSocketId).emit("receiveMessage", { sender: senderPlayer.id, message: message.message }); }
    });
});

setInterval(() => {
     const now = Date.now();
     let updated = false;
     for (let roomId in rooms) {
         const room = rooms[roomId];
         let shouldDelete = false;
         const allPlayersReallyDisconnected = room.players.every(p => room.playerStatus[p.id] === 'disconnected');

         if (room.game.isGameOver()) {
             if (allPlayersReallyDisconnected) {
                 const lastDisconnectTime = Math.max(0, ...Object.values(room.disconnectTime).filter(t => t != null));
                 if (now - (lastDisconnectTime || room.game.startTime || 0) > 120000) { // 2 phút
                     console.log(`[${roomId}] Dọn phòng cũ (game over, all disconnected > 2 mins).`);
                     shouldDelete = true;
                 }
             } else if (room.players.length === 0) { 
                shouldDelete = true;
             }
         } else { 
            if (allPlayersReallyDisconnected) {
                const creationOrLastActivityTime = room.turnStartTime || parseInt(roomId.split('_')[1]) || 0;
                if (now - creationOrLastActivityTime > 600000) { 
                     console.log(`[${roomId}] Dọn phòng kẹt (ko game over, all disconnected > 10 mins inactivity).`);
                     shouldDelete = true;
                }
            }
         }

         if (shouldDelete) {
             stopPlayerTimer(roomId);
             Object.values(room.rejoinTimeoutId || {}).forEach(clearTimeout);
             delete rooms[roomId];
             updated = true;
         }
     }
      if(updated) {
          console.log(`Cleanup task finished. Some rooms might have been deleted.`);
          io.emit("roomListUpdated", getActiveRoomsDetails());
      }
 }, 120000); // Chạy mỗi 2 phút

server.listen(5000, "0.0.0.0", () => {
    console.log("🚀 Máy chủ đang chạy trên cổng 5000");
});