'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

const CELL      = 30;
const BW        = 10;
const BH        = 20;
const DAS_DELAY = 160;
const DAS_RATE  = 50;

const ACTION_MAP = {
  ArrowLeft: 'left', ArrowRight: 'right',
  ArrowUp:   'rotate',
  ArrowDown: 'hard', ' ': 'hard',
};

// ── State ─────────────────────────────────────────────────────────────────────

let ws          = null;
let myHandle    = null;   // chosen handle
let myIdx       = null;   // 0 or 1 within the current game
let gameHandles = null;   // [handle0, handle1]
let state       = null;   // latest game state msg
let lobbyState  = null;

// ── DOM ───────────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

// screens
const sLogin = $('s-login');
const sLobby = $('s-lobby');
const sGame  = $('s-game');

// login
const handleIn = $('handle-in');
const joinBtn  = $('join-btn');
const loginErr = $('login-err');

// lobby
const lobMe       = $('lob-me');
const lobIncoming = $('lob-incoming');
const lobList     = $('lob-list');
const lobEmpty    = $('lob-empty');

// game overlay
const overlay = $('overlay');
const omsg    = $('omsg');

// game desktop panel
const scoreEl  = $('score');
const levelEl  = $('level');
const linesEl  = $('lines');
const p1El     = $('p1score');
const p2El     = $('p2score');

// game mobile bar
const mScore  = $('m-score');
const mLevel  = $('m-level');
const mLines  = $('m-lines');
const mStand  = $('m-standings');

// game board
const roleBadge  = $('role-badge');
const turnBanner = $('turn-banner');
const canvas     = $('board');
const ctx        = canvas.getContext('2d');

// ── Screen management ─────────────────────────────────────────────────────────

function showScreen(name) {
  sLogin.style.display = name === 'login' ? '' : 'none';
  sLobby.style.display = name === 'lobby' ? '' : 'none';
  sGame.style.display  = name === 'game'  ? '' : 'none';
  document.body.style.overflow = name === 'game' ? 'hidden' : '';
  if (name === 'game') requestAnimationFrame(scaleGameToFit);
}

// ── Mobile scaling ────────────────────────────────────────────────────────────

let _resizeTimer = null;

function scaleGameToFit() {
  if (!window.matchMedia('(pointer: coarse)').matches && window.innerWidth > 540) return;

  canvas.style.width  = '';
  canvas.style.height = '';

  const NATURAL_H = 600, NATURAL_W = 300;
  const els = [$('mob-bar'), $('role-badge'), $('turn-banner'), $('touch-ctrls')];
  els.forEach(el => { if (el) el.style.width = ''; });

  const fixedH = els.reduce((s, el) => s + (el?.offsetHeight || 0), 0) + 20;
  const scale  = Math.min(1, (window.innerHeight - fixedH) / NATURAL_H, window.innerWidth / NATURAL_W);

  const dispW = Math.round(NATURAL_W * scale);
  const dispH = Math.round(NATURAL_H * scale);
  canvas.style.width  = dispW + 'px';
  canvas.style.height = dispH + 'px';

  const colW = dispW + 'px';
  els.forEach(el => { if (el) el.style.width = colW; });
}

window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(scaleGameToFit, 150);
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = e => onMsg(JSON.parse(e.data));
  ws.onclose   = () => { loginErr.textContent = 'Disconnected — refresh to reconnect'; showScreen('login'); };
  ws.onerror   = () => { loginErr.textContent = 'Connection error'; showScreen('login'); };
}

function onMsg(msg) {
  switch (msg.type) {

    case 'error':
      loginErr.textContent = msg.message;
      break;

    case 'joined_lobby':
      myHandle = msg.handle;
      lobMe.textContent = myHandle;
      showScreen('lobby');
      break;

    case 'lobby_state':
      lobbyState = msg;
      renderLobby();
      break;

    case 'challenge_declined':
      // lobby_state follows and will clear the outgoing indicator
      break;

    case 'game_start':
      myIdx       = msg.your_idx;
      gameHandles = msg.handles;
      state       = null;
      const isTetris = myIdx === 0;
      roleBadge.textContent = isTetris ? 'TETRIS PLAYER' : 'SABOTEUR';
      roleBadge.className   = isTetris ? 'is-tetris' : 'is-saboteur';
      turnBanner.textContent = 'YOUR TURN';
      turnBanner.className   = 'my-turn';
      showScreen('game');
      const myRole = isTetris ? 'Your role is to play normally and get a high score!'
                              : 'You are the SABOTEUR - be unhelpful!';
      const opRole = isTetris ? `${gameHandles[1]} is the SABOTEUR`
                              : `${gameHandles[0]} is the TETRIS PLAYER`;
      showOverlay('Get Ready!',
        `${gameHandles[0]} vs ${gameHandles[1]}\n\n${myRole}\n${opRole}\n\nRoles swap for Phase 2`);
      break;

    case 'state':
      state = msg;
      renderGame();
      break;

    case 'phase_end': {
      const s = scoreLabel(msg.scores);
      showOverlay('Phase 1 complete!', `${s}\n\nRoles switch — Phase 2 starting…`);
      break;
    }

    case 'gameover': {
      const myScore = msg.scores[myHandle] ?? 0;
      const opHandle = gameHandles[1 - myIdx];
      const opScore  = msg.scores[opHandle] ?? 0;
      const result   = msg.winner == null ? "It's a tie!"
                     : msg.winner === myHandle ? 'You win!'
                     : `${msg.winner} wins!`;
      showOverlay('Game Over',
        `${result}\n\nYou (${myHandle}): ${myScore}\n${opHandle}: ${opScore}\n\nReturning to lobby…`);
      break;
    }

    case 'opponent_left': {
      const opHandle = gameHandles ? gameHandles[1 - myIdx] : 'Opponent';
      const s = msg.scores
        ? `You: ${msg.scores[myHandle]??0}  ${opHandle}: ${msg.scores[opHandle]??0}`
        : '';
      showOverlay('Opponent left', `${opHandle} disconnected.\n${s}\n\nReturning to lobby…`);
      break;
    }

    case 'returned_to_lobby':
      myIdx = null; gameHandles = null; state = null;
      showScreen('lobby');
      break;
  }
}

