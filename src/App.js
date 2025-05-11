import React, { useState, useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";
import ChessGame from "./ChessGame"; // Import component ChessGame

const SERVER_URL = "http://172.9.1.187:5000";
const socket = io(SERVER_URL, { autoConnect: false, reconnection: true, reconnectionAttempts: 5, reconnectionDelay: 1000 });

function App() {
    const [isConnected, setIsConnected] = useState(socket.connected);
    const [isConnecting, setIsConnecting] = useState(false);
    const [connectionError, setConnectionError] = useState(null);
    const [rejoinStatusMessage, setRejoinStatusMessage] = useState('');

    const [gameActive, setGameActive] = useState(false);
    const [matching, setMatching] = useState(false);
    const [gameData, setGameData] = useState(null);
    const [isSpectator, setIsSpectator] = useState(false);
    const [spectateRoomId, setSpectateRoomId] = useState("");

    const gameDataRef = useRef(gameData);
    useEffect(() => { gameDataRef.current = gameData; }, [gameData]);

    const connectSocket = useCallback(() => {
        if (!socket.connected && !isConnecting) {
            setIsConnecting(true);
            setConnectionError(null);
            setRejoinStatusMessage('');
            socket.connect();
        }
    }, [isConnecting]);

    useEffect(() => {
        connectSocket();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const handleConnect = () => {
            setIsConnected(true);
            setIsConnecting(false);
            setConnectionError(null);
            setRejoinStatusMessage('Đã kết nối. Kiểm tra phòng cũ...');
            const roomId = localStorage.getItem("chessGameRoomId");
            const playerToken = localStorage.getItem("chessPlayerToken");
            if (roomId && playerToken && !gameDataRef.current) {
                socket.emit("rejoinGame", { roomId, playerToken });
                setRejoinStatusMessage('Đang thử tham gia lại phòng cũ...');
            } else {
                setRejoinStatusMessage('');
            }
        };

        const handleDisconnect = (reason) => {
            setIsConnected(false);
            setIsConnecting(false);
            setRejoinStatusMessage('');
            const errorMessage = reason === "io server disconnect" ? "Server yêu cầu ngắt kết nối." : "Mất kết nối, đang thử lại...";
            setConnectionError(errorMessage);
            if (gameDataRef.current) {
                setGameActive(false);
                setGameData(null);
                setIsSpectator(false);
            }
        };

        const handleConnectError = (error) => {
            setIsConnected(false);
            setIsConnecting(false);
            setConnectionError(`Không thể kết nối: ${error.message}.`);
            setRejoinStatusMessage('');
        };

        const handleGameStart = (data) => {
            setGameData({ ...data, fen: undefined });
            setMatching(false);
            setGameActive(true);
            setRejoinStatusMessage('');
            setIsSpectator(false);
            localStorage.setItem("chessGameRoomId", data.roomId);
            localStorage.setItem("chessPlayerToken", data.playerToken);
        };

        const handleGameRejoined = (data) => {
            setGameData(data);
            setMatching(false);
            setGameActive(true);
            setRejoinStatusMessage('');
            setIsSpectator(false);
        };

        const handleRejoinFailed = ({ reason, message }) => {
            setRejoinStatusMessage(`Lỗi tham gia lại: ${message}`);
            alert(`Không thể tham gia lại phòng: ${message}`);
            localStorage.removeItem("chessGameRoomId");
            localStorage.removeItem("chessPlayerToken");
            setGameActive(false);
            setGameData(null);
        };

        const handleGameOver = (data) => {
            localStorage.removeItem("chessGameRoomId");
            localStorage.removeItem("chessPlayerToken");
            setRejoinStatusMessage('');
        };

        const handleSpectateStarted = (data) => {
            setGameData({ ...data });
            setGameActive(true);
            setIsSpectator(true);
        };

        const handleSpectateFailed = ({ message }) => {
            alert(`Không thể xem phòng: ${message}`);
        };

        socket.on("connect", handleConnect);
        socket.on("disconnect", handleDisconnect);
        socket.on("connect_error", handleConnectError);
        socket.on("gameStart", handleGameStart);
        socket.on("gameRejoined", handleGameRejoined);
        socket.on("rejoinFailed", handleRejoinFailed);
        socket.on("gameOver", handleGameOver);
        socket.on("spectateStarted", handleSpectateStarted);
        socket.on("spectateFailed", handleSpectateFailed);

        return () => {
            socket.off("connect", handleConnect);
            socket.off("disconnect", handleDisconnect);
            socket.off("connect_error", handleConnectError);
            socket.off("gameStart", handleGameStart);
            socket.off("gameRejoined", handleGameRejoined);
            socket.off("rejoinFailed", handleRejoinFailed);
            socket.off("gameOver", handleGameOver);
            socket.off("spectateStarted", handleSpectateStarted);
            socket.off("spectateFailed", handleSpectateFailed);
        };
    }, [connectSocket]);

    const handleStartMatch = () => {
        if (isConnected && !matching && !gameActive) {
            setMatching(true);
            setRejoinStatusMessage('');
            setIsSpectator(false);
            socket.emit("startMatch");
        } else if (!isConnected) {
            alert("Chưa kết nối đến server. Đang thử kết nối lại...");
            connectSocket();
        }
    };

    const handleCancelMatch = () => {
        if (isConnected && matching) {
            setMatching(false);
            socket.emit("cancelMatch");
        }
    };

    const handleSetGameInactive = useCallback(() => {
        setGameActive(false);
        setGameData(null);
        setIsSpectator(false);
    }, []);

    const handleSpectateRoom = () => {
        if (!spectateRoomId.trim()) return alert("Vui lòng nhập Room ID.");
        socket.emit("spectateGame", { roomId: spectateRoomId.trim() });
    };

    return (
        <div style={appStyle.container}>
            <div style={appStyle.statusBar}>
                <p style={{ fontWeight: 'bold', color: isConnected ? 'green' : (isConnecting ? 'orange' : 'red') }}>
                    {isConnecting ? 'Đang kết nối...' : isConnected ? 'Đã kết nối' : 'Đã ngắt kết nối'}
                </p>
                {connectionError && <p style={{ color: 'darkorange', fontSize: '0.9em', margin: '0 5px' }}>({connectionError})</p>}
                {rejoinStatusMessage && <p style={{ color: 'blue', fontSize: '0.9em', fontStyle: 'italic', margin: '0 5px' }}>{rejoinStatusMessage}</p>}
                {!isConnected && !isConnecting && (
                    <button onClick={connectSocket} style={appStyle.reconnectButton}>Thử lại</button>
                )}
            </div>

            <div style={appStyle.mainContent}>
                {!gameActive ? (
                    <div style={appStyle.centered}>
                        <h1>♜ Cờ vua trực tuyến</h1>
                        {!matching ? (
                            <>
                                <p>Nhấn "Bắt đầu" để tìm trận đấu mới.</p>
                                <button
                                    onClick={handleStartMatch}
                                    disabled={!isConnected || isConnecting || !!rejoinStatusMessage}
                                    style={buttonStyle((isConnected && !rejoinStatusMessage) ? "#28a745" : "#cccccc", "white")}
                                >
                                    Bắt đầu
                                </button>

                                <div style={{ marginTop: '20px' }}>
                                    <h4>Hoặc xem trận đấu</h4>
                                    <input
                                        type="text"
                                        value={spectateRoomId}
                                        onChange={(e) => setSpectateRoomId(e.target.value)}
                                        placeholder="Nhập Room ID..."
                                        style={{ padding: "8px", marginRight: "5px" }}
                                    />
                                    <button onClick={handleSpectateRoom} style={buttonStyle("#007bff", "white")}>Xem</button>
                                </div>
                            </>
                        ) : (
                            <>
                                <h3>Đang tìm đối thủ... <span className="spinner">⏳</span></h3>
                                <button
                                    onClick={handleCancelMatch}
                                    disabled={!isConnected}
                                    style={buttonStyle("#dc3545", "white")}
                                >
                                    Hủy tìm kiếm
                                </button>
                            </>
                        )}
                    </div>
                ) : gameData ? (
                    <ChessGame
                        key={gameData.roomId}
                        socket={socket}
                        initialColor={gameData.color}
                        initialTurn={gameData.turn}
                        initialRoomId={gameData.roomId}
                        initialPlayerToken={gameData.playerToken}
                        initialFen={gameData.fen}
                        initialWhiteTime={gameData.whiteTime}
                        initialBlackTime={gameData.blackTime}
                        isSpectator={isSpectator}
                        setGameActive={handleSetGameInactive}
                    />
                ) : (
                    <div style={appStyle.centered}>
                        <h1>♜ Cờ vua trực tuyến</h1>
                        <h3>{rejoinStatusMessage || "Đang tải..."}</h3>
                    </div>
                )}
            </div>

            <style>{`.spinner { display: inline-block; animation: spin 1s linear infinite; } @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
        </div>
    );
}

const appStyle = {
    container: { fontFamily: "Arial, sans-serif", display: 'flex', flexDirection: 'column', minHeight: '100vh' },
    statusBar: { display: 'flex', justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap', padding: '5px 10px', backgroundColor: '#f0f0f0', borderBottom: '1px solid #ccc', fontSize: '0.9em' },
    mainContent: { flexGrow: 1, padding: "10px", display: 'flex', justifyContent: 'center', alignItems: 'flex-start' },
    centered: { textAlign: 'center', marginTop: '50px' },
    reconnectButton: { padding: '3px 8px', fontSize: '0.8em', marginLeft: '10px', cursor: 'pointer' }
};

const buttonStyle = (bgColor, textColor) => ({
    padding: '12px 25px', fontSize: '16px', cursor: 'pointer', backgroundColor: bgColor,
    color: textColor, border: 'none', borderRadius: '5px', margin: '10px',
    opacity: 1, transition: 'opacity 0.2s ease, background-color 0.2s ease'
});

export default App;
