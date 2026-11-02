/*
 * Клиент UNO: экраны, локальная игра на одном устройстве и онлайн-режим по WebSocket.
 */
(() => {
  'use strict';

  const R = window.UnoRules;
  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');
  // Значки рисуются SVG, а не символами шрифта: цвет всегда берётся от карты (currentColor)
  const svg = (body, sw = 2.6) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICON = {
    skip: svg('<circle cx="12" cy="12" r="8.2"/><path d="M6.2 17.8 17.8 6.2"/>'),
    reverse: svg('<path d="M4 8h15M15 4l4 4-4 4"/><path d="M20 16H5M9 12l-4 4 4 4"/>'),
    wild: svg('<path d="M12 3.5 14.3 9.7 20.5 12 14.3 14.3 12 20.5 9.7 14.3 3.5 12 9.7 9.7Z" fill="currentColor"/>', 1.5),
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>', 2),
    moon: svg('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>', 2),
    back: svg('<path d="M15 5l-7 7 7 7"/>', 2),
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>', 2),
  };

  const app = {
    screen: 'home', // home | local-setup | local | online | lobby | game
    draft: {
      n1: 'Игрок 1',
      n2: 'Игрок 2',
      name: safeGet('uno-name') || '',
      code: '',
    },
    local: null, // { names, state, handoff }
    online: { room: null, view: null, error: '' },
    pendingWild: null,
    seenHand: new Set(),
    lastTopId: null,
    lastScreen: null,
    busy: false,        // идёт анимация розыгрыша карты
    flyingId: null,     // карта, которая сейчас летит в сброс
    dropDelay: 0,       // задержка появления верхней карты, пока летит наша
    skipDrop: false,
  };

  let socket = null;
  let socketPromise = null;
  let toastTimer = null;

  // ---------- Утилиты ----------
  function safeGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function safeSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* хранилище недоступно */ }
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function toast(text) {
    $toast.textContent = text;
    $toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $toast.classList.remove('show'), 2200);
  }

  /** Короткое покачивание карты, если её нельзя сыграть. */
  function flash(id) {
    const el = document.querySelector(`.card[data-id="${id}"]`);
    if (!el) return;
    el.classList.remove('nope');
    void el.offsetWidth; // перезапуск анимации
    el.classList.add('nope');
  }

  // ---------- Тема ----------
  function isDark() {
    const t = document.documentElement.dataset.theme;
    return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function syncThemeMeta() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = isDark() ? '#1f1e1d' : '#faf9f5';
  }

  function toggleTheme() {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    safeSet('uno-theme', next);
    syncThemeMeta();
  }

  const themeBtn = () =>
    `<button class="icon-btn" data-act="theme" aria-label="Сменить тему">${isDark() ? ICON.sun : ICON.moon}</button>`;

  // ---------- Полёт карты в сброс ----------
  function flyToDiscard(id, done) {
    const el = document.querySelector(`.hand .card[data-id="${id}"]`);
    const target = document.querySelector('.discard .card');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!el || !target || !el.animate || reduce) {
      if (done) done();
      return;
    }
    const a = el.getBoundingClientRect(); // учитывает подъём и перетаскивание
    const b = target.getBoundingClientRect();

    const clone = el.cloneNode(true);
    clone.removeAttribute('data-id');
    clone.className = el.className.replace(/\b(playable|unplayable|deal|nope|ghost)\b/g, '') + ' flying';
    clone.style.cssText =
      `position:fixed;left:${a.left}px;top:${a.top}px;width:${a.width}px;height:${a.height}px;` +
      `--card-w:${el.offsetWidth}px;--card-h:${el.offsetHeight}px;` + // размер символов как у карты в руке
      'margin:0;z-index:40;pointer-events:none;';
    document.body.appendChild(clone);

    app.flyingId = id;
    app.dropDelay = 260;
    el.classList.add('ghost');

    const tilt = tiltOf(id);
    const anim = clone.animate([
      { transform: 'translate(0, 0) rotate(0deg) scale(1)' },
      { transform: `translate(${b.left - a.left}px, ${b.top - a.top}px) rotate(${tilt}deg) scale(${b.width / a.width})` },
    ], { duration: 340, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });

    const finish = () => {
      clone.remove();
      app.dropDelay = 0;
      if (done) {
        app.flyingId = null;
        done();
      }
    };
    anim.onfinish = finish;
    anim.oncancel = finish;
  }

  // ---------- Карта ----------
  const markOf = (v) => (/^\d$/.test(v) ? v : v === 'draw2' ? '+2' : v === 'wild4' ? '+4' : ICON[v] || '');
  const tiltOf = (id) => ([...String(id)].reduce((s, ch) => s + ch.charCodeAt(0), 0) % 13) - 6;

  function cardHTML(card, o = {}) {
    const wild = card.color === 'wild';
    const v = card.value;
    const corner = markOf(v);
    const center = v === 'wild' ? '' : markOf(v);

    const classes = ['card', wild ? 'card-wild' : `card-${card.color}`];
    if (o.cls) classes.push(...o.cls.filter(Boolean));
    if (o.deal) classes.push('deal');
    if (o.drop) classes.push(o.dropDelay ? 'land' : 'drop');

    const attrs = [];
    const styles = [];
    if (o.tappable) attrs.push(`data-id="${card.id}"`);
    if (o.deal) styles.push(`animation-delay:${o.delay || 0}ms`);
    if (o.drop && o.dropDelay) styles.push(`animation-delay:${o.dropDelay}ms`);
    if (o.tilt) styles.push(`--tilt:${tiltOf(card.id)}deg`);
    if (styles.length) attrs.push(`style="${styles.join(';')}"`);
    attrs.push(`aria-label="${esc(R.describeCard(card))}"`);

    return `<div class="${classes.join(' ')}" ${attrs.join(' ')}>` +
      `<span class="corner tl">${corner}</span>` +
      `<span class="oval"><span class="center">${center}</span></span>` +
      `<span class="corner br">${corner}</span>` +
      `</div>`;
  }

  // ---------- Экраны ----------
  function render() {
    let html = '';
    switch (app.screen) {
      case 'home': html = screenHome(); break;
      case 'local-setup': html = screenLocalSetup(); break;
      case 'online': html = screenOnline(); break;
      case 'lobby': html = screenLobby(); break;
      case 'local':
      case 'game': html = screenGame(); break;
    }
    // Анимация появления экрана — только при переходе между экранами
    const entering = app.screen !== app.lastScreen;
    app.lastScreen = app.screen;
    $app.classList.toggle('enter', entering);
    $app.innerHTML = html;
  }

  function screenHome() {
    return `
      <section class="screen home">
        <div class="home-top">${themeBtn()}</div>
        <div class="spacer"></div>
        <div class="brand">
          <div class="fan" aria-hidden="true">
            <span class="c"></span><span class="c"></span><span class="c"></span><span class="c"></span>
          </div>
          <h1>UNO</h1>
          <p class="hint">Классическая игра в карты</p>
        </div>
        <div class="spacer"></div>
        <div class="menu">
          <button class="btn primary wide" data-act="go-local">Два игрока на одном устройстве</button>
          <button class="btn wide" data-act="go-online">Онлайн-игра</button>
        </div>
      </section>`;
  }

  function screenLocalSetup() {
    return `
      <section class="screen">
        <header class="topbar">
          <button class="icon-btn" data-act="home" aria-label="Назад">${ICON.back}</button>
          <h2>Два игрока</h2>
          ${themeBtn()}
        </header>
        <label class="field">Игрок 1
          <input data-field="n1" maxlength="16" value="${esc(app.draft.n1)}">
        </label>
        <label class="field">Игрок 2
          <input data-field="n2" maxlength="16" value="${esc(app.draft.n2)}">
        </label>
        <p class="hint">Ходите по очереди. Между ходами передавайте устройство, чтобы соперник не видел ваши карты.</p>
        <div class="spacer"></div>
        <button class="btn primary wide" data-act="local-start">Начать игру</button>
      </section>`;
  }

  function screenOnline() {
    const err = app.online.error ? `<p class="error">${esc(app.online.error)}</p>` : '';
    return `
      <section class="screen">
        <header class="topbar">
          <button class="icon-btn" data-act="home" aria-label="Назад">${ICON.back}</button>
          <h2>Онлайн-игра</h2>
          ${themeBtn()}
        </header>
        <label class="field">Ваше имя
          <input data-field="name" maxlength="16" placeholder="Например, Аня" value="${esc(app.draft.name)}">
        </label>
        <div class="card-panel">
          <h3>Создать комнату</h3>
          <p class="hint">Вы получите код и сможете пригласить друзей.</p>
          <button class="btn primary wide" data-act="online-create">Создать комнату</button>
        </div>
        <div class="card-panel">
          <h3>Войти по коду</h3>
          <input class="code-input" data-field="code" maxlength="4" placeholder="ABCD"
                 autocapitalize="characters" autocomplete="off" value="${esc(app.draft.code)}">
          <button class="btn wide" data-act="online-join">Войти в комнату</button>
        </div>
        ${err}
      </section>`;
  }

  function screenLobby() {
    const room = app.online.room;
    if (!room) {
      app.screen = 'online';
      return screenOnline();
    }
    const n = room.players.length;
    const list = room.players.map((name, i) => `
      <li class="player-row">
        <span class="avatar">${i + 1}</span>
        <span class="player-name">${esc(name)}${i === room.myIndex ? ' <span class="muted">(вы)</span>' : ''}</span>
        ${i === room.hostIndex ? '<span class="badge">создатель</span>' : ''}
      </li>`).join('');

    const action = room.isHost
      ? `<button class="btn primary wide" data-act="room-start" ${n < R.MIN_PLAYERS ? 'disabled' : ''}>Начать игру</button>
         <p class="hint center">${n < R.MIN_PLAYERS ? 'Ждём второго игрока…' : `Игроков: ${n} из ${R.MAX_PLAYERS}`}</p>`
      : `<p class="hint center">Ждём, пока создатель начнёт игру…</p>`;

    return `
      <section class="screen">
        <header class="topbar">
          <button class="icon-btn" data-act="room-leave" aria-label="Выйти из комнаты">${ICON.back}</button>
          <h2>Комната</h2>
          ${themeBtn()}
        </header>
        <div class="code-block">
          <span class="hint">Код комнаты</span>
          <button class="room-code" data-act="copy-code">${esc(room.code)}</button>
          <span class="hint">Нажмите код, чтобы скопировать</span>
        </div>
        <ul class="player-list">${list}</ul>
        <div class="spacer"></div>
        ${action}
      </section>`;
  }

  function currentView() {
    if (app.screen === 'local') {
      const st = app.local.state;
      return R.viewFor(st, st.current);
    }
    return app.online.view;
  }

  function screenGame() {
    const isLocal = app.screen === 'local';
    const view = currentView();
    if (!view) return `<section class="screen center"><p class="hint">Загрузка…</p></section>`;

    const me = view.myIndex;
    const myTurn = view.winner === null && view.current === me;
    const handOff = isLocal && app.local.handoff;
    const hand = view.myHand;
    const code = app.online.room ? app.online.room.code : '';

    // Карты появляются с анимацией только в первый раз, когда их видим.
    const handHTML = handOff ? '' : hand.map((card, i) => {
      const playable = myTurn && view.playable.includes(card.id);
      return cardHTML(card, {
        tappable: true,
        cls: [
          myTurn && playable ? 'playable' : '',
          myTurn && !playable ? 'unplayable' : '',
          card.id === app.flyingId ? 'ghost' : '',
        ],
        deal: !app.seenHand.has(card.id),
        delay: i * 60,
      });
    }).join('');
    app.seenHand = new Set(handOff ? [] : hand.map((c) => c.id));

    const dropNow = app.lastTopId !== view.top.id;
    app.lastTopId = view.top.id;
    const animateDrop = dropNow && !app.skipDrop;
    if (dropNow) app.skipDrop = false;
    const dropDelay = animateDrop ? app.dropDelay : 0;

    const opponents = view.players.map((p, i) => (i === me ? '' : `
      <div class="opp ${p.isCurrent ? 'active' : ''}">
        <span>${esc(p.name)}</span>
        <span class="opp-count">${p.count}</span>
      </div>`)).join('');

    let status = '';
    if (view.winner === null) {
      if (isLocal) status = `Ходит ${esc(view.players[view.current].name)}`;
      else if (myTurn) {
        status = view.pendingDraw
          ? `Ответьте картой +${view.pendingDraw} или возьмите ${view.pendingDraw}`
          : 'Ваш ход';
      } else {
        status = `Ходит ${esc(view.players[view.current].name)}`;
      }
    }

    const canDraw = myTurn && !handOff;
    const drawLabel = view.pendingDraw ? `+${view.pendingDraw}` : 'Взять';

    return `
      <section class="screen game">
        <header class="topbar">
          <button class="icon-btn" data-act="game-leave" aria-label="Выйти">${ICON.close}</button>
          <div class="topbar-title">${isLocal ? 'Один экран' : `Комната ${esc(code)}`}</div>
          ${themeBtn()}
        </header>

        <div class="opponents">${opponents}</div>

        <div class="table">
          <button class="draw-pile ${canDraw && view.playable.length === 0 ? 'ready' : ''}" data-act="draw"
                  ${canDraw ? '' : 'disabled'} aria-label="Взять карту">
            <span class="dp-label">${drawLabel}</span><span class="dp-count">${view.deckCount}</span>
          </button>
          <div class="discard">${cardHTML(view.top, { drop: animateDrop, dropDelay, tilt: true })}</div>
        </div>

        <div class="info">
          <span class="chip chip-${view.color}">${R.COLOR_RU[view.color]}</span>
          <span class="chip">${view.direction === 1 ? '↻' : '↺'}</span>
          ${view.pendingDraw ? `<span class="chip chip-warn">+${view.pendingDraw}</span>` : ''}
        </div>

        <p class="status ${myTurn && !handOff ? 'mine' : ''}">${status}</p>
        <p class="message">${esc(view.message || '')}</p>

        <div class="me ${myTurn ? 'active' : ''}">
          <span class="me-name">${esc(view.players[me].name)}</span>
          <span class="muted">${hand.length} карт</span>
        </div>

        <div class="hand">${handHTML}</div>

        ${overlayFor(view, handOff)}
      </section>`;
  }

  function overlayFor(view, handOff) {
    if (handOff) {
      const name = esc(view.players[view.current].name);
      return `
        <div class="overlay opaque">
          <div class="sheet">
            <p class="hint">Передайте устройство</p>
            <h2>${name}</h2>
            <button class="btn primary wide" data-act="handoff-ready">Показать мои карты</button>
          </div>
        </div>`;
    }
    if (app.pendingWild !== null) {
      const colors = R.COLORS.map((c) => `
        <button class="color-btn color-${c}" data-act="pick-color" data-color="${c}">${R.COLOR_RU[c]}</button>`).join('');
      return `
        <div class="overlay">
          <div class="sheet">
            <h3>Выберите цвет</h3>
            <div class="colors">${colors}</div>
            <button class="btn ghost wide" data-act="pick-cancel">Отмена</button>
          </div>
        </div>`;
    }
    if (view.winner !== null) {
      const name = esc(view.players[view.winner].name);
      const confetti = Array.from({ length: 30 }, (_, i) =>
        `<i style="left:${(i * 37) % 100}%;background:var(--${R.COLORS[i % 4]});` +
        `animation-delay:${(i % 7) * 120}ms;animation-duration:${2200 + (i % 5) * 350}ms"></i>`).join('');
      let actions;
      if (app.screen === 'local') {
        actions = `
          <button class="btn primary wide" data-act="local-again">Сыграть ещё</button>
          <button class="btn wide" data-act="home">В меню</button>`;
      } else if (app.online.room && app.online.room.isHost) {
        actions = `
          <button class="btn primary wide" data-act="room-restart">Новая игра</button>
          <button class="btn wide" data-act="room-leave">Выйти из комнаты</button>`;
      } else {
        actions = `
          <p class="hint center">Ждём, пока создатель начнёт новую игру…</p>
          <button class="btn wide" data-act="room-leave">Выйти из комнаты</button>`;
      }
      return `
        <div class="overlay">
          <div class="confetti" aria-hidden="true">${confetti}</div>
          <div class="sheet">
            <p class="hint center">Игра окончена</p>
            <h2 class="center">${name} побеждает!</h2>
            ${actions}
          </div>
        </div>`;
    }
    return '';
  }

  // ---------- Локальная игра ----------
  function localNames() {
    const a = (app.draft.n1 || '').trim().slice(0, 16) || 'Игрок 1';
    let b = (app.draft.n2 || '').trim().slice(0, 16) || 'Игрок 2';
    if (a === b) b += ' 2';
    return [a, b];
  }

  function startLocal(names) {
    app.local = { names, state: R.createGame(names), handoff: true };
    app.pendingWild = null;
    app.seenHand = new Set();
    app.lastTopId = null;
    app.screen = 'local';
  }

  function localAfterMove(res) {
    if (!res.ok) return toast(res.error);
    if (app.local.state.winner === null) app.local.handoff = true;
  }

  // ---------- Действия игрока ----------
  /** Причина, по которой карту сейчас нельзя сыграть (пустая строка — можно). */
  function unplayableReason(id) {
    const view = currentView();
    if (!view || view.winner !== null) return 'Игра окончена';
    if (view.current !== view.myIndex) return 'Сейчас ход другого игрока';
    if (!view.playable.includes(id)) return 'Эту карту нельзя сыграть';
    return '';
  }

  /** Играет карту из руки. Возвращает true, если ход принят. */
  function playFromHand(id) {
    if (app.busy) return false;
    const reason = unplayableReason(id);
    if (reason) {
      flash(id);
      toast(reason);
      return false;
    }
    playCard(id);
    return true;
  }

  function playCard(id, color) {
    const view = currentView();
    const card = view && view.myHand.find((c) => c.id === id);
    if (card && card.color === 'wild' && !color) {
      app.pendingWild = id;
      return;
    }
    if (app.busy) return;
    if (app.screen === 'local') {
      // Сначала карта летит в сброс, и только потом ход переходит к сопернику
      app.busy = true;
      flyToDiscard(id, () => {
        app.busy = false;
        if (app.screen !== 'local' || !app.local) return;
        app.skipDrop = true;
        const st = app.local.state;
        localAfterMove(R.playCard(st, st.current, id, color));
        render();
      });
    } else {
      flyToDiscard(id);
      send({ type: 'play', cardId: id, color });
    }
  }

  function pickColor(color) {
    const id = app.pendingWild;
    app.pendingWild = null;
    if (id) playCard(id, color);
  }

  function drawAction() {
    if (app.screen === 'local') {
      const st = app.local.state;
      const res = R.drawCard(st, st.current);
      if (!res.ok) return toast(res.error);
      localAfterMove(res);
    } else {
      send({ type: 'draw' });
    }
  }

  // ---------- Онлайн: соединение ----------
  function connect() {
    if (socketPromise) return socketPromise;
    socketPromise = new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}`);
      ws.onopen = () => {
        socket = ws;
        resolve(ws);
      };
      ws.onmessage = (e) => onServer(JSON.parse(e.data));
      ws.onerror = () => reject(new Error('Нет соединения'));
      ws.onclose = () => {
        socket = null;
        socketPromise = null;
        if (app.screen === 'lobby' || app.screen === 'game') {
          app.online.room = null;
          app.online.view = null;
          app.screen = 'online';
          app.online.error = 'Соединение с сервером потеряно';
          render();
        }
      };
    });
    return socketPromise;
  }

  async function send(msg) {
    try {
      const ws = await connect();
      ws.send(JSON.stringify(msg));
    } catch {
      toast('Нет соединения с сервером');
    }
  }

  function onServer(msg) {
    app.flyingId = null;
    switch (msg.type) {
      case 'room':
        app.online.room = msg;
        app.online.view = null;
        app.online.error = '';
        app.screen = 'lobby';
        break;
      case 'state':
        app.online.view = msg.view;
        app.screen = 'game';
        break;
      case 'closed':
        app.online.room = null;
        app.online.view = null;
        app.online.error = msg.message;
        app.screen = 'online';
        break;
      case 'error':
        if (app.screen === 'online') app.online.error = msg.message;
        else toast(msg.message);
        break;
    }
    render();
  }

  function readName() {
    const name = app.draft.name.trim().slice(0, 16);
    safeSet('uno-name', name);
    return name;
  }

  function onlineCreate() {
    const name = readName();
    if (!name) {
      app.online.error = 'Введите имя';
      return;
    }
    app.online.error = '';
    send({ type: 'create', name });
  }

  function onlineJoin() {
    const name = readName();
    const code = app.draft.code.trim().toUpperCase();
    if (!name) {
      app.online.error = 'Введите имя';
      return;
    }
    if (code.length !== 4) {
      app.online.error = 'Код состоит из 4 символов';
      return;
    }
    app.online.error = '';
    send({ type: 'join', name, code });
  }

  function leaveOnline() {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'leave' }));
    }
    app.online.room = null;
    app.online.view = null;
  }

  function copyCode() {
    const code = app.online.room && app.online.room.code;
    if (!code) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code)
        .then(() => toast('Код скопирован'), () => toast(`Код комнаты: ${code}`));
    } else {
      toast(`Код комнаты: ${code}`);
    }
  }

  // ---------- Обработка нажатий и ввода ----------
  function handleAction(act, el) {
    switch (act) {
      case 'go-local':
        app.screen = 'local-setup';
        break;
      case 'go-online':
        app.screen = 'online';
        app.online.error = '';
        break;
      case 'home':
        leaveOnline();
        app.local = null;
        app.screen = 'home';
        break;
      case 'local-start':
        startLocal(localNames());
        break;
      case 'local-again':
        startLocal(app.local.names);
        break;
      case 'handoff-ready':
        app.local.handoff = false;
        break;
      case 'draw':
        drawAction();
        break;
      case 'theme':
        toggleTheme();
        break;
      case 'pick-color':
        pickColor(el.dataset.color);
        break;
      case 'pick-cancel':
        app.pendingWild = null;
        break;
      case 'game-leave':
        if (app.screen === 'local') {
          app.local = null;
          app.screen = 'home';
        } else {
          leaveOnline();
          app.screen = 'online';
        }
        break;
      case 'online-create':
        onlineCreate();
        break;
      case 'online-join':
        onlineJoin();
        break;
      case 'room-start':
        send({ type: 'start' });
        break;
      case 'room-restart':
        send({ type: 'restart' });
        break;
      case 'room-leave':
        leaveOnline();
        app.screen = 'online';
        break;
      case 'copy-code':
        copyCode();
        break;
    }
    render();
  }

  // После жеста по карте экран перерисовывается, и «хвостовой» click мог бы попасть
  // по новой кнопке под пальцем (например, по выбору цвета). Поэтому его игнорируем.
  let ignoreClickUntil = 0;

  $app.addEventListener('click', (e) => {
    if (performance.now() < ignoreClickUntil) return;
    const el = e.target.closest('[data-act]');
    if (el) handleAction(el.dataset.act, el);
  });

  // ---------- Жесты по картам: нажатие или свайп вверх ----------
  const SWIPE_DISTANCE = 60; // px вверх, чтобы сыграть свайпом
  const MOVE_TOLERANCE = 8;  // px, меньшее движение считается нажатием
  let gesture = null;

  $app.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.hand .card[data-id]');
    if (!el || e.button > 0) return;
    gesture = { id: el.dataset.id, el, x: e.clientX, y: e.clientY, moved: false };
  });

  $app.addEventListener('pointermove', (e) => {
    if (!gesture) return;
    const dx = e.clientX - gesture.x;
    const dy = e.clientY - gesture.y;
    if (!gesture.moved && Math.hypot(dx, dy) > MOVE_TOLERANCE) gesture.moved = true;
    // Карта следует за пальцем, пока тянем вверх
    if (gesture.moved && dy < 0 && Math.abs(dy) > Math.abs(dx)) {
      gesture.el.style.transform = `translateY(${Math.max(dy, -120)}px) scale(1.06)`;
    }
  });

  $app.addEventListener('pointerup', (e) => {
    const g = gesture;
    gesture = null;
    if (!g) return;
    ignoreClickUntil = performance.now() + 450;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    const swipe = dy <= -SWIPE_DISTANCE && Math.abs(dy) > Math.abs(dx);

    if (!g.moved || swipe) {
      if (playFromHand(g.id)) return render();
    }
    g.el.style.transform = ''; // карта возвращается на место
  });

  $app.addEventListener('pointercancel', () => {
    if (!gesture) return;
    gesture = null;
    render();
  });

  $app.addEventListener('input', (e) => {
    const field = e.target.dataset.field;
    if (!field) return;
    let value = e.target.value;
    if (field === 'code') {
      value = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      e.target.value = value;
    }
    app.draft[field] = value;
  });

  syncThemeMeta();
  render();
})();
