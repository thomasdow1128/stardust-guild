'use strict';
// 星砂商會 — 規則引擎（純邏輯，不含連線）

const COLORS = ['r', 'b', 'g', 'y', 'v'];
const ALL = ['r', 'b', 'g', 'y', 'v', 'w'];
const COLOR_NAME = { r: '赤焰', b: '蒼潮', g: '翠林', y: '琥珀', v: '夜幕', w: '星塵' };
const TIER_NAME = { 1: '學徒', 2: '匠師', 3: '宗師' };
const GOAL = 15;
const HAND_LIMIT = 10;
const MAX_RESERVE = 3;

// c: 花費（由高到低，顏色於開局時隨機分配） p: 聲望 gift: 建造時贈送星塵
const PATTERNS = {
  1: [
    { c: [1, 1, 1], p: 0, name: '小攤' },
    { c: [2, 1], p: 0, name: '爐台' },
    { c: [2, 2], p: 0, name: '磨坊' },
    { c: [3], p: 0, name: '工棚' },
    { c: [1, 1, 1, 1], p: 0, name: '窯口' },
    { c: [2, 1, 1], p: 0, name: '織架' },
    { c: [2, 2, 1], p: 0, gift: 1, name: '渡口' },
    { c: [4], p: 1, name: '學舍' },
  ],
  2: [
    { c: [3, 2, 2], p: 1, name: '匠鋪' },
    { c: [4, 2], p: 1, gift: 1, name: '商棧' },
    { c: [3, 3, 2], p: 2, name: '熔廳' },
    { c: [4, 3, 1], p: 2, name: '藏閣' },
    { c: [5], p: 2, name: '觀臺' },
    { c: [6], p: 3, name: '行會' },
  ],
  3: [
    { c: [4, 3, 3, 3], p: 3, name: '星塔' },
    { c: [7], p: 4, name: '秘殿' },
    { c: [6, 4, 2], p: 4, name: '天穹院' },
    { c: [7, 4], p: 5, name: '王座' },
  ],
};

const PATRON_NAMES = ['北辰', '天狼', '織女', '南斗', '玄鳥', '青鸞', '白澤', '燭龍', '麒麟', '參宿'];
const PATRON_PATTERNS = [[4, 4], [4, 4], [4, 4], [4, 4], [3, 3, 3], [3, 3, 3], [3, 3, 3], [3, 3, 3], [2, 2, 2, 2], [2, 2, 2, 2]];

