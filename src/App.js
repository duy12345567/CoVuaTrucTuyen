import React, { useState, useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";
import ChessGame from "./ChessGame"; // Import component ChessGame

// --- Socket Connection ---
const SERVER_URL = "http://192.168.1.10:5000";

// Khởi tạo socket nhưng chưa kết nối ngay
const socket = io(SERVER_URL, {
    autoConnect: false, // Tự quản lý việc kết nối
    reconnection: true,
    reconnectionAttempts: 5, // Số lần thử kết nối lại tối đa
    reconnectionDelay: 1000, // Thời gian chờ giữa các lần thử (ms)
});

function App() {
    // --- State ---
    // Connection state
    const [isConnected, setIsConnected] = useState(socket.connected);
    const [isConnecting, setIsConnecting] = useState(false);
    const [connectionError, setConnectionError] = useState(null);
    const [rejoinStatusMessage, setRejoinStatusMessage] = useState(''); // Thông báo trạng thái rejoin

    // Game state
    const [gameActive, setGameActive] = useState(false); // Đang trong trận?
    const [matching, setMatching] = useState(false);     // Đang tìm trận?
    const [gameData, setGameData] = useState(null);       // Lưu dữ liệu game khi active { color, turn, roomId, playerToken, fen?, whiteTime?, blackTime? }

    // Ref để truy cập gameData trong listener mà không cần thêm vào dependency array của useEffect
    const gameDataRef = useRef(gameData);
    useEffect(() => { gameDataRef.current = gameData; }, [gameData]);

    // --- Connection Logic ---
    // Hàm để thực hiện kết nối thủ công hoặc tự động
    const connectSocket = useCallback(() => {
        if (!socket.connected && !isConnecting) {
            console.log("Attempting to connect to server...");
            setIsConnecting(true);
            setConnectionError(null);
            setRejoinStatusMessage(''); // Xóa thông báo cũ
            socket.connect(); // Bắt đầu kết nối
        }
    }, [isConnecting]); // Dependency là isConnecting

    // Thử kết nối khi component được mount lần đầu
    useEffect(() => {
        connectSocket();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // Chỉ chạy 1 lần khi mount


    // --- Socket Event Listeners Effect ---
    useEffect(() => {
        // Hàm xử lý khi kết nối thành công
        const handleConnect = () => {
            console.log("✅ Successfully connected to server! Socket ID:", socket.id);
            setIsConnected(true);
            setIsConnecting(false);
            setConnectionError(null);
            setRejoinStatusMessage('Đã kết nối. Kiểm tra phòng cũ...');

            // Kiểm tra localStorage để thử rejoin tự động
            const roomId = localStorage.getItem("chessGameRoomId");
            const playerToken = localStorage.getItem("chessPlayerToken");

            // Chỉ thử rejoin nếu có thông tin và hiện tại *không* có game nào đang active trong state
            if (roomId && playerToken && !gameDataRef.current) {
                 console.log(`🔍 Found previous game info (Room: ${roomId}, Token: ${playerToken}). Attempting rejoin...`);
                 setRejoinStatusMessage('Đang thử tham gia lại phòng cũ...');
                 socket.emit("rejoinGame", { roomId, playerToken });
            } else if (gameDataRef.current) {
                 console.log("Already have active game data, skipping automatic rejoin check.");
                 setRejoinStatusMessage(''); // Xóa thông báo nếu đã có game
            } else {
                 console.log("No previous game info found in localStorage.");
                  setRejoinStatusMessage(''); // Xóa thông báo nếu không có gì để rejoin
            }
        };

        // Hàm xử lý khi mất kết nối
        const handleDisconnect = (reason) => {
            console.warn(`🔌 Disconnected from server. Reason: ${reason}`);
            setIsConnected(false);
            setIsConnecting(false); // Không còn đang kết nối nữa
            setRejoinStatusMessage(''); // Xóa thông báo
            const errorMessage = reason === "io server disconnect" ? "Server yêu cầu ngắt kết nối." : "Mất kết nối, đang thử lại...";
            setConnectionError(errorMessage);

            // Reset trạng thái về màn hình chờ nếu đang trong game
            // Điều này quan trọng để UI hiển thị đúng khi mất kết nối đột ngột
            if (gameDataRef.current) {
                console.log("Resetting game state due to disconnect during active game.");
                setGameActive(false); // Quay về màn hình chờ/kết nối lại
                setGameData(null);    // Xóa dữ liệu game hiện tại khỏi state
            }
        };

        // Hàm xử lý lỗi kết nối
        const handleConnectError = (error) => {
            console.error(`❌ Connection Error: ${error.message}`);
            setIsConnected(false);
            setIsConnecting(false); // Thất bại, không còn đang kết nối
            setConnectionError(`Không thể kết nối: ${error.message}.`);
            setRejoinStatusMessage(''); // Xóa thông báo
        };

        // Hàm xử lý khi server bắt đầu game mới (từ matchmaking)
         const handleGameStart = (data) => { // data = { color, turn, roomId, playerToken, whiteTime, blackTime }
              console.log(`🎉 Game starting! Room: ${data.roomId}, Color: ${data.color}, Token: ${data.playerToken}`);
              setGameData({ ...data, fen: undefined }); // Lưu data, FEN sẽ được ChessGame tự tạo ban đầu
              setMatching(false);     // Không còn tìm trận nữa
              setGameActive(true);    // Vào màn hình game
              setRejoinStatusMessage(''); // Xóa thông báo
              // Lưu thông tin vào localStorage để có thể rejoin
              localStorage.setItem("chessGameRoomId", data.roomId);
              localStorage.setItem("chessPlayerToken", data.playerToken);
          };

          // Hàm xử lý khi rejoin thành công
          const handleGameRejoined = (data) => { // data đầy đủ hơn: { ..., fen, history, opponentStatus }
               console.log(`🔄 Successfully rejoined room ${data.roomId}`);
               setGameData(data); // Cập nhật state với dữ liệu game đầy đủ từ server
               setMatching(false);
               setGameActive(true);
               setRejoinStatusMessage(''); // Xóa thông báo
               // Không cần lưu lại localStorage vì thông tin đã có sẵn
           };

           // Hàm xử lý khi rejoin thất bại
           const handleRejoinFailed = ({ reason, message }) => {
                console.error(`❌ Rejoin Failed (Reason: ${reason}): ${message}`);
                setRejoinStatusMessage(`Lỗi tham gia lại: ${message}`); // Hiển thị lỗi
                alert(`Không thể tham gia lại phòng: ${message}`); // Alert để chắc chắn người dùng thấy
                // Xóa thông tin phòng cũ khỏi localStorage vì không vào lại được
                localStorage.removeItem("chessGameRoomId");
                localStorage.removeItem("chessPlayerToken");
                // Reset về màn hình chính
                setGameActive(false);
                setGameData(null);
            };

            // Hàm xử lý khi game kết thúc (nhận từ server)
             const handleGameOver = (data) => {
                  console.log("🏁 Game over received in App. Reason:", data.reason);
                  // Xóa thông tin rejoin khỏi localStorage
                  localStorage.removeItem("chessGameRoomId");
                  localStorage.removeItem("chessPlayerToken");
                  setRejoinStatusMessage(''); // Xóa thông báo
                  // Component ChessGame sẽ hiển thị kết quả.
              };

        // --- Đăng ký Listeners ---
        socket.on("connect", handleConnect);
        socket.on("disconnect", handleDisconnect);
        socket.on("connect_error", handleConnectError);
        socket.on("gameStart", handleGameStart);
        socket.on("gameRejoined", handleGameRejoined);
        socket.on("rejoinFailed", handleRejoinFailed);
        socket.on("gameOver", handleGameOver);

        // --- Cleanup Function ---
        return () => {
            console.log("🧹 Cleaning up App listeners...");
            socket.off("connect", handleConnect);
            socket.off("disconnect", handleDisconnect);
            socket.off("connect_error", handleConnectError);
            socket.off("gameStart", handleGameStart);
            socket.off("gameRejoined", handleGameRejoined);
            socket.off("rejoinFailed", handleRejoinFailed);
            socket.off("gameOver", handleGameOver);
        };
    }, [connectSocket]); // Dependency là connectSocket để đảm bảo nó ổn định


    // --- Matchmaking Actions ---
    const handleStartMatch = () => {
        if (isConnected && !matching && !gameActive) { // Chỉ bắt đầu nếu đã kết nối, chưa tìm, và chưa trong game
            console.log("🚀 Starting matchmaking...");
            setMatching(true);
            setRejoinStatusMessage(''); // Xóa thông báo cũ
            socket.emit("startMatch");
        } else if (!isConnected) {
            alert("Chưa kết nối đến server. Đang thử kết nối lại...");
            connectSocket(); // Thử kết nối lại
        }
    };

    const handleCancelMatch = () => {
        if (isConnected && matching) {
            console.log("🛑 Canceling matchmaking...");
            setMatching(false);
            socket.emit("cancelMatch");
        }
    };

     // Callback để ChessGame báo hiệu cần quay về màn hình chính
      const handleSetGameInactive = useCallback(() => {
          setGameActive(false);
          setGameData(null);
          console.log("Returned to main screen from ChessGame.");
      }, []);


    // --- Render Logic ---
    return (
        <div style={appStyle.container}>
            {/* --- Header: Connection Status --- */}
            <div style={appStyle.statusBar}>
                 <p style={{ fontWeight: 'bold', color: isConnected ? 'green' : (isConnecting ? 'orange' : 'red') }}>
                      {isConnecting ? 'Đang kết nối...' : isConnected ? 'Đã kết nối' : 'Đã ngắt kết nối'}
                  </p>
                  {connectionError && <p style={{ color: 'darkorange', fontSize: '0.9em', margin: '0 5px' }}>({connectionError})</p>}
                  {/* Hiển thị thông báo Rejoin */}
                  {rejoinStatusMessage && <p style={{ color: 'blue', fontSize: '0.9em', fontStyle:'italic', margin: '0 5px' }}>{rejoinStatusMessage}</p>}
                  {!isConnected && !isConnecting && (
                      <button onClick={connectSocket} style={appStyle.reconnectButton}>Thử lại</button>
                  )}
            </div>

            {/* --- Main Content --- */}
            <div style={appStyle.mainContent}>
                {!gameActive ? (
                    // --- Matchmaking Screen ---
                    <div style={appStyle.centered}>
                        <h1>♜ Cờ vua trực tuyến</h1>
                        {!matching ? (
                            <>
                                <p>Nhấn "Bắt đầu" để tìm trận đấu mới.</p>
                                <button
                                    onClick={handleStartMatch}
                                    // Disable khi: chưa kết nối HOẶC đang kết nối HOẶC đang xử lý rejoin
                                    disabled={!isConnected || isConnecting || !!rejoinStatusMessage}
                                    style={buttonStyle((isConnected && !rejoinStatusMessage) ? "#28a745" : "#cccccc", "white")}
                                >
                                    Bắt đầu
                                </button>
                            </>
                        ) : (
                            <>
                                <h3>Đang tìm đối thủ... <span className="spinner">⏳</span></h3>
                                <button
                                    onClick={handleCancelMatch}
                                    disabled={!isConnected} // Chỉ cần check isConnected vì đang matching
                                    style={buttonStyle("#dc3545", "white")}
                                >
                                    Hủy tìm kiếm
                                </button>
                            </>
                        )}
                    </div>
                ) : gameData ? (
                    // --- Game Screen ---
                    <ChessGame
                        key={gameData.roomId} // Thêm key để React re-mount component khi vào phòng mới
                        socket={socket}
                        initialColor={gameData.color}
                        initialTurn={gameData.turn}
                        initialRoomId={gameData.roomId}
                        initialPlayerToken={gameData.playerToken}
                        initialFen={gameData.fen}
                        initialWhiteTime={gameData.whiteTime}
                        initialBlackTime={gameData.blackTime}
                        setGameActive={handleSetGameInactive} // Truyền callback
                    />
                ) : (
                    // --- Loading/Rejoining State ---
                     <div style={appStyle.centered}>
                          <h1>♜ Cờ vua trực tuyến</h1>
                          <h3>{rejoinStatusMessage || "Đang tải..."}</h3> {}
                     </div>
                )}
            </div>

            {/* CSS for spinner */}
            <style>{`.spinner { display: inline-block; animation: spin 1s linear infinite; } @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
        </div>
    );
}

// --- Helper Styles ---
const appStyle = {
    container: { fontFamily: "Arial, sans-serif", display: 'flex', flexDirection: 'column', minHeight: '100vh' },
    statusBar: { display:'flex', justifyContent:'center', alignItems:'center', flexWrap:'wrap', padding: '5px 10px', backgroundColor:'#f0f0f0', borderBottom:'1px solid #ccc', fontSize:'0.9em' },
    mainContent: { flexGrow: 1, padding: "10px", display: 'flex', justifyContent:'center', alignItems:'flex-start' /* Canh lề trên */ },
    centered: { textAlign: 'center', marginTop: '50px' },
    reconnectButton: { padding: '3px 8px', fontSize: '0.8em', marginLeft:'10px', cursor:'pointer'}
};

const buttonStyle = (bgColor, textColor) => ({
    padding: '12px 25px', fontSize: '16px', cursor: 'pointer', backgroundColor: bgColor,
    color: textColor, border: 'none', borderRadius: '5px', margin: '10px',
    opacity: 1, transition: 'opacity 0.2s ease, background-color 0.2s ease',
    ':disabled': { opacity: 0.6, cursor: 'not-allowed' }
});


export default App;