'use strict';
// 讓電腦玩家自己對打，檢查規則引擎沒有破綻：node sim.js [局數]

const G = require('./game');
const Bot = require('./bot');

const N = Number(process.argv[2]) || 300;
let stalls = 0;
let illegal = 0;
const stats = {};

function checkInvariants(g, start) {
  for (const c of G.ALL) {
    const sum = g.bank[c] + g.players.reduce((s, p) => s + p.tokens[c], 0);
    if (sum !== start[c]) throw new Error(`星砂數量不守恆 ${c}: ${sum} != ${start[c]}`);
    if (g.bank[c] < 0 || g.players.some((p) => p.tokens[c] < 0)) throw new Error('出現負數星砂');
  }
  for (const p of g.players) {
    if (g.phase !== 'discard' && G.totalTokens(p) > G.HAND_LIMIT) throw new Error('超過持有上限');
    if (p.reserved.length > G.MAX_RESERVE) throw new Error('預約超過上限');
    const pts = p.cards.reduce((s, c) => s + c.points, 0) + p.patrons.reduce((s, x) => s + x.points, 0);
    if (pts !== p.points) throw new Error('聲望計算不一致');
  }
  const cards = g.players.reduce((s, p) => s + p.cards.length + p.reserved.length, 0)
    + [1, 2, 3].reduce((s, t) => s + g.decks[t].length + g.market[t].filter(Boolean).length, 0);
  if (cards !== 90) throw new Error(`卡牌總數不對：${cards}`);
}

for (let i = 0; i < N; i++) {
  const n = 2 + (i % 3);
  const players = Array.from({ length: n }, (_, k) => ({ id: `p${k}`, name: `B${k}`, bot: true }));
  const g = G.createGame(players, 1000 + i);
  const start = { ...g.bank };
  let steps = 0;
  while (g.phase !== 'over' && steps < 2000) {
    const pid = g.players[g.turn].id;
    let r = G.applyAction(g, pid, Bot.chooseAction(g, pid));
    if (r.error) {
      illegal++;
      r = G.applyAction(g, pid, Bot.fallback(g, pid));
      if (r.error) throw new Error(`保底行動也失敗：${r.error}`);
    }
    checkInvariants(g, start);
    steps++;
  }
  if (g.phase !== 'over') { stalls++; continue; }
  const s = stats[n] || (stats[n] = { games: 0, rounds: 0, top: 0, passEnd: 0 });
  s.games++; s.rounds += g.round;
  s.top += Math.max(...g.players.map((p) => p.points));
  if (!g.finalRound) s.passEnd++;
  // 視角檢查：別人的盲抽預約不能外流
  const v = G.view(g, g.players[0].id);
  for (const p of v.players.slice(1)) for (const r of p.reserved) if (r.hidden && r.card) throw new Error('盲抽預約外流');
}

for (const n of Object.keys(stats)) {
  const s = stats[n];
  console.log(`${n} 人：${s.games} 局，平均 ${(s.rounds / s.games).toFixed(1)} 輪，冠軍平均 ${(s.top / s.games).toFixed(1)} 聲望，僵局收場 ${s.passEnd}`);
}
console.log(`未完成 ${stalls} 局，不合法行動 ${illegal} 次`);
if (stalls || illegal) process.exit(1);
