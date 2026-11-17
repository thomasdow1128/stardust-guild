'use strict';
// 星砂商會 — 連線伺服器（零相依：node server.js）
// 房間制，狀態用 Server-Sent Events 即時推送，行動用 POST 送出。

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const Game = require('./game');
const Bot = require('./bot');

const PORT = Number(process.env.PORT) || 3777;
const PUBLIC = path.join(__dirname, 'public');
const MAX_PLAYERS = 4;
const AWAY_AUTOPLAY_MS = 20000; // 離線玩家輪到時，等這麼久後由電腦代打
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const BOT_NAMES = ['阿燼', '小潮', '翠翠', '珀爺', '夜梟', '塵子'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const rooms = new Map();

const newId = () => crypto.randomBytes(6).toString('hex');
const cleanName = (s) => String(s || '').replace(/[{}<>&"']/g, '').trim().slice(0, 12) || '旅人';

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}

function addPlayer(room, name, bot) {
  const p = { id: newId(), token: crypto.randomBytes(16).toString('hex'), name, bot: !!bot };
  room.players.push(p);
  return p;
}

const isOnline = (room, pid) => (room.clients.get(pid)?.size || 0) > 0;

function roomView(room, pid) {
  return {
    room: room.code, you: pid, host: room.hostId, max: MAX_PLAYERS,
    players: room.players.map((p) => ({ id: p.id, name: p.name, bot: p.bot, online: p.bot || isOnline(room, p.id) })),
    game: room.game ? Game.view(room.game, pid) : null,
  };
}

function broadcast(room) {
  for (const [pid, set] of room.clients) {
    if (!set.size) continue;
    const msg = `data: ${JSON.stringify(roomView(room, pid))}\n\n`;
    for (const res of set) res.write(msg);
  }
}

// 推送最新狀態，並在需要時安排電腦行動
function tick(room) {
  room.lastActive = Date.now();
  broadcast(room);
  clearTimeout(room.timer);
  room.timer = null;
  const g = room.game;
  if (!g || g.phase === 'over') return;
  const cur = g.players[g.turn];
  let delay;
  if (cur.bot) delay = 700 + Math.random() * 700;
  else if (!isOnline(room, cur.id)) delay = AWAY_AUTOPLAY_MS;
  else return;
  room.timer = setTimeout(() => {
    room.timer = null;
    if (room.game !== g || g.phase === 'over' || g.players[g.turn].id !== cur.id) return tick(room);
    if (!cur.bot && isOnline(room, cur.id)) return undefined;
    const r = Game.applyAction(g, cur.id, Bot.chooseAction(g, cur.id));
    if (r.error) Game.applyAction(g, cur.id, Bot.fallback(g, cur.id));
    return tick(room);
  }, delay);
}

function closeClients(room, pid, payload) {
  const set = room.clients.get(pid);
  if (!set) return;
  for (const res of set) {
    if (payload) res.write(`data: ${JSON.stringify(payload)}\n\n`);
    res.end();
  }
  room.clients.delete(pid);
}

function destroyRoom(room) {
  clearTimeout(room.timer);
  for (const pid of [...room.clients.keys()]) closeClients(room, pid, { closed: true });
  rooms.delete(room.code);
}

function startGame(room) {
  room.game = Game.createGame(room.players.map((p) => ({ id: p.id, name: p.name, bot: p.bot })), crypto.randomInt(2 ** 31));
}

function removePlayer(room, pl) {
  if (room.game && room.game.phase !== 'over') {
    // 對局中離開：座位交給電腦代打
    pl.bot = true;
    const gp = room.game.players.find((p) => p.id === pl.id);
    if (gp) gp.bot = true;
    room.game.log.push({ pid: null, text: `${pl.name} 離開了，由電腦接手` });
    room.game.seq++;
  } else {
    room.players = room.players.filter((p) => p !== pl);
    if (room.game) room.game = null; // 結算畫面有人離開就回到大廳
  }
  const humans = room.players.filter((p) => !p.bot);
  if (!humans.length) return destroyRoom(room);
  if (!humans.some((p) => p.id === room.hostId)) room.hostId = humans[0].id;
  return undefined;
}

function roomAction(room, pl, a) {
  const isHost = pl.id === room.hostId;
  const playing = room.game && room.game.phase !== 'over';
  switch (a.type) {
    case 'addBot': {
      if (!isHost) return { error: '只有房主可以加入電腦' };
      if (room.game) return { error: '對局已經開始' };
      if (room.players.length >= MAX_PLAYERS) return { error: '房間滿了' };
      const used = new Set(room.players.map((p) => p.name));
      addPlayer(room, BOT_NAMES.find((n) => !used.has(n)) || '電腦', true);
      return { ok: true };
    }
    case 'kick': {
      if (!isHost) return { error: '只有房主可以移除玩家' };
      if (room.game) return { error: '對局已經開始' };
      const target = room.players.find((p) => p.id === a.pid);
      if (!target || target.id === pl.id) return { error: '找不到這位玩家' };
      room.players = room.players.filter((p) => p !== target);
      closeClients(room, target.id, { kicked: true });
      return { ok: true };
    }
    case 'start':
    case 'again': {
      if (!isHost) return { error: '只有房主可以開始' };
      if (playing) return { error: '對局已經開始' };
      if (room.players.length < 2) return { error: '至少要 2 位玩家，可以先加入電腦' };
      startGame(room);
      return { ok: true };
    }
    case 'lobby': {
      if (!isHost) return { error: '只有房主可以回到大廳' };
      if (playing) return { error: '對局還在進行' };
      room.game = null;
      return { ok: true };
    }
    case 'leave': {
      closeClients(room, pl.id, { left: true });
      removePlayer(room, pl);
      return { ok: true };
    }
    default:
      if (!room.game) return { error: '對局還沒開始' };
      return Game.applyAction(room.game, pl.id, a);
  }
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => {
      s += d;
      if (s.length > 10000) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function auth(body) {
  const room = rooms.get(String(body.room || '').toUpperCase());
  const pl = room && room.players.find((p) => !p.bot && p.token === body.token);
  return pl ? { room, pl } : null;
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/events' && req.method === 'GET') {
    const a = auth({ room: url.searchParams.get('room'), token: url.searchParams.get('token') });
    if (!a) { res.writeHead(404); return res.end(); }
    const { room, pl } = a;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 1500\n\n');
    let set = room.clients.get(pl.id);
    if (!set) { set = new Set(); room.clients.set(pl.id, set); }
    set.add(res);
    req.on('close', () => {
      set.delete(res);
      if (rooms.get(room.code) === room) tick(room);
    });
    return tick(room);
  }
  if (req.method !== 'POST') return send(res, 405, { error: '不支援的請求' });
  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: '請求格式錯誤' }); }

  if (url.pathname === '/api/create') {
    const room = { code: newCode(), players: [], clients: new Map(), game: null, timer: null, lastActive: Date.now(), hostId: null };
    const pl = addPlayer(room, cleanName(body.name), false);
    room.hostId = pl.id;
    rooms.set(room.code, room);
    return send(res, 200, { room: room.code, token: pl.token });
  }
  if (url.pathname === '/api/join') {
    const room = rooms.get(String(body.room || '').toUpperCase());
    if (!room) return send(res, 404, { error: '找不到這個房號，請確認後再試' });
    if (room.game) return send(res, 409, { error: '這間房已經開打了，等下一局再加入' });
    if (room.players.length >= MAX_PLAYERS) return send(res, 409, { error: '房間滿了' });
    let name = cleanName(body.name);
    if (room.players.some((p) => p.name === name)) name = `${name.slice(0, 10)}${room.players.length + 1}`;
    const pl = addPlayer(room, name, false);
    tick(room);
    return send(res, 200, { room: room.code, token: pl.token });
  }
  if (url.pathname === '/api/check') {
    return auth(body) ? send(res, 200, { ok: true }) : send(res, 404, { error: '房間已經不存在' });
  }
  if (url.pathname === '/api/act') {
    const a = auth(body);
    if (!a) return send(res, 404, { error: '房間已經不存在，請重新加入' });
    const r = roomAction(a.room, a.pl, body.action || {});
    if (r && r.error) return send(res, 400, r);
    if (rooms.get(a.room.code) === a.room) tick(a.room);
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: '找不到這個功能' });
}

function handleStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('找不到頁面'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    return res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url).catch(() => { if (!res.headersSent) send(res, 500, { error: '伺服器出了點問題' }); });
  }
  return handleStatic(req, res, url);
});

// 保持連線、清掉閒置房間
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const set of room.clients.values()) for (const res of set) res.write(': hb\n\n');
    if (now - room.lastActive > ROOM_TTL_MS) destroyRoom(room);
  }
}, 20000).unref();

server.listen(PORT, () => {
  console.log(`星砂商會已開張： http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) console.log(`同網路的朋友可連： http://${ni.address}:${PORT}`);
  }
});
