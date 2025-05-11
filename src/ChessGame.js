import React, { useState, useEffect, useRef, useCallback } from "react";
import { Chessboard } from "react-chessboard";
import { Chess } from "chess.js";

const ChessGame = ({
    socket,
    initialColor,
    initialTurn,
    initialRoomId,
    initialPlayerToken,
    initialFen,
    initialWhiteTime,
    initialBlackTime,
    isSpectator = false,
    setGameActive
}) => {
    const [game, setGame] = useState(new Chess(initialFen || undefined));
    const [boardOrientation, setBoardOrientation] = useState(initialColor || 'white');
    const [currentTurn, setCurrentTurn] = useState(initialTurn);
    const [roomId, setRoomId] = useState(initialRoomId);
    const [playerToken, setPlayerToken] = useState(initialPlayerToken);

    const [highlightSquares, setHighlightSquares] = useState({});
    const [selectedSquare, setSelectedSquare] = useState(null);
    const [history, setHistory] = useState([]);
    const [gameOver, setGameOver] = useState(null);

    const [opponentDisconnected, setOpponentDisconnected] = useState(false);
    const [opponentInfo, setOpponentInfo] = useState({ id: null, status: 'unknown' });

    const [message, setMessage] = useState("");
    const [chatMessages, setChatMessages] = useState([]);

    const [whiteTime, setWhiteTime] = useState(initialWhiteTime ?? 900);
    const [blackTime, setBlackTime] = useState(initialBlackTime ?? 900);

    const socketIdRef = useRef(socket?.id);
    const chatScrollRef = useRef(null);
    useEffect(() => { socketIdRef.current = socket?.id; }, [socket?.id]);

    const safeGameMutate = useCallback((modify) => {
        setGame((g) => {
            const update = new Chess(g.fen() || undefined);
            modify(update);
            return update;
        });
    }, []);

    const onPieceDrop = (sourceSquare, targetSquare, piece) => {
        if (isSpectator) return false;

        const isMyTurnNow = currentTurn === playerToken;
        if (!isMyTurnNow || gameOver || opponentDisconnected) return false;

        const promotion = piece.toLowerCase().endsWith('p') && ((piece.startsWith('w') && targetSquare[1] === '8') || (piece.startsWith('b') && targetSquare[1] === '1')) ? 'q' : undefined;

        const moveConfig = { from: sourceSquare, to: targetSquare, ...(promotion && { promotion }) };

        const tempGame = new Chess(game.fen());
        const possibleMove = tempGame.move(moveConfig);

        if (possibleMove === null) {
            setHighlightSquares({});
            setSelectedSquare(null);
            return false;
        }

        socket.emit("move", { roomId, move: moveConfig });
        setHighlightSquares({});
        setSelectedSquare(null);
        return true;
    };

    const onSquareClick = (square) => {
        if (isSpectator) return;

        setHighlightSquares({});
        if (gameOver || opponentDisconnected || currentTurn !== playerToken) {
            setSelectedSquare(null);
            return;
        }

        const pieceOnSquare = game.get(square);
        if (!selectedSquare && (!pieceOnSquare || pieceOnSquare.color !== boardOrientation[0])) {
            setSelectedSquare(null);
            return;
        }

        if (pieceOnSquare && pieceOnSquare.color === boardOrientation[0]) {
            setSelectedSquare(square);
            highlightPossibleMoves(square);
            return;
        }

        if (selectedSquare) {
            const success = onPieceDrop(selectedSquare, square, game.get(selectedSquare).type);
            setSelectedSquare(null);
        }
    };

    const highlightPossibleMoves = (sourceSq) => {
        const moves = game.moves({ square: sourceSq, verbose: true });
        if (moves.length === 0) return;

        const highlights = {};
        highlights[sourceSq] = { background: "rgba(255, 255, 0, 0.4)" };
        moves.forEach((move) => {
            highlights[move.to] = {
                background: game.get(move.to)
                    ? "radial-gradient(circle, rgba(211, 54, 130, 0.5) 85%, transparent 85%)"
                    : "radial-gradient(circle, rgba(0, 0, 0, 0.15) 25%, transparent 25%)",
                borderRadius: "50%",
            };
        });
        setHighlightSquares(highlights);
    };

    useEffect(() => {
        const handleOpponentMove = ({ move, fen }) => {
            if (!fen) return;
            setGame(prevGame => {
                const currentFen = prevGame.fen();
                return currentFen !== fen ? new Chess(fen) : prevGame;
            });
            if (move) setHistory(prev => [...prev, move]);
        };

        const handleUpdateTurn = ({ turn }) => setCurrentTurn(turn);
        const handleGameOver = (data) => { setGameOver(data); setCurrentTurn(null); };
        const handleTimerUpdate = ({ whiteTime, blackTime }) => {
            setWhiteTime(Math.max(0, whiteTime));
            setBlackTime(Math.max(0, blackTime));
        };

        const handleReceiveMessage = ({ sender, message }) => {
            setChatMessages(prev => [...prev, { sender, message, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }]);
            if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
        };

        const handleOpponentDisconnected = ({ disconnectedPlayerId }) => {
            setOpponentDisconnected(true);
            setOpponentInfo({ id: disconnectedPlayerId, status: 'disconnected' });
        };

        const handlePlayerReconnected = ({ reconnectedPlayerId }) => {
            if (reconnectedPlayerId !== playerToken) {
                setOpponentDisconnected(false);
                setOpponentInfo({ id: reconnectedPlayerId, status: 'connected' });
            }
        };

        socket.on("opponentMove", handleOpponentMove);
        socket.on("updateTurn", handleUpdateTurn);
        socket.on("gameOver", handleGameOver);
        socket.on("timerUpdate", handleTimerUpdate);
        socket.on("receiveMessage", handleReceiveMessage);
        socket.on("opponentDisconnected", handleOpponentDisconnected);
        socket.on("playerReconnected", handlePlayerReconnected);

        return () => {
            socket.off("opponentMove", handleOpponentMove);
            socket.off("updateTurn", handleUpdateTurn);
            socket.off("gameOver", handleGameOver);
            socket.off("timerUpdate", handleTimerUpdate);
            socket.off("receiveMessage", handleReceiveMessage);
            socket.off("opponentDisconnected", handleOpponentDisconnected);
            socket.off("playerReconnected", handlePlayerReconnected);
        };
    }, [socket, playerToken, roomId]);

    const formatTime = (seconds) => {
        if (seconds == null || isNaN(seconds)) return "0:00";
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = Math.floor(seconds % 60);
        return `${minutes}:${remainingSeconds < 10 ? "0" : ""}${remainingSeconds}`;
    };

    const sendMessage = (e) => {
        e.preventDefault();
        if (message.trim() && !gameOver && socket) {
            const msgData = { sender: playerToken, message: message.trim() };
            setChatMessages(prev => [...prev, { ...msgData, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }]);
            if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
            socket.emit("sendMessage", { roomId, message: msgData });
            setMessage("");
        }
    };

    const leaveGame = () => {
        if (window.confirm("Bạn có chắc muốn rời khỏi ván đấu?")) {
            if (socket) socket.disconnect();
            setGameActive(false);
            localStorage.removeItem("chessGameRoomId");
            localStorage.removeItem("chessPlayerToken");
        }
    };

    const isMyTurn = currentTurn === playerToken && !gameOver && !opponentDisconnected;

    return (
        <div style={{ display: "flex", justifyContent: "center", gap: "20px", padding: "10px", alignItems: "flex-start" }}>
            <div style={{ maxWidth: "580px", width: '100%' }}>
                {gameOver && <div style={statusBoxStyle(gameOver.result === "draw" ? "gray" : (gameOver.winner === playerToken ? "success" : "danger"))}>
                    <h4>{gameOver.message}</h4>
                    {gameOver.reason && <small>(Lý do: {gameOver.reason})</small>}
                </div>}
                {opponentDisconnected && !gameOver && <div style={statusBoxStyle("warning")}>
                    <p>🔌 Đối thủ đã tạm thời ngắt kết nối. Đang chờ kết nối lại...</p>
                </div>}

                <div style={playerInfoBoxStyle(currentTurn !== playerToken && !gameOver)}>
                    <span>Đối thủ</span>
                    <span style={{ fontSize: "20px", fontWeight: 'bold' }}>{formatTime(boardOrientation === 'white' ? blackTime : whiteTime)}</span>
                </div>

                <div style={{ position: 'relative', width: 'fit-content', margin: '5px auto' }}>
                    <Chessboard
                        boardWidth={Math.min(560, window.innerWidth > 900 ? 560 : window.innerWidth - 40)}
                        position={game.fen()}
                        onPieceDrop={onPieceDrop}
                        onSquareClick={onSquareClick}
                        customSquareStyles={highlightSquares}
                        boardOrientation={boardOrientation}
                        arePiecesDraggable={!isSpectator && isMyTurn}
                        animationDuration={200}
                        showPromotionDialog={true}
                    />
                    {(!isMyTurn || gameOver || opponentDisconnected || isSpectator) && (
                        <div style={boardOverlayStyle}>
                            {gameOver ? "Ván đấu đã kết thúc" : opponentDisconnected ? "Đang chờ đối thủ..." : isSpectator ? "Bạn đang xem trận đấu" : "Đến lượt đối thủ"}
                        </div>
                    )}
                </div>

                <div style={playerInfoBoxStyle(currentTurn === playerToken && !gameOver)}>
                    <span>Bạn</span>
                    <span style={{ fontSize: "20px", fontWeight: 'bold' }}>{formatTime(boardOrientation === 'white' ? whiteTime : blackTime)}</span>
                </div>

                {!isSpectator && <div style={{ marginTop: '15px', display: 'flex', justifyContent: 'center' }}>
                    <button onClick={leaveGame} style={buttonStyle("#dc3545", "white")}>🚪 Rời trận</button>
                </div>}
            </div>

            {!isSpectator && <div style={{ width: "300px", minWidth: "250px", border: "1px solid #ccc", borderRadius: "5px", padding: "10px", display: "flex", flexDirection: "column", height: 'calc(100vh - 60px)', maxHeight: '650px', backgroundColor: '#f8f9fa' }}>
                <h4 style={{ marginTop: 0, marginBottom: '10px', textAlign: 'center' }}>Chat</h4>
                <div ref={chatScrollRef} style={{ flexGrow: 1, overflowY: "auto", border: "1px solid #ddd", marginBottom: "10px", padding: "8px", backgroundColor: "#fff", borderRadius: '3px' }}>
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
                                <div style={{ fontSize: '10px', opacity: 0.7, marginTop: '3px', textAlign: msg.sender === playerToken ? 'right' : 'left' }}>{msg.time}</div>
                            </div>
                        </div>
                    ))}
                </div>
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
            </div>}
        </div>
    );
};

