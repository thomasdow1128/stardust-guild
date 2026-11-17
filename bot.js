'use strict';
// 星砂商會 — 電腦玩家（啟發式）

const G = require('./game');
const { COLORS } = G;

function analyse(g, p) {
  const cands = [];
  for (const t of [1, 2, 3]) for (const c of g.market[t]) if (c) cands.push({ card: c, src: 'market' });
  for (const r of p.reserved) cands.push({ card: r.card, src: 'reserved' });
  const built = p.cards.length;
  const bonusValue = Math.max(0.6, 3 - built * 0.25); // 前期重視折扣，後期重視聲望
  const pointValue = 2 + built * 0.15;

  return cands.map(({ card, src }) => {
    let need = 0;
    let short = 0;
    let unreach = 0;
    const shortBy = {};
    const needBy = {};
    for (const c of COLORS) {
      const n = Math.max(0, (card.cost[c] || 0) - p.bonus[c]);
      const s = Math.max(0, n - p.tokens[c]);
      needBy[c] = n; shortBy[c] = s; need += n; short += s;
      unreach += Math.max(0, s - g.bank[c]);
    }
    const missing = Math.max(0, short - p.tokens.w);
    const blocked = missing > 0 && unreach > p.tokens.w; // 公庫補不齊缺口
    let value = card.points * pointValue + bonusValue + (card.gift ? 0.6 : 0) + (src === 'reserved' ? 1 : 0);
    for (const pt of g.patrons) {
      if ((pt.req[card.color] || 0) > p.bonus[card.color]) {
        const left = COLORS.reduce((s, c) => s + Math.max(0, (pt.req[c] || 0) - p.bonus[c]), 0);
        value += left === 1 ? 3 * pointValue : 2.4 / left + 0.3;
      }
    }
    if (p.points + card.points >= G.GOAL) value += 60;
    let turns = 1 + missing / 2.5;
    if (blocked) turns += 4;
    if (need > G.HAND_LIMIT) turns += 50; // 手上放不下這麼多星砂
    return { card, src, need, needBy, shortBy, missing, blocked, ok: missing === 0, value, rate: value / turns };
  });
}

const best = (list, key) => list.reduce((a, b) => (!a || b[key] > a[key] ? b : a), null);

function gather(g, p, evals, target) {
  const avail = COLORS.filter((c) => g.bank[c] > 0);
  if (!avail.length) return null;
  const want = target
    ? avail.filter((c) => target.shortBy[c] > 0).sort((a, b) => target.shortBy[b] - target.shortBy[a])
    : [];
  if (want.length === 1 && target.shortBy[want[0]] >= 2 && g.bank[want[0]] >= 4) {
    return { type: 'take', colors: [want[0], want[0]] };
  }
  const pick = want.slice(0, 3);
  if (pick.length < 3) {
    const score = {};
    for (const c of avail) score[c] = 0;
    for (const e of evals) for (const c of avail) if (e.shortBy[c] > 0) score[c] += e.rate;
    const rest = avail.filter((c) => !pick.includes(c)).sort((a, b) => score[b] - score[a]);
    while (pick.length < 3 && rest.length) pick.push(rest.shift());
  }
  return { type: 'take', colors: pick };
}

function pickDiscards(g, p) {
  const evals = analyse(g, p);
  const target = best(evals.filter((e) => !e.ok), 'rate') || best(evals, 'rate');
  const keep = target ? target.needBy : {};
  const hand = { ...p.tokens };
  const out = [];
  let excess = G.totalTokens(p) - G.HAND_LIMIT;
  while (excess > 0) {
    let bc = null;
    let bs = -Infinity;
    for (const c of COLORS) {
      if (hand[c] > 0) {
        const s = hand[c] - (keep[c] || 0);
        if (s > bs) { bs = s; bc = c; }
      }
    }
    if (!bc) bc = 'w';
    hand[bc]--; out.push(bc); excess--;
  }
  return out;
}

function chooseAction(g, pid) {
  const p = g.players.find((x) => x.id === pid);
  if (g.phase === 'discard') return { type: 'discard', colors: pickDiscards(g, p) };

  const evals = analyse(g, p);
  const top = best(evals, 'rate');
  if (top && top.ok) return { type: 'buy', cardId: top.card.id };

  // 手上快滿或目標被卡住時，先蓋買得起的，把星砂放回公庫
  const tot = G.totalTokens(p);
  const affordable = best(evals.filter((e) => e.ok), 'value');
  if (affordable && (tot >= 8 || !top || top.blocked)) return { type: 'buy', cardId: affordable.card.id };

  if (top && top.src === 'market' && p.reserved.length < G.MAX_RESERVE) {
    const reachable = COLORS.some((c) => top.shortBy[c] > 0 && g.bank[c] > 0);
    if (tot >= 9 || !reachable) return { type: 'reserve', cardId: top.card.id };
  }

  if (tot >= G.HAND_LIMIT && (!top || top.blocked)) return { type: 'pass' }; // 拿了也只能原樣歸還

  const take = gather(g, p, evals, top);
  if (take) return take;

  if (affordable) return { type: 'buy', cardId: affordable.card.id };
  if (p.reserved.length < G.MAX_RESERVE) {
    const m = best(evals.filter((e) => e.src === 'market'), 'rate');
    if (m) return { type: 'reserve', cardId: m.card.id };
  }
  return { type: 'pass' };
}

// 保底：萬一啟發式給出不合法的行動
function fallback(g, pid) {
  const p = g.players.find((x) => x.id === pid);
  if (g.phase === 'discard') {
    const out = [];
    const hand = { ...p.tokens };
    let excess = G.totalTokens(p) - G.HAND_LIMIT;
    for (const c of G.ALL) while (excess > 0 && hand[c] > 0) { hand[c]--; out.push(c); excess--; }
    return { type: 'discard', colors: out };
  }
  return { type: 'pass' };
}

module.exports = { chooseAction, fallback };