function scoreLabel(scores) {
  if (!gameHandles) return '';
  return `${gameHandles[0]}: ${scores[0]}   ${gameHandles[1]}: ${scores[1]}`;
}

// ── Login ─────────────────────────────────────────────────────────────────────

function tryJoin() {
  const h = handleIn.value.trim();
  if (!h) return;
  loginErr.textContent = '';
  ws.send(JSON.stringify({ type: 'join_lobby', handle: h }));
}

joinBtn.addEventListener('click', tryJoin);
handleIn.addEventListener('keydown', e => { if (e.key === 'Enter') tryJoin(); });

// ── Lobby ─────────────────────────────────────────────────────────────────────

function renderLobby() {
  const { players, outgoing, incoming } = lobbyState;

  // Incoming challenges
  lobIncoming.innerHTML = '';
  incoming.forEach(challenger => {
    const d = document.createElement('div');
    d.className = 'challenge-alert';
    const sp = document.createElement('span');
    sp.textContent = `⚡ ${challenger} challenges you!`;
    const acc = document.createElement('button');
    acc.className = 'btn-accept';
    acc.textContent = 'Accept';
    acc.addEventListener('click', () =>
      ws.send(JSON.stringify({ type: 'accept', challenger })));
    const dec = document.createElement('button');
    dec.className = 'btn-decline';
    dec.textContent = 'Decline';
    dec.addEventListener('click', () =>
      ws.send(JSON.stringify({ type: 'decline', challenger })));
    d.append(sp, acc, dec);
    lobIncoming.appendChild(d);
  });

  // Player list
  lobList.innerHTML = '';
  const others = players.filter(p => p.handle !== myHandle);
  lobEmpty.style.display = others.length === 0 ? '' : 'none';

  // Show self first
  const selfPlayer = players.find(p => p.handle === myHandle);
  if (selfPlayer) lobList.appendChild(makePlayerRow(selfPlayer, outgoing));
  others.forEach(p => lobList.appendChild(makePlayerRow(p, outgoing)));
}

function makePlayerRow(p, outgoing) {
  const row = document.createElement('div');
  row.className = 'player-row' + (p.handle === myHandle ? ' player-me' : '');

  const name = document.createElement('span');
  name.className = 'p-handle';
  name.textContent = p.handle + (p.handle === myHandle ? ' (you)' : '');
  row.appendChild(name);

  if (p.handle !== myHandle) {
    if (p.status === 'in_game') {
      const st = document.createElement('span');
      st.className = 'p-status-ingame';
      st.textContent = 'In game';
      row.appendChild(st);
    } else if (outgoing === p.handle) {
      const st = document.createElement('span');
      st.className = 'p-status-waiting';
      st.textContent = 'Challenge sent…';
      row.appendChild(st);
      const cancel = document.createElement('button');
      cancel.className = 'p-btn-cancel';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () =>
        ws.send(JSON.stringify({ type: 'cancel_challenge' })));
      row.appendChild(cancel);
    } else {
      const btn = document.createElement('button');
      btn.className = 'p-btn';
      btn.textContent = 'Challenge';
      btn.disabled = !!outgoing; // already have an outgoing challenge
      btn.addEventListener('click', () =>
        ws.send(JSON.stringify({ type: 'challenge', target: p.handle })));
      row.appendChild(btn);
    }
  }
  return row;
}

// ── Game overlay ──────────────────────────────────────────────────────────────

function showOverlay(title, body = '') {
  overlay.style.display = 'flex';
  omsg.textContent = body ? `${title}\n\n${body}` : title;
}
function hideOverlay() { overlay.style.display = 'none'; }

// ── Game rendering ────────────────────────────────────────────────────────────

function isMyTurn() { return state && state.controller === myIdx; }

