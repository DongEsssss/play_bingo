const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const isDev = !app.isPackaged;
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');

let mainWindow;
let io;
let server;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    minWidth: 600,
    maxWidth: 600,
    height: 800,
    minHeight: 700,
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

      const isHost = gameState.players.length === 0;
      const playerRole = isHost ? 0 : gameState.players.length; // use numeric roles
      
      gameState.players.push({
        id: socket.id,
        role: playerRole,
      });

      socket.emit('init', { role: playerRole, gameState });
      
      // Notify others
      io.emit('lobby-update', { playerCount: gameState.players.length });

      socket.on('ready', (board) => {
        if (board) {
          gameState.boards[socket.id] = board;
        }
        gameState.readyPlayers += 1;
        io.emit('lobby-update', { playerCount: gameState.players.length, readyPlayers: gameState.readyPlayers });
      });

      socket.on('start-game-manual', () => {
        // Only host can start
        if (gameState.players[0] && gameState.players[0].id === socket.id) {
          io.emit('game-start', { 
            turn: gameState.turn,
            boards: gameState.boards,
            players: gameState.players
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
          gameState.turn = (gameState.turn + 1) % gameState.players.length; // Switch turn
          
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
        delete gameState.boards[socket.id];
        // Re-assign roles based on new positions
        gameState.players.forEach((p, idx) => p.role = idx);
        
        // Count ready players
        gameState.readyPlayers = Object.keys(gameState.boards).length;
        
        io.emit('lobby-update', { playerCount: gameState.players.length, readyPlayers: gameState.readyPlayers });
        io.emit('player-left', { players: gameState.players });
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
