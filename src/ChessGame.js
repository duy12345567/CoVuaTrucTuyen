import React, { useState, useEffect, useRef, useCallback } from "react";
import { Chessboard } from "react-chessboard";
import { Chess } from "chess.js"; // Thư viện logic cờ vua

// Component chính cho màn hình chơi game
const ChessGame = ({
    socket,             // instance Socket.IO
    initialColor,       // Màu quân của người chơi ('white'/'black')
    initialTurn,        // ID người chơi có lượt đi ban đầu
    initialRoomId,      // ID của phòng chơi
    initialPlayerToken, // ID gốc của người chơi (dùng làm định danh)
    initialFen,         // Trạng thái bàn cờ ban đầu (FEN string)
    initialWhiteTime,   // Thời gian ban đầu của Trắng
    initialBlackTime,   // Thời gian ban đầu của Đen
    setGameActive       // Hàm callback để báo cho App.js biết game không còn active (để quay về màn hình chính)
}) => {
    // --- State ---
    const [game, setGame] = useState(new Chess(initialFen || undefined)); // Trạng thái logic cờ vua
    const [boardOrientation, setBoardOrientation] = useState(initialColor || 'white'); // Hướng bàn cờ
    const [currentTurn, setCurrentTurn] = useState(initialTurn);      // ID người chơi có lượt
    const [roomId, setRoomId] = useState(initialRoomId);            // ID phòng
    const [playerToken, setPlayerToken] = useState(initialPlayerToken); // ID định danh

    const [highlightSquares, setHighlightSquares] = useState({}); // Các ô được highlight (nước đi hợp lệ)
    const [selectedSquare, setSelectedSquare] = useState(null); // Ô đang được chọn
    const [history, setHistory] = useState([]);                   // Lịch sử nước đi (nên nhận từ server khi rejoin)
    const [gameOver, setGameOver] = useState(null);               // Thông tin kết thúc game { result, message, reason, winner?, loser? }

    const [opponentDisconnected, setOpponentDisconnected] = useState(false); // Trạng thái disconnect của đối thủ
    const [opponentInfo, setOpponentInfo] = useState({ id: null, status: 'unknown' }); // Thông tin cơ bản đối thủ

    // Chat state
    const [message, setMessage] = useState("");
    const [chatMessages, setChatMessages] = useState([]);

    // Timer state
    const [whiteTime, setWhiteTime] = useState(initialWhiteTime ?? 900);
    const [blackTime, setBlackTime] = useState(initialBlackTime ?? 900);


    // --- Refs ---
    const socketIdRef = useRef(socket?.id); // Lưu socket id hiện tại để so sánh turn (ít dùng hơn playerToken)
    const chatScrollRef = useRef(null); // Ref để cuộn chat xuống dưới

    // Cập nhật socket ID ref khi socket thay đổi (khi reconnect)
    useEffect(() => { socketIdRef.current = socket?.id; }, [socket?.id]);

    // --- Game Logic Callbacks ---

    // Hàm an toàn để cập nhật trạng thái game (tránh mutate trực tiếp)
    const safeGameMutate = useCallback((modify) => {
        setGame((g) => {
            const update = new Chess(g.fen() || undefined); // Tạo instance mới từ FEN hiện tại
            modify(update); // Thực hiện thay đổi trên instance mới
            return update; // Trả về instance đã cập nhật
        });
    }, []);

    // Xử lý khi kéo thả quân cờ (hoặc click-click)
    const onPieceDrop = (sourceSquare, targetSquare, piece) => {
        const isMyTurnNow = currentTurn === playerToken;
        // Điều kiện không cho phép di chuyển
        if (!isMyTurnNow || gameOver || opponentDisconnected) {
            console.log(`⛔ Không thể di chuyển: ${gameOver ? "Ván cờ đã kết thúc" : opponentDisconnected ? "Đợi đối thủ kết nối lại" : "Không phải lượt của bạn"}`);
            return false; // Không cho phép thả quân
        }

        // Xác định có phải là phong cấp không
        const promotion = piece.toLowerCase().endsWith('p') && ((piece.startsWith('w') && targetSquare[1] === '8') || (piece.startsWith('b') && targetSquare[1] === '1')) ? 'q' : undefined; // Mặc định phong Hậu

        const moveConfig = {
            from: sourceSquare,
            to: targetSquare,
            ...(promotion && { promotion }), // Chỉ thêm key 'promotion' nếu có giá trị
        };

        // Kiểm tra sơ bộ ở client xem nước đi có vẻ hợp lệ không
        const tempGame = new Chess(game.fen());
        const possibleMove = tempGame.move(moveConfig);

        if (possibleMove === null) {
            console.log("❌ Nước đi không hợp lệ (client check)");
             setHighlightSquares({}); // Bỏ highlight nếu đi sai
             setSelectedSquare(null);
            return false; // Nước đi không hợp lệ
        }

        // Gửi nước đi lên server để xác thực và xử lý
        console.log(`[${roomId}] 🎯 Gửi nước đi:`, moveConfig);
        socket.emit("move", { roomId, move: moveConfig });

        setHighlightSquares({}); // Xóa highlight sau khi gửi đi
        setSelectedSquare(null); // Bỏ chọn ô

        return true; // Báo cho react-chessboard là nước đi đã được "xử lý" (gửi đi)
    };

    // Xử lý khi click vào một ô
     const onSquareClick = (square) => {
         // Clear highlight cũ
         setHighlightSquares({});

         // Nếu hết game hoặc đối thủ disconnect thì không làm gì
          if (gameOver || opponentDisconnected) return;

          // Nếu không phải lượt mình
          if (currentTurn !== playerToken) {
               setSelectedSquare(null); // Bỏ chọn ô nếu có
               return;
           }

         const pieceOnSquare = game.get(square);

          // Click vào ô trống hoặc ô quân địch khi chưa chọn quân mình -> không làm gì HOẶC bỏ chọn ô cũ
          if (!selectedSquare && (!pieceOnSquare || pieceOnSquare.color !== boardOrientation[0])) {
              setSelectedSquare(null);
              return;
          }

          // Click vào ô quân mình -> chọn ô đó và highlight nước đi
          if (pieceOnSquare && pieceOnSquare.color === boardOrientation[0]) {
              setSelectedSquare(square);
              highlightPossibleMoves(square);
              return;
          }

          // Đã chọn 1 ô quân mình (selectedSquare), giờ click vào ô khác (targetSquare)
          if (selectedSquare) {
               // Thử thực hiện nước đi từ selectedSquare đến square (ô vừa click)
               const success = onPieceDrop(selectedSquare, square, game.get(selectedSquare).type);
               // Nếu đi thành công hoặc không thành công, bỏ chọn ô ban đầu
                setSelectedSquare(null);
                // Highlight sẽ tự xóa trong onPieceDrop hoặc ở đầu hàm này
                return;
           }
     };

     // Hàm helper để highlight các nước đi có thể
     const highlightPossibleMoves = (sourceSq) => {
         const moves = game.moves({ square: sourceSq, verbose: true });
         if (moves.length === 0) return; // Không có nước đi nào

         const highlights = {};
         highlights[sourceSq] = { background: "rgba(255, 255, 0, 0.4)" }; // Ô đang chọn
         moves.forEach((move) => {
             highlights[move.to] = {
                 background: game.get(move.to) ? // Ô đích có quân (ăn quân)
                     "radial-gradient(circle, rgba(211, 54, 130, 0.5) 85%, transparent 85%)" // Vòng tròn đỏ đậm viền mờ
                     : "radial-gradient(circle, rgba(0, 0, 0, 0.15) 25%, transparent 25%)", // Chấm tròn xám
                 borderRadius: "50%",
             };
         });
         setHighlightSquares(highlights);
     };


    // --- Socket Event Listeners Effect ---
    useEffect(() => {
        console.log("Setting up ChessGame listeners. Socket connected:", socket?.connected);

        // Hàm xử lý khi nhận nước đi từ đối thủ (hoặc xác nhận nước đi của mình)
        const handleOpponentMove = ({ move, fen }) => {
            console.log(`♟️ [${roomId}] Nhận move/fen update. Move: ${move?.san || JSON.stringify(move)}, FEN: ${fen}`);
             if (!fen) { console.error("Received opponent move without FEN!"); return;}
             // Cập nhật trạng thái game chỉ khi FEN thay đổi
             setGame(prevGame => {
                  const currentFen = prevGame.fen();
                  if (currentFen !== fen) {
                      console.log("Updating board state from FEN.");
                      return new Chess(fen); // Cập nhật bàn cờ từ FEN mới
                  }
                   console.log("FEN unchanged, skipping board update.");
                   return prevGame;
              });
              // Chỉ thêm nước đi vào lịch sử nếu có thông tin nước đi hợp lệ
             if (move) {
                  setHistory((prev) => [...prev, move]);
             }
        };

        // Cập nhật lượt đi
        const handleUpdateTurn = ({ turn }) => {
             console.log(`[${roomId}] 🔄 Cập nhật lượt: ${turn}`);
            setCurrentTurn(turn);
        };

        // Xử lý kết thúc game
        const handleGameOver = (data) => { // data = { result, message, reason, winner?, loser? }
            console.log(`[${roomId}] 🎉 Game Over: ${data.message} (Reason: ${data.reason})`);
            setGameOver(data);
            setCurrentTurn(null); // Không còn lượt đi nữa
        };

        // Cập nhật thời gian
        const handleTimerUpdate = ({ whiteTime, blackTime }) => {
            setWhiteTime(Math.max(0, whiteTime));
            setBlackTime(Math.max(0, blackTime));
        };

        // Nhận tin nhắn chat
        const handleReceiveMessage = ({ sender, message }) => {
            setChatMessages((prev) => [
                ...prev,
                { sender, message, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
            ]);
            // Tự động cuộn xuống cuối
             if (chatScrollRef.current) {
                chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
            }
        };

        // Xử lý khi đối thủ bị ngắt kết nối tạm thời
        const handleOpponentDisconnected = ({ disconnectedPlayerId }) => {
            console.warn(`[${roomId}] 🔌 Đối thủ ${disconnectedPlayerId} disconnected. Waiting...`);
            setOpponentDisconnected(true);
            setOpponentInfo({ id: disconnectedPlayerId, status: 'disconnected' });
        };

        // Xử lý khi đối thủ kết nối lại
        const handlePlayerReconnected = ({ reconnectedPlayerId }) => {
            // Chỉ xử lý nếu đó là đối thủ
            if (reconnectedPlayerId !== playerToken) {
                 console.log(`[${roomId}] 💡 Đối thủ ${reconnectedPlayerId} reconnected.`);
                 setOpponentDisconnected(false);
                 setOpponentInfo({ id: reconnectedPlayerId, status: 'connected' });
             }
        };

        // Xử lý khi server báo nước đi không hợp lệ (dù client đã check)
          const handleInvalidMove = ({ message }) => {
               console.warn(`[${roomId}] 🚫 Server rejected move: ${message}`);
           };

        // Xử lý khi cố đi trong lúc đối thủ disconnect
            const handleOpponentStillDisconnected = ({ message }) => {
                 alert(message); // Hiển thị thông báo từ server
             };

        // --- Đăng ký Listeners ---
        if (socket) {
             console.log("Attaching ChessGame listeners...");
             socket.on("opponentMove", handleOpponentMove);
             socket.on("updateTurn", handleUpdateTurn);
             socket.on("gameOver", handleGameOver);
             socket.on("timerUpdate", handleTimerUpdate);
             socket.on("receiveMessage", handleReceiveMessage);
             socket.on("opponentDisconnected", handleOpponentDisconnected);
             socket.on("playerReconnected", handlePlayerReconnected);
             socket.on("invalidMove", handleInvalidMove);
             socket.on("opponentStillDisconnected", handleOpponentStillDisconnected);

         } else {
              console.error("Socket instance is not available in ChessGame useEffect.");
         }

        // --- Cleanup Function ---
        return () => {
             if (socket) {
                 console.log("🧹 Cleaning up ChessGame listeners...");
                 socket.off("opponentMove", handleOpponentMove);
                 socket.off("updateTurn", handleUpdateTurn);
                 socket.off("gameOver", handleGameOver);
                 socket.off("timerUpdate", handleTimerUpdate);
                 socket.off("receiveMessage", handleReceiveMessage);
                 socket.off("opponentDisconnected", handleOpponentDisconnected);
                 socket.off("playerReconnected", handlePlayerReconnected);
                  socket.off("invalidMove", handleInvalidMove);
                 socket.off("opponentStillDisconnected", handleOpponentStillDisconnected);
             }
        };
    // }, [socket, playerToken, roomId, setGameActive]); // Chỉ các dependency ổn định
     }, [socket, playerToken, roomId, setGameActive, safeGameMutate, gameOver]); // Dependency update


    // --- Timer Display Logic ---
    const formatTime = (seconds) => {
        if (seconds === null || seconds === undefined || isNaN(seconds)) return "0:00";
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = Math.floor(seconds % 60);
        return `${minutes}:${remainingSeconds < 10 ? "0" : ""}${remainingSeconds}`;
    };

    // --- Chat Logic ---
    const sendMessage = (e) => {
        e.preventDefault();
        if (message.trim() && !gameOver && socket) {
            const msgData = { sender: playerToken, message: message.trim() };
            // Hiển thị ngay
            setChatMessages((prev) => [...prev, { ...msgData, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }]);
             if (chatScrollRef.current) { chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight; } // Cuộn xuống
            socket.emit("sendMessage", { roomId, message: msgData });
            setMessage("");
        }
    };

      // --- Leave Game ---
      const leaveGame = () => {
           if (window.confirm("Bạn có chắc muốn rời khỏi ván đấu?\n(Nếu game đang diễn ra, bạn sẽ bị xử thua)")) {
               console.log(`🚪 Người chơi ${playerToken} chủ động rời phòng ${roomId}`);
               if(socket) socket.disconnect(); // Ngắt kết nối để server xử lý disconnect
               setGameActive(false); // Báo cho App.js quay lại màn hình chính
               localStorage.removeItem("chessGameRoomId"); // Xóa thông tin phòng
               localStorage.removeItem("chessPlayerToken");
           }
       };

    // --- UI Rendering ---
    const isMyTurn = currentTurn === playerToken && !gameOver && !opponentDisconnected;

    return (
        // Layout chính: Bàn cờ + Thông tin bên trái, Chat bên phải
        // <div style={{ display: "flex", justifyContent: "center", gap: "20px", padding: "10px", flexWrap: "wrap" }}>
        <div style={{ display: "flex", justifyContent: "center", gap: "20px", padding: "10px", alignItems: "flex-start", flexWrap: "nowrap" }}>
            {/* Cột trái: Thông tin game và bàn cờ */}
            <div style={{ maxWidth: "580px", width: '100%' }}>
                {/* --- Thông báo trạng thái --- */}
                {gameOver && (
                    <div style={statusBoxStyle(gameOver.result === "draw" ? "gray" : (gameOver.winner === playerToken ? "success" : "danger"))}>
                        <h4>{gameOver.message}</h4>
                        {gameOver.reason && <small>(Lý do: {gameOver.reason})</small>}
                    </div>
                )}
                {opponentDisconnected && !gameOver && (
                     <div style={statusBoxStyle("warning")}>
                        <p>🔌 Đối thủ đã tạm thời ngắt kết nối. Đang chờ kết nối lại (tối đa khoảng 60s)...</p>                     </div>
                 )}
                 
                {/* --- Thông tin đối thủ --- */}
                 <div style={playerInfoBoxStyle(currentTurn !== playerToken && !gameOver)}>
                     <span>Đối thủ ({boardOrientation === 'white' ? 'Đen' : 'Trắng'}) {opponentInfo.status === 'disconnected' ? '(Disconnected)' : ''}</span>
                     <span style={{ fontSize: "20px", fontWeight: 'bold' }}>
                          {formatTime(boardOrientation === 'white' ? blackTime : whiteTime)}
                     </span>
                 </div>

                 {/* --- Bàn cờ --- */}
                 <div style={{ position: 'relative', width: 'fit-content', margin: '5px auto' }} >
                    <Chessboard
                        boardWidth={Math.min(560, window.innerWidth > 900 ? 560 : window.innerWidth - 40)} // Responsive
                        position={game.fen()}
                        onPieceDrop={onPieceDrop}
                        onSquareClick={onSquareClick}
                        customSquareStyles={highlightSquares}
                        boardOrientation={boardOrientation}
                        arePiecesDraggable={isMyTurn}
                        animationDuration={200}
                        showPromotionDialog={true} // Cho phép chọn quân phong cấp (react-chessboard tự xử lý)
                    />
                    {/* Lớp phủ khi không phải lượt hoặc có vấn đề */}
                    {(!isMyTurn || gameOver || opponentDisconnected) && (
                        <div style={boardOverlayStyle}>
                            {gameOver ? "Ván đấu đã kết thúc" : opponentDisconnected ? "Đang chờ đối thủ..." : "Đến lượt đối thủ"}
                        </div>
                    )}
                </div>

                 {/* --- Thông tin bản thân --- */}
                 <div style={playerInfoBoxStyle(currentTurn === playerToken && !gameOver)}>
                     <span>Bạn ({boardOrientation === 'white' ? 'Trắng' : 'Đen'})</span>
                     <span style={{ fontSize: "20px", fontWeight: 'bold' }}>
                          {formatTime(boardOrientation === 'white' ? whiteTime : blackTime)}
                      </span>
                 </div>

                 {/* --- Nút chức năng --- */}
                 <div style={{ marginTop: '15px', display: 'flex', justifyContent: 'center', gap: '10px', flexWrap: 'wrap' }}>
                     
                     {/* <button onClick={offerDraw} style={buttonStyle("#6c757d", "white")}>🤝 Cầu hòa</button> */}
                      <button onClick={leaveGame} style={buttonStyle("#dc3545", "white")}>🚪 Rời trận</button>
                 </div>

            </div>

            {/* Cột phải: Chat */}
             <div style={{ width: "300px", minWidth: "250px", border: "1px solid #ccc", borderRadius:"5px", padding: "10px", display: "flex", flexDirection: "column", height: 'calc(100vh - 60px)', maxHeight: '650px', backgroundColor: '#f8f9fa' }}>
                <h4 style={{marginTop: 0, marginBottom: '10px', textAlign:'center'}}>Chat</h4>
                {/* Khu vực hiển thị tin nhắn */}
                <div ref={chatScrollRef} style={{ flexGrow: 1, overflowY: "auto", border: "1px solid #ddd", marginBottom: "10px", padding: "8px", backgroundColor: "#fff", borderRadius:'3px' }}>
                    {chatMessages.map((msg, index) => (
                        <div key={index} style={{ marginBottom: "8px", display: 'flex', justifyContent: msg.sender === playerToken ? "flex-end" : "flex-start" }}>
                            <div style={{
                                backgroundColor: msg.sender === playerToken ? "#007bff" : "#e9ecef",
                                color: msg.sender === playerToken ? "white" : "#212529",
                                padding: "6px 12px",
                                borderRadius: msg.sender === playerToken ? "15px 15px 0 15px" : "15px 15px 15px 0",
                                maxWidth: '85%',
                                wordWrap: 'break-word',
                                fontSize: '14px',
                                boxShadow: '0 1px 1px rgba(0,0,0,0.05)'
                            }}>
                                {msg.message}
                                <div style={{ fontSize: '10px', opacity: 0.7, marginTop: '3px', textAlign: msg.sender === playerToken ? 'right': 'left' }}>{msg.time}</div>
                            </div>
                        </div>
                    ))}
                </div>
                {/* Form nhập tin nhắn */}
                <form onSubmit={sendMessage} style={{ display: "flex", gap: "5px" }}>
                    <input
                        type="text"
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        placeholder="Nhập tin nhắn..."
                        style={{ flexGrow: 1, padding: "8px", borderRadius: "5px", border: "1px solid #ccc" }}
                        disabled={gameOver} 
                    />
                    <button type="submit" style={buttonStyle("#007bff", "white")} disabled={gameOver}>Gửi</button>
                </form>
            </div>
        </div>
    );
};

// --- Helper Styles ---
const buttonStyle = (bgColor, textColor, marginRight = '0') => ({
    padding: '8px 15px', fontSize: '14px', cursor: 'pointer', backgroundColor: bgColor,
    color: textColor, border: 'none', borderRadius: '5px', marginRight: marginRight,
    opacity: 1, transition: 'opacity 0.2s ease', ':disabled': { opacity: 0.6, cursor: 'not-allowed' } // CSS-in-JS cơ bản
});

const statusBoxStyle = (type = "info") => {
    const colors = {
        info: { bg: "#d1ecf1", text: "#0c5460", border: "#bee5eb" },
        success: { bg: "#d4edda", text: "#155724", border: "#c3e6cb" },
        warning: { bg: "#fff3cd", text: "#856404", border: "#ffeeba" },
        danger: { bg: "#f8d7da", text: "#721c24", border: "#f5c6cb" },
        gray: { bg: "#eee", text: "#333", border: "#ccc"}
    };
    const style = colors[type] || colors.info;
    return {
        marginBottom: "10px", padding: "10px 15px", borderRadius: "5px",
        backgroundColor: style.bg, color: style.text, border: `1px solid ${style.border}`,
        textAlign: 'center'
    };
};

const playerInfoBoxStyle = (isTurn) => ({
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '8px 12px', border: `1px solid ${isTurn ? '#007bff' : '#ccc'}`, borderRadius: '5px',
    backgroundColor: isTurn ? '#e7f1ff' : '#f8f9fa', transition: 'all 0.3s ease'
});

const boardOverlayStyle = {
    position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
    backgroundColor: 'rgba(128, 128, 128, 0.15)', zIndex: 10, cursor: 'not-allowed',
    display: 'flex', justifyContent: 'center', alignItems: 'center',
    color: '#333', fontWeight: 'bold', fontSize: '16px', textAlign: 'center', borderRadius:'3px'
};

export default ChessGame;