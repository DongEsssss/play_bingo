import React, { useState, useEffect, useRef, useCallback } from 'react';
import io from 'socket.io-client';
import { generateBoard, checkBingo } from './utils/bingo';
import './index.css';

// ---------------------------------------------------------------------------
// 사운드 (외부 파일 없이 WebAudio로 즉석 생성 — 에셋 누락 걱정 없음)
// ---------------------------------------------------------------------------
let audioCtx = null;
function playTone(freq, duration = 0.12, type = 'sine', gain = 0.05) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.value = gain;
    osc.connect(g);
    g.connect(audioCtx.destination);
    osc.start();
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
    osc.stop(audioCtx.currentTime + duration);
  } catch (e) {
    /* no-op if audio unavailable */
  }
}
const SFX = {
  mark: () => playTone(660, 0.1, 'triangle', 0.05),
  line: () => { playTone(523, 0.12, 'square', 0.05); setTimeout(() => playTone(784, 0.14, 'square', 0.05), 90); },
  win: () => { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => playTone(f, 0.18, 'triangle', 0.06), i * 110)); },
  lose: () => { [400, 320, 240].forEach((f, i) => setTimeout(() => playTone(f, 0.2, 'sawtooth', 0.04), i * 130)); },
  click: () => playTone(880, 0.05, 'square', 0.03),
};

// ---------------------------------------------------------------------------
// 빙고 라인(가로/세로/대각선) 좌표 — 5x5 보드 기준으로 완성된 줄을 계산해서
// 보드 위에 하이라이트를 그려주기 위한 헬퍼 (기존 checkBingo 로직과는 별개로
// "어떤 칸들이 줄을 이루는지" 시각화 전용으로 사용)
// ---------------------------------------------------------------------------
function getLineDefinitions(size = 5) {
  const lines = [];
  for (let r = 0; r < size; r++) lines.push(Array.from({ length: size }, (_, c) => r * size + c));
  for (let c = 0; c < size; c++) lines.push(Array.from({ length: size }, (_, r) => r * size + c));
  lines.push(Array.from({ length: size }, (_, i) => i * size + i));
  lines.push(Array.from({ length: size }, (_, i) => i * size + (size - 1 - i)));
  return lines;
}

function getCompletedCellIndices(boardArr, markedNumbers) {
  if (!boardArr || boardArr.length !== 25) return new Set();
  const size = Math.sqrt(boardArr.length) | 0;
  const lineDefs = getLineDefinitions(size);
  const completed = new Set();
  lineDefs.forEach((line) => {
    const allMarked = line.every((idx) => markedNumbers.includes(boardArr[idx]));
    if (allMarked) line.forEach((idx) => completed.add(idx));
  });
  return completed;
}

const THEMES = [
  { id: 'classic', label: '클래식 네온', emoji: '✨', desc: '기본 아케이드 스타일' },
  { id: 'glass', label: '유리 깨기', emoji: '🪟', desc: '눌러서 유리를 와장창 깨보세요' },
  { id: 'cloud', label: '구름 지우기', emoji: '☁️', desc: '바람이 구름을 걷어냅니다' },
];

const RECORD_KEY = 'bingo-record-v1';
function loadRecord() {
  try {
    const raw = localStorage.getItem(RECORD_KEY);
    return raw ? JSON.parse(raw) : { win: 0, lose: 0, draw: 0 };
  } catch {
    return { win: 0, lose: 0, draw: 0 };
  }
}
function saveRecord(rec) {
  try { localStorage.setItem(RECORD_KEY, JSON.stringify(rec)); } catch { /* ignore */ }
}

