const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const isDev = process.env.NODE_ENV !== 'production';
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');

let mainWindow;
let io;
let server;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    backgroundColor: '#f3f4f6'
  });

  const loadURL = isDev
    ? 'http://localhost:3000'
    : `file://${path.join(__dirname, '../build/index.html')}`;
    
  // Allow loading local resources if needed
  mainWindow.loadURL(loadURL);

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Helper to get local IP address
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    const iface = interfaces[devName];
    for (let i = 0; i < iface.length; i++) {
      const alias = iface[i];
      if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return '127.0.0.1';
}

ipcMain.handle('get-local-ip', () => {
  return getLocalIpAddress();
});

ipcMain.handle('start-server', (event, port = 4000) => {
  if (server) {
    return { success: false, message: 'Server already running' };
  }

  try {
    server = http.createServer();
    io = new Server(server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });

    let gameState = {
      players: [],
      turn: 0,
      markedNumbers: [],
      readyPlayers: 0,
      boards: {}
    };

    io.on('connection', (socket) => {
      console.log('A user connected:', socket.id);
      
      if (gameState.players.length >= 2) {
        socket.emit('error', 'Room is full');
        socket.disconnect();
        return;
      }

      const isHost = gameState.players.length === 0;
      const playerRole = isHost ? 'host' : 'client';
      
      gameState.players.push({
        id: socket.id,
        role: playerRole,
      });

      socket.emit('init', { role: playerRole, gameState });
      
      // Notify others
      socket.broadcast.emit('player-joined', { role: playerRole });

      // When both are connected, they can send 'ready' with their board
      socket.on('ready', (board) => {
        if (board) {
          gameState.boards[socket.id] = board;
        }
        gameState.readyPlayers += 1;
        if (gameState.readyPlayers >= 2) {
          io.emit('game-start', { 
            turn: gameState.turn,
            boards: gameState.boards 
          });
        }
      });

      socket.on('mark-number', (number) => {
        // Validate turn
        const currentPlayerIndex = gameState.turn;
        if (gameState.players[currentPlayerIndex]?.id !== socket.id) {
          return; // Not this player's turn
        }

        if (!gameState.markedNumbers.includes(number)) {
          gameState.markedNumbers.push(number);
          gameState.turn = gameState.turn === 0 ? 1 : 0; // Switch turn
          
          io.emit('number-marked', {
            number,
            nextTurn: gameState.turn,
            markedNumbers: gameState.markedNumbers
          });
        }
      });

      socket.on('reset-game', () => {
        gameState.markedNumbers = [];
        gameState.turn = 0;
        gameState.readyPlayers = 0;
        io.emit('game-reset');
      });

      socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        gameState.players = gameState.players.filter(p => p.id !== socket.id);
        gameState.readyPlayers = 0;
        gameState.markedNumbers = [];
        io.emit('player-left');
      });
    });

    server.listen(port, '0.0.0.0', () => {
      console.log(`Socket.IO server running on port ${port}`);
    });

    return { success: true, ip: getLocalIpAddress(), port };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('stop-server', () => {
  if (io) {
    io.close();
    io = null;
  }
  if (server) {
    server.close();
    server = null;
  }
  return { success: true };
});
