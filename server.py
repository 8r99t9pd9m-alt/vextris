#!/usr/bin/env python3
import asyncio, json, os, re, random
from aiohttp import web, WSMsgType

PORT      = int(os.environ.get('PORT', 3000))
BOARD_W   = 10
BOARD_H   = 20
PHASE_SEC = 3 * 60

HANDLE_RE = re.compile(r'^[\w\s\-]{2,15}$')

# ── Pure game logic ───────────────────────────────────────────────────────────

SHAPES = {
    'I': [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
    'O': [[1,1],[1,1]],
    'T': [[0,1,0],[1,1,1],[0,0,0]],
    'S': [[0,1,1],[1,1,0],[0,0,0]],
    'Z': [[1,1,0],[0,1,1],[0,0,0]],
    'J': [[1,0,0],[1,1,1],[0,0,0]],
    'L': [[0,0,1],[1,1,1],[0,0,0]],
}
COLORS = {
    'I':'#00f0f0','O':'#f0f000','T':'#a000f0',
    'S':'#00f000','Z':'#f00000','J':'#0000f0','L':'#f0a000',
}
ALL_PIECES = list(SHAPES.keys())

def empty_board():
    return [[None]*BOARD_W for _ in range(BOARD_H)]

def rotate_cw(shape):
    rows, cols = len(shape), len(shape[0])
    return [[shape[rows-1-r][c] for r in range(rows)] for c in range(cols)]

def collides(board, shape, x, y):
    for r, row in enumerate(shape):
        for c, cell in enumerate(row):
            if not cell: continue
            br, bc = y+r, x+c
            if bc < 0 or bc >= BOARD_W or br >= BOARD_H: return True
            if br >= 0 and board[br][bc]: return True
    return False

def lock_piece(board, piece):
    b = [row[:] for row in board]
    for r, row in enumerate(piece['shape']):
        for c, cell in enumerate(row):
            if cell and piece['y']+r >= 0:
                b[piece['y']+r][piece['x']+c] = piece['color']
    return b

def clear_lines(board):
    kept = [row for row in board if any(cell is None for cell in row)]
    n = BOARD_H - len(kept)
    return [[None]*BOARD_W for _ in range(n)] + kept, n

def line_score(n, level):
    return [0,100,300,500,800][min(n,4)] * level

def rand_type():
    return random.choice(ALL_PIECES)

def make_piece(ptype):
    shape = SHAPES[ptype]
    return {'type':ptype,'shape':shape,'color':COLORS[ptype],
            'x':(BOARD_W-len(shape[0]))//2,'y':-1}

def fall_sec(level):
    return max(0.08, 1.0-(level-1)*0.08)

# ── Game instance ─────────────────────────────────────────────────────────────

class GameInstance:
    def __init__(self, lobby, handles, sockets):
        self.lobby   = lobby
        self.handles = list(handles)
        self.sockets = list(sockets)
        self.G       = None
        self._fall_t = self._phase_t = self._switch_t = None

    def _tidx(self): return 0 if self.G['phase_num'] == 1 else 1
    def _sidx(self): return 1 if self.G['phase_num'] == 1 else 0

    def _state_msg(self):
        G = self.G
        return {
            'type':'state','phase':G['phase'],'phaseNum':G['phase_num'],
            'board':G['board'],'piece':G['piece'],'controller':G['controller'],
            'level':G['level'],'lines':G['lines'],'scores':G['scores'],
            'tetrisIdx':self._tidx(),'saboteurIdx':self._sidx(),
        }

    async def _bcast(self, msg):
        s = json.dumps(msg)
        for ws in self.sockets:
            try: await ws.send_str(s)
            except Exception: pass

    def _cancel_fall(self):
        if self._fall_t:   self._fall_t.cancel();   self._fall_t   = None
    def _cancel_phase(self):
        if self._phase_t:  self._phase_t.cancel();  self._phase_t  = None
    def _cancel_switch(self):
        if self._switch_t: self._switch_t.cancel(); self._switch_t = None
    def _cancel_all(self):
        self._cancel_fall(); self._cancel_phase(); self._cancel_switch()

    async def start(self):
        self.G = {
            'phase':'starting','phase_num':1,'scores':[0,0],
            'board':empty_board(),'piece':None,'controller':0,
            'piece_count':0,'level':1,'lines':0,
        }
        for i, (h, ws) in enumerate(zip(self.handles, self.sockets)):
            try:
                await ws.send_str(json.dumps({
                    'type':'game_start','your_idx':i,'handles':self.handles,
                }))
            except Exception: pass
        await asyncio.sleep(3)
        if self.G:
            await self._start_phase()

    async def _start_phase(self):
        G = self.G
        G.update({'phase':'playing','board':empty_board(),'level':1,'lines':0,
                  'piece_count':0,'controller':self._tidx(),
                  'piece':make_piece(rand_type())})
        self._phase_t = asyncio.create_task(self._phase_timer())
        self._schedule_fall()
        await self._bcast(self._state_msg())

    def _schedule_fall(self):
        self._cancel_fall()
        self._fall_t = asyncio.create_task(self._fall_tick())

    async def _fall_tick(self):
        try:
            await asyncio.sleep(fall_sec(self.G['level']))
            G = self.G
            if not G or G['phase'] != 'playing' or not G['piece']: return
            p = G['piece']
            if not collides(G['board'], p['shape'], p['x'], p['y']+1):
                G['piece'] = {**p, 'y': p['y']+1}
                await self._bcast(self._state_msg())
                self._schedule_fall()
            else:
                await self._do_lock()
        except asyncio.CancelledError:
            pass

    async def _phase_timer(self):
        try:
            await asyncio.sleep(PHASE_SEC)
            await self._end_phase('time')
        except asyncio.CancelledError:
            pass

    async def _do_lock(self):
        G = self.G
        if not G: return
        p = G['piece']
        if p is None: return

        if p['y'] < 0:
            G['piece'] = None
            await self._end_phase('topout')
            return

        G['board'] = lock_piece(G['board'], p)
        G['board'], cleared = clear_lines(G['board'])
        G['lines'] += cleared
        G['level']  = G['lines'] // 10 + 1
        if cleared:
            G['scores'][self._tidx()] += line_score(cleared, G['level'])

        G['piece_count'] += 1
        G['controller'] = self._sidx() if G['piece_count']%3==1 else self._tidx()
        G['piece'] = make_piece(rand_type())

        if collides(G['board'], G['piece']['shape'], G['piece']['x'], G['piece']['y']):
            G['piece'] = None
            await self._end_phase('topout')
            return

        await self._bcast(self._state_msg())
        self._schedule_fall()

    async def _end_phase(self, reason):
        self._cancel_phase(); self._cancel_fall()
        G = self.G
        if G['phase_num'] == 1:
            G['phase'] = 'switching'
            await self._bcast({'type':'phase_end','reason':reason,'scores':G['scores']})
            self._switch_t = asyncio.create_task(self._switch_phase())
        else:
            G['phase'] = 'gameover'
            s0, s1 = G['scores']
            wi     = 0 if s0>s1 else (1 if s1>s0 else -1)
            winner = self.handles[wi] if wi >= 0 else None
            await self._bcast({
                'type':'gameover',
                'scores':{self.handles[0]:s0, self.handles[1]:s1},
                'winner':winner,
            })
            asyncio.create_task(self._finish(4))

    async def _switch_phase(self):
        try:
            await asyncio.sleep(5)
            if self.G:
                self.G['phase_num'] = 2
                await self._start_phase()
        except asyncio.CancelledError:
            pass

    async def _finish(self, delay):
        try:
            await asyncio.sleep(delay)
            await self.lobby.game_ended(self)
        except asyncio.CancelledError:
            pass

    async def apply_move(self, handle, action):
        G = self.G
        if not G or G['phase'] != 'playing': return
        try: pidx = self.handles.index(handle)
        except ValueError: return
        if pidx != G['controller'] or not G['piece']: return

        p = G['piece']
        shape, x, y = p['shape'], p['x'], p['y']

        if action == 'left':
            if not collides(G['board'], shape, x-1, y): G['piece'] = {**p,'x':x-1}
        elif action == 'right':
            if not collides(G['board'], shape, x+1, y): G['piece'] = {**p,'x':x+1}
        elif action == 'rotate':
            rot = rotate_cw(shape)
            for ox in [0,-1,1,-2,2]:
                if not collides(G['board'], rot, x+ox, y):
                    G['piece'] = {**p,'shape':rot,'x':x+ox}; break
        elif action == 'hard':
            dy = y
            while not collides(G['board'], shape, x, dy+1): dy += 1
            G['scores'][self._tidx()] += (dy-y)*2
            G['piece'] = {**p,'y':dy}
            self._cancel_fall()
            await self._do_lock()
            return

        await self._bcast(self._state_msg())

    async def handle_disconnect(self, handle):
        self._cancel_all()
        G = self.G
        scores = {self.handles[0]:G['scores'][0],self.handles[1]:G['scores'][1]} if G else {}
        for i, h in enumerate(self.handles):
            if h != handle:
                try:
                    await self.sockets[i].send_str(json.dumps({
                        'type':'opponent_left','scores':scores,
                    }))
                except Exception: pass
        await self.lobby.game_ended(self)

# ── Lobby ─────────────────────────────────────────────────────────────────────

class Lobby:
    def __init__(self):
        self.players    = {}
        self.challenges = {}

    async def handler(self, request):
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)

        handle = None
        try:
            try:
                msg = await asyncio.wait_for(ws.receive(), timeout=60)
            except asyncio.TimeoutError:
                return ws

            if msg.type != WSMsgType.TEXT:
                return ws

            data = json.loads(msg.data)
            if data.get('type') != 'join_lobby':
                await ws.send_str(json.dumps({'type':'error','message':'Send join_lobby first'}))
                return ws

            candidate = data.get('handle','').strip()
            if not HANDLE_RE.match(candidate):
                await ws.send_str(json.dumps({'type':'error',
                    'message':'Name must be 2–15 chars (letters, numbers, space, hyphen, underscore)'}))
                return ws
            if candidate in self.players:
                if self.players[candidate]['ws'].closed:
                    await self._player_left(candidate)  # evict stale session
                else:
                    await ws.send_str(json.dumps({'type':'error','message':'That name is already taken'}))
                    return ws

            handle = candidate
            self.players[handle] = {'ws':ws,'game':None}
            await ws.send_str(json.dumps({'type':'joined_lobby','handle':handle}))
            await self._bcast_lobby()

            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    try: await self._on_msg(handle, json.loads(msg.data))
                    except Exception: pass

        except Exception:
            pass
        finally:
            if handle and self.players.get(handle, {}).get('ws') is ws:
                await self._player_left(handle)

        return ws

    async def _on_msg(self, handle, msg):
        mtype  = msg.get('type')
        player = self.players.get(handle)
        if not player: return

        if mtype == 'move' and player['game']:
            await player['game'].apply_move(handle, msg.get('action'))

        elif mtype == 'challenge':
            target   = msg.get('target','')
            t_player = self.players.get(target)
            if (t_player and not t_player['game']
                    and target != handle and not player['game']):
                self.challenges[handle] = target
                await self._bcast_lobby()

        elif mtype == 'cancel_challenge':
            if self.challenges.pop(handle, None) is not None:
                await self._bcast_lobby()

        elif mtype == 'accept':
            challenger = msg.get('challenger','')
            if (self.challenges.get(challenger) == handle
                    and not player['game']
                    and not self.players.get(challenger,{}).get('game')):
                await self._start_game(challenger, handle)

        elif mtype == 'decline':
            challenger = msg.get('challenger','')
            if self.challenges.get(challenger) == handle:
                del self.challenges[challenger]
                c = self.players.get(challenger)
                if c:
                    try: await c['ws'].send_str(json.dumps({'type':'challenge_declined','by':handle}))
                    except Exception: pass
                await self._bcast_lobby()

    async def _start_game(self, h0, h1):
        self.challenges = {
            k:v for k,v in self.challenges.items()
            if k not in (h0,h1) and v not in (h0,h1)
        }
        ws0, ws1 = self.players[h0]['ws'], self.players[h1]['ws']
        game = GameInstance(self, [h0,h1], [ws0,ws1])
        self.players[h0]['game'] = game
        self.players[h1]['game'] = game
        await self._bcast_lobby()
        asyncio.create_task(game.start())

    async def game_ended(self, game):
        for h in game.handles:
            p = self.players.get(h)
            if p and p['game'] is game:
                p['game'] = None
                try: await p['ws'].send_str(json.dumps({'type':'returned_to_lobby'}))
                except Exception: pass
        await self._bcast_lobby()

    async def _player_left(self, handle):
        player = self.players.pop(handle, None)
        if not player: return
        if player['game']:
            await player['game'].handle_disconnect(handle)
        self.challenges.pop(handle, None)
        self.challenges = {k:v for k,v in self.challenges.items() if v != handle}
        await self._bcast_lobby()

    async def _bcast_lobby(self):
        all_players = [
            {'handle':h,'status':'in_game' if p['game'] else 'waiting'}
            for h,p in self.players.items()
        ]
        for handle, player in list(self.players.items()):
            if player['game']: continue
            incoming = [c for c,t in self.challenges.items() if t == handle]
            msg = {
                'type':'lobby_state',
                'players':all_players,
                'outgoing':self.challenges.get(handle),
                'incoming':incoming,
            }
            try: await player['ws'].send_str(json.dumps(msg))
            except Exception: pass

# ── Entry point ───────────────────────────────────────────────────────────────

def local_ip():
    import socket
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('8.8.8.8', 80)); return s.getsockname()[0]
    except Exception: return None

async def main():
    public_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'public')
    lobby = Lobby()
    app = web.Application()
    index = os.path.join(public_dir, 'index.html')
    app.router.add_get('/ws', lobby.handler)
    app.router.add_get('/', lambda r: web.FileResponse(index))
    app.router.add_static('/', public_dir)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', PORT)
    await site.start()

    print('\nVextris running!\n')
    if ip := local_ip():
        print(f'  Network:   http://{ip}:{PORT}')
    print(f'  Localhost: http://localhost:{PORT}\n')
    await asyncio.Future()

if __name__ == '__main__':
    asyncio.run(main())