function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, R) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(R() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function genCards(R) {
  const cards = [];
  for (const tier of [1, 2, 3]) {
    PATTERNS[tier].forEach((pt, idx) => {
      for (const color of COLORS) {
        const others = shuffle(COLORS.filter((c) => c !== color), R);
        const cost = {};
        pt.c.forEach((n, i) => { cost[others[i]] = n; });
        cards.push({ id: `${tier}${color}${idx}`, tier, color, points: pt.p, gift: pt.gift || 0, name: pt.name, cost });
      }
    });
  }
  return cards;
}

function genPatrons(R) {
  const names = shuffle(PATRON_NAMES.slice(), R);
  return PATRON_PATTERNS.map((pt, i) => {
    const cs = shuffle(COLORS.slice(), R);
    const req = {};
    pt.forEach((n, k) => { req[cs[k]] = n; });
    return { id: `p${i}`, name: names[i], points: 3, req };
  });
}

const zero = () => ({ r: 0, b: 0, g: 0, y: 0, v: 0, w: 0 });

function createGame(playerInfos, seed) {
  const n = playerInfos.length;
  const R = makeRng(seed);
  const decks = { 1: [], 2: [], 3: [] };
  for (const c of genCards(R)) decks[c.tier].push(c);
  const market = {};
  for (const t of [1, 2, 3]) {
    shuffle(decks[t], R);
    market[t] = decks[t].splice(0, 4);
  }
  const per = n === 2 ? 4 : n === 3 ? 5 : 7;
  const bank = { r: per, b: per, g: per, y: per, v: per, w: 5 };
  const patrons = shuffle(genPatrons(R), R).slice(0, n + 1);
  const order = shuffle(playerInfos.slice(), R);
  const g = {
    seed, n, decks, market, bank, patrons,
    players: order.map((p) => ({
      id: p.id, name: p.name, bot: !!p.bot,
      tokens: zero(), bonus: zero(), cards: [], reserved: [], patrons: [], points: 0,
    })),
    turn: 0, round: 1, phase: 'play', finalRound: false, winners: null, passes: 0, log: [], seq: 0,
  };
  log(g, null, `開局：${g.players.map((p) => p.name).join(' → ')}`);
  return g;
}

function log(g, pid, text) {
  g.log.push({ pid, text });
  if (g.log.length > 80) g.log.shift();
}

const err = (m) => ({ error: m });
const totalTokens = (p) => ALL.reduce((s, c) => s + p.tokens[c], 0);
const tokStr = (cs) => cs.map((c) => `{${c}}`).join('');
const cardStr = (c) => `{${c.color}}${COLOR_NAME[c.color]}${c.name}`;

// 計算付款：先用該色星砂，不足以星塵補
function payment(p, card) {
  const pay = zero();
  let wild = 0;
  for (const c of COLORS) {
    const need = Math.max(0, (card.cost[c] || 0) - p.bonus[c]);
    const use = Math.min(need, p.tokens[c]);
    pay[c] = use;
    wild += need - use;
  }
  pay.w = wild;
  return { pay, ok: wild <= p.tokens.w };
}

function findMarket(g, id) {
  for (const t of [1, 2, 3]) {
    const i = g.market[t].findIndex((c) => c && c.id === id);
    if (i >= 0) return { t, i };
  }
  return null;
}

function takeFromMarket(g, loc) {
  const card = g.market[loc.t][loc.i];
  g.market[loc.t][loc.i] = g.decks[loc.t].shift() || null;
  return card;
}

function applyAction(g, pid, a) {
  if (!a || typeof a !== 'object') return err('無效的行動');
  if (g.phase === 'over') return err('這局已經結束');
  const p = g.players[g.turn];
  if (p.id !== pid) return err('還沒輪到你');
  let r;
  if (g.phase === 'discard') {
    if (a.type !== 'discard') return err('請先歸還多出來的星砂');
    r = doDiscard(g, p, a);
  } else if (a.type === 'take') r = doTake(g, p, a);
  else if (a.type === 'reserve') r = doReserve(g, p, a);
  else if (a.type === 'buy') r = doBuy(g, p, a);
  else if (a.type === 'pass') r = doPass(g, p);
  else return err('無效的行動');
  if (!r.error) g.seq++;
  return r;
}

function doTake(g, p, a) {
  const cs = a.colors;
  if (!Array.isArray(cs) || cs.length < 1 || cs.length > 3) return err('一次拿 1 到 3 枚星砂');
  if (cs.some((c) => !COLORS.includes(c))) return err('星塵只能靠預約取得');
  const uniq = new Set(cs);
  if (uniq.size === cs.length) {
    for (const c of cs) if (g.bank[c] < 1) return err(`${COLOR_NAME[c]}砂已經拿完了`);
  } else {
    if (cs.length !== 2) return err('只能拿 3 枚不同色，或 2 枚同色');
    if (g.bank[cs[0]] < 4) return err('該色剩 4 枚以上才能一次拿 2 枚');
  }
  for (const c of cs) { g.bank[c]--; p.tokens[c]++; }
  g.passes = 0;
  log(g, p.id, `${p.name} 拿取 ${tokStr(cs)}`);
  return endTurn(g, p);
}

function doReserve(g, p, a) {
  if (p.reserved.length >= MAX_RESERVE) return err(`最多預約 ${MAX_RESERVE} 張`);
  let card;
  let hidden = false;
  if (typeof a.cardId === 'string') {
    const loc = findMarket(g, a.cardId);
    if (!loc) return err('這張牌已經不在市集上');
    card = takeFromMarket(g, loc);
  } else if ([1, 2, 3].includes(a.tier)) {
    if (!g.decks[a.tier].length) return err('這疊牌已經抽完');
    card = g.decks[a.tier].shift();
    hidden = true;
  } else return err('無效的行動');
  p.reserved.push({ card, hidden });
  let got = '';
  if (g.bank.w > 0) { g.bank.w--; p.tokens.w++; got = `，獲得 {w}`; }
  g.passes = 0;
  log(g, p.id, hidden ? `${p.name} 從${TIER_NAME[card.tier]}牌庫盲抽預約${got}` : `${p.name} 預約 ${cardStr(card)}${got}`);
  return endTurn(g, p);
}

function doBuy(g, p, a) {
  if (typeof a.cardId !== 'string') return err('無效的行動');
  const ri = p.reserved.findIndex((r) => r.card.id === a.cardId);
  const loc = ri < 0 ? findMarket(g, a.cardId) : null;
  if (ri < 0 && !loc) return err('這張牌已經不在市集上');
  const card = ri >= 0 ? p.reserved[ri].card : g.market[loc.t][loc.i];
  const { pay, ok } = payment(p, card);
  if (!ok) return err('星砂不夠，還蓋不起這張');
  for (const c of ALL) { p.tokens[c] -= pay[c]; g.bank[c] += pay[c]; }
  if (ri >= 0) p.reserved.splice(ri, 1); else takeFromMarket(g, loc);
  p.cards.push(card);
  p.bonus[card.color]++;
  p.points += card.points;
  let extra = card.points ? `（+${card.points} 聲望）` : '';
  if (card.gift && g.bank.w > 0) { g.bank.w--; p.tokens.w++; extra += `，獲贈 {w}`; }
  g.passes = 0;
  log(g, p.id, `${p.name} 建造 ${cardStr(card)}${extra}`);
  return endTurn(g, p);
}

function doPass(g, p) {
  g.passes++;
  log(g, p.id, `${p.name} 跳過這回合`);
  return finishTurn(g, p);
}

function doDiscard(g, p, a) {
  const cs = a.colors;
  const excess = totalTokens(p) - HAND_LIMIT;
  if (!Array.isArray(cs) || cs.length !== excess) return err(`需要歸還 ${excess} 枚`);
  const cnt = zero();
  for (const c of cs) {
    if (!ALL.includes(c)) return err('無效的星砂');
    cnt[c]++;
    if (cnt[c] > p.tokens[c]) return err('你沒有那麼多可以歸還');
  }
  for (const c of cs) { p.tokens[c]--; g.bank[c]++; }
  log(g, p.id, `${p.name} 歸還 ${tokStr(cs)}`);
  return finishTurn(g, p);
}

function endTurn(g, p) {
  if (totalTokens(p) > HAND_LIMIT) { g.phase = 'discard'; return { ok: true }; }
  return finishTurn(g, p);
}

function finishTurn(g, p) {
  const idx = g.patrons.findIndex((pt) => COLORS.every((c) => p.bonus[c] >= (pt.req[c] || 0)));
  if (idx >= 0) {
    const pt = g.patrons.splice(idx, 1)[0];
    p.patrons.push(pt);
    p.points += pt.points;
    log(g, p.id, `星宿「${pt.name}」降臨 ${p.name} 的商會（+${pt.points} 聲望）`);
  }
  if (p.points >= GOAL && !g.finalRound) {
    g.finalRound = true;
    log(g, null, `${p.name} 達到 ${GOAL} 聲望，這一輪結束後結算`);
  }
  g.phase = 'play';
  g.turn = (g.turn + 1) % g.n;
  if (g.turn === 0) {
    if (g.finalRound || g.passes >= g.n * 2) return finish(g);
    g.round++;
  }
  return { ok: true };
}

function finish(g) {
  g.phase = 'over';
  const best = Math.max(...g.players.map((p) => p.points));
  let top = g.players.filter((p) => p.points === best);
  const fewest = Math.min(...top.map((p) => p.cards.length));
  top = top.filter((p) => p.cards.length === fewest);
  g.winners = top.map((p) => p.id);
  log(g, null, `結算：${top.map((p) => p.name).join('、')} 以 ${best} 聲望勝出`);
  return { ok: true };
}

// 送給某位玩家看的狀態：牌庫內容與他人盲抽的預約牌不外流
function view(g, pid) {
  return {
    goal: GOAL, limit: HAND_LIMIT, maxReserve: MAX_RESERVE,
    round: g.round, phase: g.phase, finalRound: g.finalRound, seq: g.seq,
    turn: g.players[g.turn].id,
    bank: g.bank, market: g.market, patrons: g.patrons,
    decks: { 1: g.decks[1].length, 2: g.decks[2].length, 3: g.decks[3].length },
    players: g.players.map((p) => ({
      id: p.id, name: p.name, bot: p.bot, tokens: p.tokens, bonus: p.bonus, points: p.points,
      cardCount: p.cards.length, patrons: p.patrons,
      reserved: p.reserved.map((r) => (r.hidden && p.id !== pid
        ? { hidden: true, tier: r.card.tier }
        : { card: r.card, hidden: r.hidden })),
    })),
    log: g.log.slice(-50), winners: g.winners,
  };
}

module.exports = {
  COLORS, ALL, COLOR_NAME, TIER_NAME, GOAL, HAND_LIMIT, MAX_RESERVE,
  createGame, applyAction, payment, totalTokens, view,
};