function renderGame() {
  if (!state || !gameHandles) return;
  if (state.phase === 'playing') hideOverlay();

  const isTetris = state.tetrisIdx === myIdx;
  const op = gameHandles[1 - myIdx];

  roleBadge.textContent = isTetris
    ? `TETRIS PLAYER — vs ${op} — Phase ${state.phaseNum}/2`
    : `SABOTEUR — vs ${op} — Phase ${state.phaseNum}/2`;
  roleBadge.className = isTetris ? 'is-tetris' : 'is-saboteur';

  turnBanner.textContent = isMyTurn() ? 'YOUR TURN' : "OPPONENT'S TURN";
  turnBanner.className   = isMyTurn() ? 'my-turn'   : 'opp-turn';

  // Desktop scores
  scoreEl.textContent = state.scores[myIdx] ?? 0;
  levelEl.textContent = state.level;
  linesEl.textContent = state.lines;
  p1El.textContent = `${gameHandles[0]}: ${state.scores[0]}`;
  p2El.textContent = `${gameHandles[1]}: ${state.scores[1]}`;

  // Mobile bar
  mScore.textContent = state.scores[myIdx] ?? 0;
  mLevel.textContent = state.level;
  mLines.textContent = state.lines;
  mStand.textContent =
    `${gameHandles[0]}: ${state.scores[0]}  ${gameHandles[1]}: ${state.scores[1]}`;

  drawBoard();
}

function collides(board, shape, x, y) {
  for (let r = 0; r < shape.length; r++)
    for (let c = 0; c < shape[r].length; c++) {
      if (!shape[r][c]) continue;
      const br = y+r, bc = x+c;
      if (bc < 0 || bc >= BW || br >= BH) return true;
      if (br >= 0 && board[br] && board[br][bc]) return true;
    }
  return false;
}

function drawBoard() {
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = '#1c1c1c';
  ctx.lineWidth = 1;
  for (let r = 0; r <= BH; r++) {
    ctx.beginPath(); ctx.moveTo(0, r*CELL); ctx.lineTo(BW*CELL, r*CELL); ctx.stroke();
  }
  for (let c = 0; c <= BW; c++) {
    ctx.beginPath(); ctx.moveTo(c*CELL, 0); ctx.lineTo(c*CELL, BH*CELL); ctx.stroke();
  }

  if (!state) return;
  const { board, piece } = state;

  for (let r = 0; r < BH; r++)
    for (let c = 0; c < BW; c++)
      if (board[r][c]) drawCell(c, r, board[r][c], 1);

  if (piece) drawPiece(piece.shape, piece.x, piece.y, piece.color, 1);

  if (!isMyTurn()) {
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}

function drawCell(col, row, color, alpha) {
  if (row < 0) return;
  const x = col*CELL+1, y = row*CELL+1, s = CELL-2;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, s, s);
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.fillRect(x, y, s, 3);
  ctx.fillRect(x, y, 3, s);
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(x, y+s-3, s, 3);
  ctx.fillRect(x+s-3, y, 3, s);
  ctx.globalAlpha = 1;
}

function drawPiece(shape, x, y, color, alpha) {
  for (let r = 0; r < shape.length; r++)
    for (let c = 0; c < shape[r].length; c++)
      if (shape[r][c]) drawCell(x+c, y+r, color, alpha);
}

// ── Keyboard controls ─────────────────────────────────────────────────────────

function sendMove(action) {
  if (!state || state.phase !== 'playing' || !isMyTurn()) return;
  ws.send(JSON.stringify({ type: 'move', action }));
}

const held = {};

document.addEventListener('keydown', e => {
  const action = ACTION_MAP[e.key];
  if (!action) return;
  e.preventDefault();
  if (held[e.key]) return;
  held[e.key] = true;
  sendMove(action);

  if (action === 'left' || action === 'right') {
    const t = setTimeout(() => {
      const iv = setInterval(() => {
        if (!held[e.key]) { clearInterval(iv); return; }
        sendMove(action);
      }, DAS_RATE);
      held[e.key + '_iv'] = iv;
    }, DAS_DELAY);
    held[e.key + '_t'] = t;
  }
});

document.addEventListener('keyup', e => {
  if (!ACTION_MAP[e.key]) return;
  held[e.key] = false;
  clearTimeout(held[e.key + '_t']);
  clearInterval(held[e.key + '_iv']);
});

// ── Touch controls ────────────────────────────────────────────────────────────

function addTouch(id, action, repeat) {
  const el = $(id);
  if (!el) return;
  let timer = null, interval = null;

  el.addEventListener('touchstart', e => {
    e.preventDefault();
    sendMove(action);
    if (repeat) {
      timer = setTimeout(() => {
        interval = setInterval(() => sendMove(action), DAS_RATE);
      }, DAS_DELAY);
    }
  }, { passive: false });

  const stop = e => {
    e.preventDefault();
    clearTimeout(timer);
    clearInterval(interval);
  };
  el.addEventListener('touchend',    stop, { passive: false });
  el.addEventListener('touchcancel', stop, { passive: false });
}

addTouch('tc-left',  'left',   true);
addTouch('tc-right', 'right',  true);
addTouch('tc-rot',   'rotate', false);
addTouch('tc-drop',  'hard',   false);

// ── Boot ──────────────────────────────────────────────────────────────────────

showScreen('login');
connect();
