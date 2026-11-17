(() => {
  'use strict';

  const COLORS = ['r', 'b', 'g', 'y', 'v'];
  const ALL = ['r', 'b', 'g', 'y', 'v', 'w'];
  const CN = { r: '赤焰', b: '蒼潮', g: '翠林', y: '琥珀', v: '夜幕', w: '星塵' };
  const TIER = { 1: '學徒', 2: '匠師', 3: '宗師' };
  const GLYPH = {
    r: '<path d="M12 3l9.5 17h-19z"/>',
    b: '<circle cx="12" cy="12" r="8.5"/>',
    g: '<path d="M4 20C4 9 9 4 20 4c0 11-5 16-16 16z"/>',
    y: '<path d="M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5z"/>',
    v: '<path d="M14.5 2.5a9.5 9.5 0 1 0 7 15.5 8.5 8.5 0 0 1-7-15.5z"/>',
    w: '<path d="M12 1.5l2.6 7.9 7.9 2.6-7.9 2.6-2.6 7.9-2.6-7.9L1.5 12l7.9-2.6z"/>',
  };

  const app = document.getElementById('app');
  const emptySel = () => ({ tokens: [], card: null, deck: null, discard: [] });
  const S = {
    screen: 'home', room: null, token: null, data: null, es: null,
    name: localStorage.getItem('sg_name') || '',
    code: (new URLSearchParams(location.search).get('room') || '').toUpperCase().slice(0, 4),
    sel: emptySel(), seen: new Set(), fresh: new Set(), ping: false,
    rules: false, busy: false, reconnecting: false, confirmLeave: false,
  };

  const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const glyph = (c) => `<svg class="gl" viewBox="0 0 24 24" aria-hidden="true">${GLYPH[c]}</svg>`;
  const sum = (o) => ALL.reduce((s, c) => s + o[c], 0);

  let toastTimer;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  async function api(path, body) {
    let r;
    try {
      r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw new Error('連不上伺服器，請檢查網路');
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error || '伺服器出了點問題');
    return j;
  }

  // ───────── 連線 ─────────

  function saveCreds() { sessionStorage.setItem('sg_creds', JSON.stringify({ room: S.room, token: S.token })); }

  function leaveLocal(msg) {
    if (S.es) { S.es.close(); S.es = null; }
    sessionStorage.removeItem('sg_creds');
    Object.assign(S, { screen: 'home', room: null, token: null, data: null, sel: emptySel(), seen: new Set(), confirmLeave: false, reconnecting: false });
    history.replaceState(null, '', '/');
    document.title = '星砂商會';
    render();
    if (msg) toast(msg);
  }

  function connect() {
    S.screen = 'room';
    history.replaceState(null, '', `/?room=${S.room}`);
    if (S.es) S.es.close();
    const es = new EventSource(`/api/events?room=${S.room}&token=${S.token}`);
    S.es = es;
    es.onopen = () => { if (S.reconnecting) { S.reconnecting = false; render(); } };
    es.onmessage = (ev) => {
      const d = JSON.parse(ev.data);
      if (d.kicked) return leaveLocal('房主把你移出了房間');
      if (d.closed) return leaveLocal('房間已經關閉');
      if (d.left) return leaveLocal('');
      const prev = S.data;
      S.data = d;
      const g = d.game;
      if (g) {
        const pg = prev && prev.game;
        if (!pg || pg.seq !== g.seq) S.sel = emptySel();
        const ids = [1, 2, 3].flatMap((t) => g.market[t].filter(Boolean).map((c) => c.id));
        S.fresh = new Set(ids.filter((id) => !S.seen.has(id)));
        S.seen = new Set(ids);
        const mine = g.turn === d.you && g.phase !== 'over';
        S.ping = mine && !(pg && pg.turn === d.you && pg.phase !== 'over');
        document.title = mine ? '輪到你了｜星砂商會' : '星砂商會';
      } else {
        S.seen = new Set();
        S.sel = emptySel();
        document.title = '星砂商會';
      }
      render();
      S.fresh = new Set();
      S.ping = false;
      return undefined;
    };
    es.onerror = async () => {
      if (S.es !== es) return;
      if (es.readyState === EventSource.CLOSED) {
        try { await api('/api/check', { room: S.room, token: S.token }); connect(); } catch { leaveLocal('房間已經不存在'); }
      } else if (!S.reconnecting) {
        S.reconnecting = true;
        render();
      }
    };
    render();
  }

  async function enter(kind) {
    const name = S.name.trim();
    if (!name) return toast('先取個名號');
    if (kind === 'join' && S.code.length !== 4) return toast('房號是 4 個字元');
    localStorage.setItem('sg_name', name);
    try {
      const r = await api(kind === 'create' ? '/api/create' : '/api/join', { name, room: S.code });
      S.room = r.room; S.token = r.token;
      saveCreds();
      connect();
    } catch (e) { toast(e.message); }
    return undefined;
  }

  async function act(action) {
    if (S.busy) return;
    S.busy = true;
    try { await api('/api/act', { room: S.room, token: S.token, action }); } catch (e) { toast(e.message); }
    S.busy = false;
  }

  // ───────── 規則判斷（只用來提示，伺服器才是裁判） ─────────

  function payInfo(me, card) {
    let wild = 0;
    const state = {};
    for (const c of COLORS) {
      const cost = card.cost[c] || 0;
      if (!cost) continue;
      const need = Math.max(0, cost - me.bonus[c]);
      const lack = Math.max(0, need - me.tokens[c]);
      wild += lack;
      state[c] = need === 0 ? 'free' : lack === 0 ? 'ok' : '';
    }
    return { ok: wild <= me.tokens.w, state };
  }

  function findCard(g, me, id) {
    for (const t of [1, 2, 3]) for (const c of g.market[t]) if (c && c.id === id) return { card: c, src: 'market' };
    for (const r of me.reserved) if (r.card && r.card.id === id) return { card: r.card, src: 'reserved' };
    return null;
  }

  // ───────── 畫面：首頁與大廳 ─────────

  function orbitHTML() {
    return `<div class="orbit" aria-hidden="true">${ALL.map((c, i) => `<span class="orbit-seat" style="--i:${i}"><span class="tok tok-${c}">${glyph(c)}</span></span>`).join('')}</div>`;
  }

  function homeHTML() {
    return `<main class="home">
      <div class="home-hero">${orbitHTML()}<h1 class="logo">星砂<br>商會</h1></div>
      <p class="lede">收集星砂，興建工坊，等星宿降臨。二到四人連線對戰，一局大約二十分鐘。</p>
      <div class="home-form">
        <label class="field"><span>你的名號</span><input id="name" maxlength="12" autocomplete="nickname" value="${esc(S.name)}" placeholder="例如：阿砂"></label>
        <button class="btn primary wide" data-act="create">開一間新房</button>
        <div class="joinrow">
          <label class="field"><span>朋友給的房號</span><input id="code" maxlength="4" autocapitalize="characters" autocomplete="off" value="${esc(S.code)}" placeholder="四個字元"></label>
          <button class="btn" data-act="join">加入房間</button>
        </div>
        <button class="link" data-act="rules">第一次玩？看規則</button>
      </div>
    </main>`;
  }

  function lobbyHTML(d) {
    const isHost = d.host === d.you;
    const seats = [];
    for (let i = 0; i < d.max; i++) {
      const p = d.players[i];
      if (p) {
        const tags = [p.id === d.host ? '房主' : '', p.bot ? '電腦' : '', p.id === d.you ? '你' : '', !p.online ? '離線' : ''].filter(Boolean);
        seats.push(`<li class="seat"><span class="seat-name">${esc(p.name)}</span>${tags.map((t) => `<span class="tag">${t}</span>`).join('')}
          ${isHost && p.id !== d.you ? `<button class="link seat-x" data-act="kick" data-pid="${p.id}">移除</button>` : ''}</li>`);
      } else {
        seats.push(`<li class="seat empty"><span class="seat-name">空位</span>${isHost ? '<button class="link seat-x" data-act="addbot">加入電腦</button>' : ''}</li>`);
      }
    }
    const n = d.players.length;
    return `<main class="lobby">
      <h1 class="logo small">星砂商會</h1>
      <div class="roomcode"><span>房號</span><b>${d.room}</b><button class="btn" data-act="copy">複製邀請連結</button></div>
      <ul class="seats">${seats.join('')}</ul>
      ${isHost
    ? `<button class="btn primary wide" data-act="start" ${n < 2 ? 'disabled' : ''}>開始對局</button>
       <p class="hint">${n < 2 ? '至少要 2 位玩家。把連結傳給朋友，或先加入電腦。' : `${n} 人對局，順位開局時隨機決定。`}</p>`
    : '<p class="hint">等房主開始對局。</p>'}
      <div class="lobby-links"><button class="link" data-act="rules">看規則</button><button class="link" data-act="leave">離開房間</button></div>
    </main>`;
  }

  // ───────── 畫面：對局 ─────────

  function cardHTML(card, o = {}) {
    const tag = o.act ? 'button' : 'div';
    const st = o.pay ? o.pay.state : {};
    const costs = COLORS.filter((c) => card.cost[c]).sort((a, b) => card.cost[b] - card.cost[a])
      .map((c) => `<span class="pip tok-${c} ${st[c] || ''}">${glyph(c)}<i>${card.cost[c]}</i></span>`).join('');
    const cls = ['card', `c-${card.color}`, o.mini ? 'mini' : '', o.pay && o.pay.ok ? 'can' : '', o.sel ? 'sel' : '', o.fresh ? 'fresh' : ''].filter(Boolean).join(' ');
    const label = `${CN[card.color]}${card.name}，${card.points} 聲望，花費 ${COLORS.filter((c) => card.cost[c]).map((c) => `${CN[c]} ${card.cost[c]}`).join('、')}`;
    return `<${tag} class="${cls}" ${o.act ? `data-act="${o.act}" data-id="${card.id}"` : ''} aria-label="${label}" title="${CN[card.color]}${card.name}${card.gift ? '（建造時送 1 星塵）' : ''}">
      <span class="card-top"><span class="pts">${card.points || ''}</span>${card.gift ? `<span class="gift">+${glyph('w')}</span>` : ''}<span class="bonus">${glyph(card.color)}</span></span>
      <span class="card-name">${card.name}</span>
      <span class="costs">${costs}</span>
    </${tag}>`;
  }

  function playerHTML(d, g, p) {
    const isMe = p.id === d.you;
    const isTurn = g.turn === p.id && g.phase !== 'over';
    const info = d.players.find((x) => x.id === p.id) || {};
    const discarding = isMe && isTurn && g.phase === 'discard';
    const tags = [isMe ? '你' : '', p.bot ? '電腦' : '', !p.bot && info.online === false ? '離線' : ''].filter(Boolean);
    const cols = ALL.map((c) => {
      const picked = discarding ? S.sel.discard.filter((x) => x === c).length : 0;
      const n = p.tokens[c] - picked;
      const tokTag = discarding ? 'button' : 'span';
      return `<div class="res">
        <span class="res-gl tok-${c}">${glyph(c)}</span>
        ${c === 'w' ? '<span class="res-bonus none"></span>' : `<span class="res-bonus tok-${c} ${p.bonus[c] ? '' : 'zero'}" title="${CN[c]}工坊 ${p.bonus[c]} 座">${p.bonus[c]}</span>`}
        <${tokTag} class="res-tok tok-${c} ${n ? '' : 'zero'}" ${discarding ? `data-act="mytok" data-c="${c}" ${n ? '' : 'disabled'} aria-label="歸還一枚${CN[c]}"` : `title="${CN[c]} ${n} 枚"`}>${n}</${tokTag}>
      </div>`;
    }).join('');
    const reserved = p.reserved.map((r) => {
      if (!r.card) return `<div class="card back mini t${r.tier}" title="盲抽的${TIER[r.tier]}牌"><span>${TIER[r.tier]}</span></div>`;
      if (!isMe) return cardHTML(r.card, { mini: true });
      return cardHTML(r.card, { mini: true, act: 'card', pay: payInfo(p, r.card), sel: S.sel.card === r.card.id });
    }).join('');
    return `<section class="pl ${isMe ? 'me' : ''} ${isTurn ? 'turn' : ''}">
      <header class="pl-head">
        <span class="pl-name">${esc(p.name)}</span>${tags.map((t) => `<span class="tag">${t}</span>`).join('')}
        ${isTurn ? '<span class="tag now">行動中</span>' : ''}
        <span class="pl-pts"><b>${p.points}</b><small>聲望</small></span>
      </header>
      <div class="res-grid">
        <div class="res res-labels"><span></span><span>工坊</span><span>星砂</span></div>
        ${cols}
      </div>
      <div class="pl-foot">
        <span class="pl-count">星砂 ${sum(p.tokens)}/${g.limit}</span>
        ${p.patrons.map((x) => `<span class="won">${glyph('w')}${x.name}</span>`).join('')}
      </div>
      ${p.reserved.length ? `<div class="pl-res"><span class="pl-res-label">預約</span>${reserved}</div>` : ''}
    </section>`;
  }

  function barHTML(d, g, me) {
    if (g.phase === 'over') return '';
    const cur = g.players.find((p) => p.id === g.turn);
    if (g.turn !== d.you) {
      return `<p class="bar-text">等 <b>${esc(cur.name)}</b> ${g.phase === 'discard' ? '歸還星砂' : '行動'}……</p>`;
    }
    const chips = (list, actName) => list.map((c, i) => `<button class="tok small tok-${c}" data-act="${actName}" data-i="${i}" aria-label="取消${CN[c]}">${glyph(c)}</button>`).join('');
    if (g.phase === 'discard') {
      const excess = sum(me.tokens) - g.limit;
      const left = excess - S.sel.discard.length;
      return `<p class="bar-text">手上超過 ${g.limit} 枚。${left > 0 ? `在你的面板點選要歸還的星砂，還要選 <b>${left}</b> 枚` : '選好了'}</p>
        <div class="bar-sel">${chips(S.sel.discard, 'undiscard')}</div>
        <button class="btn primary" data-act="confirm-discard" ${left === 0 ? '' : 'disabled'}>歸還 ${excess} 枚</button>`;
    }
    if (S.sel.card) {
      const f = findCard(g, me, S.sel.card);
      if (f) {
        const pay = payInfo(me, f.card);
        const full = me.reserved.length >= g.maxReserve;
        return `<p class="bar-text"><b>${CN[f.card.color]}${f.card.name}</b>${pay.ok ? '' : '　星砂還不夠'}</p>
          <button class="btn primary" data-act="buy" ${pay.ok ? '' : 'disabled'}>建造</button>
          ${f.src === 'market' ? `<button class="btn" data-act="reserve" ${full ? 'disabled' : ''}>${full ? '預約已滿' : `預約${g.bank.w > 0 ? '並拿星塵' : ''}`}</button>` : ''}
          <button class="btn ghost" data-act="clear">取消</button>`;
      }
    }
    if (S.sel.deck) {
      const full = me.reserved.length >= g.maxReserve;
      return `<p class="bar-text">從<b>${TIER[S.sel.deck]}</b>牌庫盲抽一張，只有你看得到</p>
        <button class="btn primary" data-act="reserve-deck" ${full ? 'disabled' : ''}>${full ? '預約已滿' : `預約${g.bank.w > 0 ? '並拿星塵' : ''}`}</button>
        <button class="btn ghost" data-act="clear">取消</button>`;
    }
    if (S.sel.tokens.length) {
      const t = S.sel.tokens;
      const over = sum(me.tokens) + t.length - g.limit;
      return `<div class="bar-sel">${chips(t, 'untake')}</div>
        <p class="bar-text">${over > 0 ? `拿了之後要歸還 ${over} 枚` : t.length === 1 ? '可以再選，或同色再點一次拿 2 枚' : ''}</p>
        <button class="btn primary" data-act="confirm-take">拿取 ${t.length} 枚</button>
        <button class="btn ghost" data-act="clear">取消</button>`;
    }
    return `<p class="bar-text"><b>輪到你了。</b>點公庫的星砂來拿取，或點一張牌來建造、預約。</p>
      <button class="btn ghost" data-act="pass">跳過</button>`;
  }

  function overHTML(d, g) {
    const rank = g.players.slice().sort((a, b) => b.points - a.points || a.cardCount - b.cardCount);
    const winners = g.players.filter((p) => g.winners.includes(p.id));
    const iWon = g.winners.includes(d.you);
    const isHost = d.host === d.you;
    return `<div class="overlay"><div class="dialog" role="dialog" aria-modal="true" aria-label="對局結果">
      <h2>${iWon ? '你的商會寫進了星圖' : `${winners.map((p) => esc(p.name)).join('、')} 的商會寫進了星圖`}</h2>
      <ol class="rank">${rank.map((p) => `<li class="${g.winners.includes(p.id) ? 'win' : ''}"><span class="rank-name">${esc(p.name)}${p.id === d.you ? '（你）' : ''}</span><span class="rank-meta">${p.cardCount} 座工坊${p.patrons.length ? `、${p.patrons.length} 位星宿` : ''}</span><b>${p.points}</b></li>`).join('')}</ol>
      ${isHost
    ? '<div class="dialog-actions"><button class="btn primary" data-act="again">再開一局</button><button class="btn" data-act="tolobby">回到大廳</button></div>'
    : '<p class="hint">等房主決定要不要再開一局。</p>'}
    </div></div>`;
  }

  function gameHTML(d) {
    const g = d.game;
    const mi = g.players.findIndex((p) => p.id === d.you);
    const me = g.players[mi];
    const others = g.players.slice(mi + 1).concat(g.players.slice(0, mi));
    const myTurn = g.turn === d.you && g.phase === 'play';
    const logHTML = g.log.map((l) => `<li class="${l.pid === d.you ? 'mine' : l.pid ? '' : 'sys'}">${esc(l.text).replace(/\{([rbgyvw])\}/g, (_, c) => `<span class="ldot tok-${c}">${glyph(c)}</span>`)}</li>`).join('');

    const patrons = g.patrons.map((pt) => {
      const met = COLORS.every((c) => me.bonus[c] >= (pt.req[c] || 0));
      return `<div class="patron ${met ? 'met' : ''}" title="工坊數量達標時自動降臨">
        <span class="patron-name">${pt.name}</span><span class="patron-pts">+${pt.points}</span>
        <span class="reqs">${COLORS.filter((c) => pt.req[c]).map((c) => `<span class="req tok-${c} ${me.bonus[c] >= pt.req[c] ? 'ok' : ''}">${glyph(c)}<i>${Math.min(me.bonus[c], pt.req[c])}/${pt.req[c]}</i></span>`).join('')}</span>
      </div>`;
    }).join('');

    const rows = [3, 2, 1].map((t) => `<div class="mrow">
      <button class="card back t${t} ${S.sel.deck === t ? 'sel' : ''}" data-act="deck" data-tier="${t}" ${g.decks[t] ? '' : 'disabled'} aria-label="${TIER[t]}牌庫，剩 ${g.decks[t]} 張">
        <span>${TIER[t]}</span><small>剩 ${g.decks[t]}</small>
      </button>
      ${g.market[t].map((c) => (c
    ? cardHTML(c, { act: 'card', pay: payInfo(me, c), sel: S.sel.card === c.id, fresh: S.fresh.has(c.id) })
    : '<div class="card slot" aria-hidden="true"></div>')).join('')}
    </div>`).join('');

    const bank = ALL.map((c) => {
      const picked = S.sel.tokens.filter((x) => x === c).length;
      return `<button class="tok tok-${c} ${picked ? 'picked' : ''}" data-act="bank" data-c="${c}" ${myTurn ? '' : 'disabled'} aria-label="${CN[c]}，公庫剩 ${g.bank[c]} 枚">
        ${glyph(c)}<b class="tok-n">${g.bank[c] - picked}</b><span class="tok-name">${CN[c]}</span>
      </button>`;
    }).join('');

    return `<div class="game">
      <header class="top">
        <span class="brand">星砂商會</span>
        <span class="top-meta">第 ${g.round} 輪　先到 ${g.goal} 聲望${g.finalRound && g.phase !== 'over' ? '　<b class="final">最後一輪</b>' : ''}${S.reconnecting ? '　<b class="final">重新連線中</b>' : ''}</span>
        <span class="top-links">
          <span class="top-room">房號 ${d.room}</span>
          <button class="link" data-act="copy">邀請</button>
          <button class="link" data-act="rules">規則</button>
          <button class="link" data-act="leave">${S.confirmLeave ? '確定離開？' : '離開'}</button>
        </span>
      </header>
      <aside class="players">${playerHTML(d, g, me)}<div class="opps">${others.map((p) => playerHTML(d, g, p)).join('')}</div></aside>
      <section class="board">
        <div class="bank ${myTurn ? '' : 'idle'}">${bank}</div>
        <div class="market">${rows}</div>
        <div class="patrons">${patrons || '<p class="hint">星宿都已降臨。</p>'}</div>
      </section>
      <aside class="logwrap"><h2>對局紀錄</h2><ol class="log" id="log">${logHTML}</ol></aside>
    </div>
    <footer class="bar ${g.turn === d.you && g.phase !== 'over' ? 'mine' : ''} ${S.ping ? 'ping' : ''}"><div class="bar-in">${barHTML(d, g, me)}</div></footer>
    ${g.phase === 'over' ? overHTML(d, g) : ''}`;
  }

  function rulesHTML() {
    return `<div class="overlay" data-act="close-rules"><div class="dialog rules" role="dialog" aria-modal="true" aria-label="規則">
      <h2>怎麼玩</h2>
      <p>先讓聲望達到 15 的商會獲勝。有人達標後，把那一輪打完再比高低；同分時工坊較少的人贏。</p>
      <h3>每回合做一件事</h3>
      <ul>
        <li><b>拿星砂</b>：拿 3 枚不同顏色，或同色 2 枚（該色公庫要剩 4 枚以上）。</li>
        <li><b>建造工坊</b>：付出牌上標示的星砂。蓋好的每座工坊，之後永久幫你抵掉 1 枚同色花費。</li>
        <li><b>預約</b>：把一張牌留給自己，最多 3 張，同時拿 1 枚星塵。星塵可以當任何顏色用。也可以從牌庫盲抽。</li>
      </ul>
      <h3>其他</h3>
      <ul>
        <li>回合結束時手上最多 10 枚星砂，多的要歸還。</li>
        <li>工坊數量達到星宿的要求，它就會自動降臨，加 3 聲望。</li>
        <li>牌上有 +${glyph('w')} 的工坊，建造時多送 1 枚星塵。</li>
      </ul>
      <div class="dialog-actions"><button class="btn primary" data-act="close-rules-btn">知道了</button></div>
    </div></div>`;
  }

  function render() {
    const d = S.data;
    let html;
    if (S.screen === 'home') html = homeHTML();
    else if (!d) html = '<main class="lobby"><p class="hint">連線中……</p></main>';
    else html = d.game ? gameHTML(d) : lobbyHTML(d);
    if (S.rules) html += rulesHTML();
    app.innerHTML = html;
    const log = document.getElementById('log');
    if (log) log.scrollTop = log.scrollHeight;
  }

  // ───────── 操作 ─────────

  function clickBank(c) {
    const g = S.data.game;
    if (c === 'w') return toast('星塵只能靠預約取得');
    S.sel.card = null; S.sel.deck = null;
    const t = S.sel.tokens;
    const has = t.filter((x) => x === c).length;
    if (has === 2) S.sel.tokens = [];
    else if (has === 1 && t.length === 1) {
      if (g.bank[c] >= 4) t.push(c);
      else { S.sel.tokens = []; toast('該色剩 4 枚以上才能一次拿 2 枚'); }
    } else if (has === 1) S.sel.tokens = t.filter((x) => x !== c);
    else if (g.bank[c] < 1) return toast(`${CN[c]}已經拿完了`);
    else if (t.length === 2 && t[0] === t[1]) return toast('同色 2 枚不能再搭其他顏色');
    else if (t.length >= 3) return toast('一次最多拿 3 枚');
    else t.push(c);
    return render();
  }

  async function copyInvite() {
    const link = `${location.origin}/?room=${S.room}`;
    try { await navigator.clipboard.writeText(link); toast('邀請連結已複製'); } catch { toast(link); }
  }

  app.addEventListener('input', (e) => {
    if (e.target.id === 'name') S.name = e.target.value;
    if (e.target.id === 'code') { S.code = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); e.target.value = S.code; }
  });

  app.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'name') enter(S.code.length === 4 ? 'join' : 'create');
    if (e.target.id === 'code') enter('join');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.rules) { S.rules = false; render(); }
  });

  app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return undefined;
    const a = el.dataset.act;
    const g = S.data && S.data.game;
    const myTurn = g && g.turn === S.data.you && g.phase !== 'over';
    switch (a) {
      case 'create': return enter('create');
      case 'join': return enter('join');
      case 'rules': S.rules = true; return render();
      case 'close-rules': if (e.target !== el) return undefined; S.rules = false; return render();
      case 'close-rules-btn': S.rules = false; return render();
      case 'copy': return copyInvite();
      case 'addbot': return act({ type: 'addBot' });
      case 'kick': return act({ type: 'kick', pid: el.dataset.pid });
      case 'start': return act({ type: 'start' });
      case 'again': return act({ type: 'again' });
      case 'tolobby': return act({ type: 'lobby' });
      case 'leave':
        if (g && g.phase !== 'over' && !S.confirmLeave) {
          S.confirmLeave = true;
          setTimeout(() => { if (S.confirmLeave) { S.confirmLeave = false; render(); } }, 3000);
          return render();
        }
        return act({ type: 'leave' });
      case 'bank': return myTurn && g.phase === 'play' ? clickBank(el.dataset.c) : undefined;
      case 'card':
        if (!myTurn || g.phase !== 'play') return toast(g.phase === 'discard' && myTurn ? '先歸還多出來的星砂' : '還沒輪到你');
        S.sel = { ...emptySel(), card: S.sel.card === el.dataset.id ? null : el.dataset.id };
        return render();
      case 'deck':
        if (!myTurn || g.phase !== 'play') return toast('還沒輪到你');
        S.sel = { ...emptySel(), deck: S.sel.deck === Number(el.dataset.tier) ? null : Number(el.dataset.tier) };
        return render();
      case 'untake': S.sel.tokens.splice(Number(el.dataset.i), 1); return render();
      case 'clear': S.sel = emptySel(); return render();
      case 'confirm-take': return act({ type: 'take', colors: S.sel.tokens });
      case 'buy': return act({ type: 'buy', cardId: S.sel.card });
      case 'reserve': return act({ type: 'reserve', cardId: S.sel.card });
      case 'reserve-deck': return act({ type: 'reserve', tier: S.sel.deck });
      case 'pass': return act({ type: 'pass' });
      case 'mytok': {
        const me = g.players.find((p) => p.id === S.data.you);
        if (S.sel.discard.length >= sum(me.tokens) - g.limit) return toast('已經選夠了，按「歸還」確認');
        S.sel.discard.push(el.dataset.c);
        return render();
      }
      case 'undiscard': S.sel.discard.splice(Number(el.dataset.i), 1); return render();
      case 'confirm-discard': return act({ type: 'discard', colors: S.sel.discard });
      default: return undefined;
    }
  });

  // ───────── 啟動 ─────────

  (async function boot() {
    render();
    let creds = null;
    try { creds = JSON.parse(sessionStorage.getItem('sg_creds')); } catch { /* 忽略壞掉的暫存 */ }
    if (creds && creds.room && (!S.code || S.code === creds.room)) {
      try {
        await api('/api/check', creds);
        S.room = creds.room; S.token = creds.token;
        connect();
      } catch { sessionStorage.removeItem('sg_creds'); }
    }
  })();
})();
