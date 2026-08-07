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

function App() {
  const [view, setView] = useState('menu'); // 'menu', 'single', 'multi', 'settings'
  const [board, setBoard] = useState([]);
  const [opponents, setOpponents] = useState({}); // { [socketId]: { board, bingoLines } }
  const [showOpponentBoard, setShowOpponentBoard] = useState(false);
  const [markedNumbers, setMarkedNumbers] = useState([]);
  const [turn, setTurn] = useState(0); // 0, 1, 2, ...
  const [playerRole, setPlayerRole] = useState(0); // 0: Host, 1..N: Clients
  const [playerCount, setPlayerCount] = useState(1);
  const [readyCount, setReadyCount] = useState(0);
  const [status, setStatus] = useState('');
  const [localIp, setLocalIp] = useState('Loading...');
  const [hostIpInput, setHostIpInput] = useState('');
  const [socket, setSocket] = useState(null);
  
  const processingRef = useRef(false);

  const [bingoLines, setBingoLines] = useState(0);

  // ---- 신규 기능 상태 ----
  const [theme, setTheme] = useState(() => localStorage.getItem('bingo-theme') || 'classic');
  const soundOn = true; // 강제 켜짐 (버튼 제거)
  const [comboMsg, setComboMsg] = useState(null); // 콤보(2줄 이상 동시완성) 알림
  const [justMarked, setJustMarked] = useState(null); // 방금 마킹된 숫자(애니메이션 트리거용)
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
      setOpponents({
        'ai': { board: generateBoard(), bingoLines: 0 }
      });
    } else {
      setOpponents({});
    }

    setMarkedNumbers([]);
    setTurn(0);
    setBingoLines(0);
    setShowOpponentBoard(false);
    setComboMsg(null);
    prevLinesRef.current = 0;

    return newBoard;
  };

  const checkWinCondition = (myLines, opps) => {
    // 승/패/무승부 조건 제거 (사용자 요청)
    // 게임이 끝나도 계속 진행할 수 있도록 아무것도 하지 않음
  };

  useEffect(() => {
    const myLines = checkBingo(board, markedNumbers);
    setBingoLines(myLines);

    let updatedOpps = { ...opponents };
    for (const id in updatedOpps) {
      updatedOpps[id].bingoLines = checkBingo(updatedOpps[id].board, markedNumbers);
    }
    
    // Only update if it actually changed, to avoid infinite loops, but since it's just checkBingo it's fast
    // Let's just mutate and trigger effect? Actually, we must setState.
    // Wait, setting state in useEffect depending on same state can loop.
    // We'll setOpponents safely.
    setOpponents(prev => {
      let changed = false;
      const next = { ...prev };
      for (const id in next) {
        const lines = checkBingo(next[id].board, markedNumbers);
        if (next[id].bingoLines !== lines) {
          next[id] = { ...next[id], bingoLines: lines };
          changed = true;
        }
      }
      return changed ? next : prev;
    });

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
      checkWinCondition(myLines, opponents);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markedNumbers, board]);

  useEffect(() => {
    // Release the click lock whenever the turn changes
    processingRef.current = false;
  }, [turn]);

  // AI Turn Logic for Single Player
  useEffect(() => {
    if (view === 'single' && turn === 1 && status === '') {
      const timer = setTimeout(() => {
        const aiBoard = opponents['ai']?.board;
        if (!aiBoard) return;
        const available = aiBoard.filter(n => !markedNumbers.includes(n));
        if (available.length > 0) {
          const pick = available[Math.floor(Math.random() * available.length)];
          handleMarkNumber(pick, false); // AI's selection
        }
      }, 1000);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn, view, status, opponents, markedNumbers]);

  const handleMarkNumber = (number, isUserClick = false) => {
    if (status !== '') return;
    if (markedNumbers.includes(number)) return;
    if (processingRef.current) return;

    if (view === 'single') {
      if (turn === 1 && !isUserClick) {
        // AI's turn (triggered programmatically, NOT by user click)
        processingRef.current = true;
        setJustMarked(number);
        if (soundOn) SFX.mark();
        setMarkedNumbers(prev => [...prev, number]);
        setTurn(0);
      } else if (turn === playerRole && isUserClick) {
        // Player's turn (must be a user click)
        processingRef.current = true;
        setJustMarked(number);
        if (soundOn) SFX.mark();
        setMarkedNumbers(prev => [...prev, number]);
        setTurn(1);
      }
    } else if (view === 'multi' && socket) {
      if (turn === playerRole && isUserClick) {
        processingRef.current = true;
        setJustMarked(number);
        if (soundOn) SFX.mark();
        socket.emit('mark-number', number);
      }
    }
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
      setPlayerRole(data.role); // 0 (host) or 1..N
      setView('multi');
      initGame(false);
      setStatus('Waiting for other player...');
    });

    newSocket.on('lobby-update', (data) => {
      setPlayerCount(data.playerCount);
      setReadyCount(data.readyPlayers || 0);
    });

    newSocket.emit('ready', board);

    newSocket.on('game-start', (data) => {
      setTurn(data.turn);
      setStatus('');
      
      const newOpps = {};
      Object.keys(data.boards).forEach(id => {
        if (id !== newSocket.id) {
          newOpps[id] = { board: data.boards[id], bingoLines: 0 };
        }
      });
      setOpponents(newOpps);
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

  const getOpponentStatusStr = () => {
    if (view === 'single') return turn === 1 ? 'AI의 차례' : '상대방 차례대기';
    if (turn === playerRole) return '당신의 차례';
    return `플레이어 ${turn + 1}의 차례`;
  };

  const renderCell = (num, idx, isMine, completedSet, isEnemy = false) => {
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
        onClick={() => isMine && handleMarkNumber(num, true)}
        style={{ cursor: isMine ? 'pointer' : 'default' }}
        onAnimationEnd={() => { if (isFresh) setJustMarked(null); }}
      >
        <span className="cell-number">{isEnemy ? '' : num}</span>
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

      {view === 'settings' && (
        <div className="classic-panel main-menu">
          <h2>설정</h2>
          
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
          
          <button className="btn outline" onClick={() => setView('menu')} style={{ marginTop: '2rem' }}>뒤로 가기</button>
        </div>
      )}

      {view === 'menu' && (
        <div className="classic-panel main-menu">
          <h1>PLAY BINGO</h1>
          {isElectron && (
            <p style={{ textAlign: 'center', marginBottom: '0.75rem', color: 'var(--text-muted)' }}>
              내 IP: {localIp}
            </p>
          )}

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

          <button className="btn outline" onClick={() => setView('settings')} style={{ marginTop: '1rem' }}>설정 (테마)</button>

          {status && <p style={{ color: 'var(--accent)', textAlign: 'center' }}>{status}</p>}
        </div>
      )}

      {(view === 'single' || view === 'multi') && status === 'Waiting for other player...' && (
        <div className="classic-panel main-menu">
          <h2>대기실</h2>
          <p style={{ textAlign: 'center', marginBottom: '1rem', color: 'var(--text-muted)' }}>
            현재 {playerCount}명 접속 중 (준비: {readyCount}명)
          </p>
          {playerRole === 0 ? (
            <button className="btn accent" onClick={() => socket?.emit('start-game-manual')}>게임 시작</button>
          ) : (
            <p style={{ textAlign: 'center' }}>방장이 게임을 시작할 때까지 기다려주세요...</p>
          )}
          <button className="btn outline" onClick={leaveGame} style={{ marginTop: '1rem' }}>나가기</button>
        </div>
      )}

      {(view === 'single' || view === 'multi') && status !== 'Waiting for other player...' && (
        <div className="classic-panel game-panel">
          <div className="game-header">
            <h2>{status !== '' ? status : (turn === playerRole ? '당신의 차례' : getOpponentStatusStr())}</h2>
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <button className="btn outline" onClick={() => setShowOpponentBoard(!showOpponentBoard)}>
                {showOpponentBoard ? '상대 보드 숨기기' : '상대 보드 보기'}
              </button>
              <button className="btn accent" onClick={leaveGame} style={{ margin: 0, width: '120px' }}>
                나가기
              </button>
            </div>
          </div>

          <div className="game-layout">
            <div className="board-container">
              <h3>내 보드 <span className="line-count">{bingoLines} / 5 줄</span></h3>
              <div className="bingo-board">
                {board.map((num, idx) => renderCell(num, idx, true, myCompletedCells, false))}
              </div>
            </div>
          </div>
        </div>
      )}

      {Object.keys(opponents).length > 0 && showOpponentBoard && (
        <div className="opponent-popup-overlay" onClick={() => setShowOpponentBoard(false)}>
          <div className="opponent-popup-card" onClick={(e) => e.stopPropagation()}>
            <div className="opponent-boards-wrapper">
              {Object.keys(opponents).map((id, index) => {
                const opp = opponents[id];
                const oppCompletedCells = getCompletedCellIndices(opp.board, markedNumbers);
                return (
                  <div key={id} style={{ marginBottom: '2rem' }}>
                    <h3>
                      {view === 'single' ? 'AI 보드' : `플레이어 ${index + 1} (상대)`}
                      <span className="line-count">{opp.bingoLines} / 5 줄</span>
                    </h3>
                    <div className="bingo-board">
                      {opp.board.map((num, idx) => renderCell(num, idx, false, oppCompletedCells, true))}
                    </div>
                  </div>
                );
              })}
            </div>
            <button className="btn outline opponent-popup-close" onClick={() => setShowOpponentBoard(false)}>
              닫기
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;