function App() {
  const [view, setView] = useState('menu'); // 'menu', 'single', 'multi'
  const [board, setBoard] = useState([]);
  const [enemyBoard, setEnemyBoard] = useState([]);
  const [showOpponentBoard, setShowOpponentBoard] = useState(false);
  const [markedNumbers, setMarkedNumbers] = useState([]);
  const [turn, setTurn] = useState(0); // 0: Player 1 / Host, 1: AI / Client
  const [playerRole, setPlayerRole] = useState(0); // 0: Player 1/Host, 1: Client
  const [status, setStatus] = useState('');
  const [localIp, setLocalIp] = useState('Loading...');
  const [hostIpInput, setHostIpInput] = useState('');
  const [socket, setSocket] = useState(null);

  const [bingoLines, setBingoLines] = useState(0);
  const [enemyBingoLines, setEnemyBingoLines] = useState(0);

  // ---- 신규 기능 상태 ----
  const [theme, setTheme] = useState(() => localStorage.getItem('bingo-theme') || 'classic');
  const [soundOn, setSoundOn] = useState(true);
  const [record, setRecord] = useState(loadRecord);
  const [comboMsg, setComboMsg] = useState(null); // 콤보(2줄 이상 동시완성) 알림
  const [justMarked, setJustMarked] = useState(null); // 방금 마킹된 숫자(애니메이션 트리거용)
  const [peekUsed, setPeekUsed] = useState(false);
  const [peekActive, setPeekActive] = useState(false);
  const prevLinesRef = useRef(0);

  const isElectron = window.electron !== undefined;

  useEffect(() => {
    if (isElectron) {
      window.electron.getLocalIp().then(ip => setLocalIp(ip));
    }
  }, [isElectron]);

  useEffect(() => {
    localStorage.setItem('bingo-theme', theme);
  }, [theme]);

  const initGame = (isSinglePlayer) => {
    const newBoard = generateBoard();
    setBoard(newBoard);

    if (isSinglePlayer) {
      setEnemyBoard(generateBoard());
    } else {
      setEnemyBoard([]);
    }

    setMarkedNumbers([]);
    setTurn(0);
    setBingoLines(0);
    setEnemyBingoLines(0);
    setShowOpponentBoard(false);
    setPeekUsed(false);
    setPeekActive(false);
    setComboMsg(null);
    prevLinesRef.current = 0;

    return newBoard;
  };

  const finalizeRecord = (result) => {
    setRecord((prev) => {
      const next = { ...prev, [result]: (prev[result] || 0) + 1 };
      saveRecord(next);
      return next;
    });
  };

  const checkWinCondition = (myLines, theirLines) => {
    if (myLines >= 5 && theirLines >= 5) {
      setStatus('무승부!');
      finalizeRecord('draw');
      return;
    }
    if (myLines >= 5) {
      setStatus('You Win!');
      if (soundOn) SFX.win();
      finalizeRecord('win');
    } else if (theirLines >= 5) {
      setStatus(view === 'single' ? 'AI Wins!' : 'Opponent Wins!');
      if (soundOn) SFX.lose();
      finalizeRecord('lose');
    }
  };

  useEffect(() => {
    const myLines = checkBingo(board, markedNumbers);
    const theirLines = checkBingo(enemyBoard, markedNumbers);
    setBingoLines(myLines);
    setEnemyBingoLines(theirLines);

    // 콤보 감지: 한 번의 마킹으로 두 줄 이상 새로 완성되면 콤보 알림
    const delta = myLines - prevLinesRef.current;
    if (delta >= 2) {
      setComboMsg(`${delta} LINE COMBO!`);
      if (soundOn) SFX.line();
      setTimeout(() => setComboMsg(null), 1600);
    } else if (delta === 1 && myLines > 0 && status === '') {
      if (soundOn) SFX.line();
    }
    prevLinesRef.current = myLines;

    if (status === '') {
      checkWinCondition(myLines, theirLines);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markedNumbers, board, enemyBoard]);

  // AI Turn Logic for Single Player
  useEffect(() => {
    if (view === 'single' && turn === 1 && status === '') {
      const timer = setTimeout(() => {
        const available = enemyBoard.filter(n => !markedNumbers.includes(n));
        if (available.length > 0) {
          const pick = available[Math.floor(Math.random() * available.length)];
          handleMarkNumber(pick);
        }
      }, 1000);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn, view, status, enemyBoard, markedNumbers]);

  const handleMarkNumber = (number) => {
    if (status !== '') return;
    if (markedNumbers.includes(number)) return;

    if (view === 'single') {
      if (turn !== playerRole && turn === 1) {
        setMarkedNumbers(prev => [...prev, number]);
        setTurn(0);
      } else if (turn === playerRole) {
        setJustMarked(number);
        if (soundOn) SFX.mark();
        setMarkedNumbers(prev => [...prev, number]);
        setTurn(1);
      }
    } else if (view === 'multi' && socket) {
      if (turn === playerRole) {
        setJustMarked(number);
        if (soundOn) SFX.mark();
        socket.emit('mark-number', number);
      }
    }
  };

  // 파워업: 게임당 1회, 상대 보드를 3초간 미리보기
  const usePeek = () => {
    if (peekUsed || status !== '') return;
    setPeekUsed(true);
    setPeekActive(true);
    setShowOpponentBoard(true);
    if (soundOn) SFX.click();
    setTimeout(() => setPeekActive(false), 3000);
  };

  const startSinglePlayer = () => {
    initGame(true);
    setPlayerRole(0);
    setView('single');
    setStatus('');
  };

  const startHost = async () => {
    if (isElectron) {
      setStatus('Starting server...');
      const res = await window.electron.startServer(4000);
      if (res.success) {
        connectToServer(`http://127.0.0.1:4000`);
      } else {
        setStatus('Failed to start server');
      }
    } else {
      setStatus('Must run in Electron to host.');
    }
  };

  const startJoin = () => {
    if (!hostIpInput) return;
    connectToServer(`http://${hostIpInput}:4000`);
  };

  const connectToServer = (url) => {
    setStatus('Connecting...');
    const newSocket = io(url);

    newSocket.on('connect', () => {
      setSocket(newSocket);
    });

    newSocket.on('init', (data) => {
      setPlayerRole(data.role === 'host' ? 0 : 1);
      setView('multi');
      initGame(false);
      setStatus('Waiting for other player...');
    });

    newSocket.on('player-joined', () => {
      newSocket.emit('ready', board);
    });

    newSocket.emit('ready', board);

    newSocket.on('game-start', (data) => {
      setTurn(data.turn);
      setStatus('');
      const opponentId = Object.keys(data.boards).find(id => id !== newSocket.id);
      if (opponentId && data.boards[opponentId]) {
        setEnemyBoard(data.boards[opponentId]);
      }
    });

    newSocket.on('number-marked', (data) => {
      setMarkedNumbers(data.markedNumbers);
      setTurn(data.nextTurn);
    });

    newSocket.on('player-left', () => {
      setStatus('Opponent disconnected');
    });

    newSocket.on('error', (msg) => {
      setStatus(`Error: ${msg}`);
      newSocket.disconnect();
    });
  };

  useEffect(() => {
    if (view === 'multi' && socket && status === 'Waiting for other player...' && board.length > 0) {
      socket.emit('ready', board);
    }
  }, [board, view, socket, status]);

  const leaveGame = async () => {
    if (socket) {
      socket.disconnect();
      setSocket(null);
    }
    if (isElectron && playerRole === 0 && view === 'multi') {
      await window.electron.stopServer();
    }
    setView('menu');
    setStatus('');
  };

  const myCompletedCells = getCompletedCellIndices(board, markedNumbers);
  const enemyCompletedCells = getCompletedCellIndices(enemyBoard, markedNumbers);

  const renderCell = (num, idx, isMine, completedSet) => {
    const marked = markedNumbers.includes(num);
    const isCompletedLine = completedSet.has(idx);
    const isFresh = isMine && justMarked === num;
    return (
      <div
        key={idx}
        className={[
          'bingo-cell',
          marked ? 'marked' : '',
          isCompletedLine ? 'in-line' : '',
          isFresh ? 'fresh' : '',
        ].join(' ').trim()}
        onClick={() => isMine && handleMarkNumber(num)}
        style={{ cursor: isMine ? 'pointer' : 'default' }}
        onAnimationEnd={() => { if (isFresh) setJustMarked(null); }}
      >
        <span className="cell-number">{num}</span>
        {theme === 'glass' && <span className="glass-overlay" aria-hidden="true" />}
        {theme === 'cloud' && (
          <span className="cloud-overlay" aria-hidden="true">
            <span className="puff p1" />
            <span className="puff p2" />
            <span className="puff p3" />
            <span className="puff p4" />
            <span className="puff p5" />
          </span>
        )}
      </div>
    );
  };

  return (
    <div className={`app-container theme-${theme}`}>
      <div className="bg-scene" aria-hidden="true">
        {theme === 'classic' && (
          <>
            <div className="bg-grid" />
            <div className="bg-stars" />
            <div className="bg-glow bg-glow-a" />
            <div className="bg-glow bg-glow-b" />
          </>
        )}
        {theme === 'glass' && (
          <>
            <div className="bg-pane" />
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="shard" />
            ))}
          </>
        )}
        {theme === 'cloud' && (
          <>
            <div className="bg-sun" />
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="bg-cloud">
                <span /><span /><span /><span />
              </div>
            ))}
          </>
        )}
      </div>

      {comboMsg && <div className="combo-toast">{comboMsg}</div>}

      {view === 'menu' && (
        <div className="classic-panel main-menu">
          <h1>PLAY BINGO</h1>
          {isElectron && (
            <p style={{ textAlign: 'center', marginBottom: '0.75rem', color: 'var(--text-muted)' }}>
              내 IP: {localIp}
            </p>
          )}

          <div className="record-bar">
            <div className="record-chip win">승 {record.win}</div>
            <div className="record-chip lose">패 {record.lose}</div>
            <div className="record-chip draw">무 {record.draw}</div>
          </div>

          <div className="theme-picker">
            <p className="section-label">테마 선택</p>
            <div className="theme-options">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  className={`theme-chip ${theme === t.id ? 'active' : ''}`}
                  onClick={() => { setTheme(t.id); if (soundOn) SFX.click(); }}
                  title={t.desc}
                >
                  <span className="theme-emoji">{t.emoji}</span>
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          </div>

          <button className="btn" onClick={startSinglePlayer}>AI와 대결하기</button>
          <button className="btn accent" onClick={startHost}>멀티플레이 방 열기</button>

          <div style={{ marginTop: '1rem' }}>
            <input
              type="text"
              className="input-field"
              placeholder="호스트 IP 주소"
              value={hostIpInput}
              onChange={(e) => setHostIpInput(e.target.value)}
            />
            <button className="btn" onClick={startJoin}>멀티플레이 참가하기</button>
          </div>

          <button className="sound-toggle" onClick={() => setSoundOn((s) => !s)}>
            {soundOn ? '🔊 효과음 켜짐' : '🔇 효과음 꺼짐'}
          </button>

          {status && <p style={{ color: 'var(--accent)', textAlign: 'center' }}>{status}</p>}
        </div>
      )}

      {(view === 'single' || view === 'multi') && (
        <div className="classic-panel game-panel">
          <div className="game-header">
            <h2>{status !== '' ? status : (turn === playerRole ? '당신의 차례' : '상대방의 차례')}</h2>
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <button
                className="btn outline power-btn"
                disabled={peekUsed || status !== ''}
                onClick={usePeek}
                title="게임당 1회, 상대 보드를 3초간 확인합니다"
              >
                {peekUsed ? '👁️ 사용 완료' : '👁️ 상대 보드 훔쳐보기'}
              </button>
              <button className="btn outline" onClick={() => setShowOpponentBoard(!showOpponentBoard)}>
                {showOpponentBoard ? '상대 보드 숨기기' : '상대 보드 보기'}
              </button>
              <button className="btn accent" onClick={leaveGame}>
                나가기
              </button>
            </div>
          </div>

          <div className="game-layout">
            <div className="board-container">
              <h3>내 보드 <span className="line-count">{bingoLines} / 5 줄</span></h3>
              <div className="bingo-board">
                {board.map((num, idx) => renderCell(num, idx, true, myCompletedCells))}
              </div>
            </div>

            {enemyBoard.length > 0 && (showOpponentBoard || peekActive) && (
              <div className={`board-container ${peekActive ? 'peeking' : ''}`}>
                <h3 style={{ color: 'var(--accent)' }}>
                  {view === 'single' ? 'AI 보드' : '상대 보드'}
                  <span className="line-count">{enemyBingoLines} / 5 줄</span>
                </h3>
                <div className="bingo-board">
                  {enemyBoard.map((num, idx) => renderCell(num, idx, false, enemyCompletedCells))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {status !== '' && view !== 'menu' && (
        <div className={`result-overlay ${status === 'You Win!' ? 'win' : status === '무승부!' ? 'draw' : 'lose'}`}>
          <div className="result-card">
            <h2>{status}</h2>
            <button className="btn" onClick={leaveGame}>메뉴로 돌아가기</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;