const buttonStyle = (bgColor, textColor) => ({
    padding: '8px 15px', fontSize: '14px', cursor: 'pointer', backgroundColor: bgColor,
    color: textColor, border: 'none', borderRadius: '5px', marginRight: '0',
    opacity: 1, transition: 'opacity 0.2s ease'
});

const statusBoxStyle = (type = "info") => {
    const colors = {
        info: { bg: "#d1ecf1", text: "#0c5460", border: "#bee5eb" },
        success: { bg: "#d4edda", text: "#155724", border: "#c3e6cb" },
        warning: { bg: "#fff3cd", text: "#856404", border: "#ffeeba" },
        danger: { bg: "#f8d7da", text: "#721c24", border: "#f5c6cb" },
        gray: { bg: "#eee", text: "#333", border: "#ccc" }
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
    backgroundColor: isTurn ? '#e7f1ff' : '#f8f9fa'
});

const boardOverlayStyle = {
    position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
    backgroundColor: 'rgba(128, 128, 128, 0.15)', zIndex: 10, cursor: 'not-allowed',
    display: 'flex', justifyContent: 'center', alignItems: 'center',
    color: '#333', fontWeight: 'bold', fontSize: '16px', textAlign: 'center', borderRadius: '3px'
};

export default ChessGame;
