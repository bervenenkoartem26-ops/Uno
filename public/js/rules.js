/*
 * Правила UNO. Общий модуль: работает и в браузере, и на сервере (Node.js).
 * Сервер является источником истины для онлайн-игры; клиент использует те же функции
 * для локальной игры на одном устройстве.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UnoRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const COLORS = ['red', 'yellow', 'green', 'blue'];
  const COLOR_RU = { red: 'Красный', yellow: 'Жёлтый', green: 'Зелёный', blue: 'Синий' };
  const ACTION_RU = { skip: 'пропуск', reverse: 'реверс', draw2: '+2', wild: 'смена цвета', wild4: '+4' };
  const HAND_SIZE = 7;
  const MIN_PLAYERS = 2;
  const MAX_PLAYERS = 4;

  const fail = (error) => ({ ok: false, error });

  /** Колода из 108 карт: по 25 цветных на цвет и 8 чёрных. */
  function buildDeck() {
    const deck = [];
    let n = 0;
    const add = (color, value) => deck.push({ id: 'c' + n++, color, value });
    for (const color of COLORS) {
      add(color, '0');
      for (let v = 1; v <= 9; v++) {
        add(color, String(v));
        add(color, String(v));
      }
      for (const action of ['skip', 'reverse', 'draw2']) {
        add(color, action);
        add(color, action);
      }
    }
    for (let i = 0; i < 4; i++) {
      add('wild', 'wild');
      add('wild', 'wild4');
    }
    return deck;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  const topCard = (state) => state.discard[state.discard.length - 1];

  function nextIndex(state, steps = 1) {
    const n = state.players.length;
    let i = state.current;
    for (let s = 0; s < steps; s++) i = (i + state.direction + n) % n;
    return i;
  }

  /** Берёт карту из колоды; когда колода пуста, перемешивает сброс. */
  function drawOne(state) {
    if (state.deck.length === 0) {
      if (state.discard.length <= 1) return null;
      const top = state.discard.pop();
      state.deck = shuffle(state.discard);
      state.discard = [top];
    }
    return state.deck.pop();
  }

  /**
   * Можно ли сыграть карту.
   * Если на столе висит штраф (+2 / +4), можно только наложить такую же карту.
   */
  function canPlay(state, card) {
    const top = topCard(state);
    if (state.pendingDraw > 0) {
      return card.value === top.value && (card.value === 'draw2' || card.value === 'wild4');
    }
    if (card.color === 'wild') return true;
    return card.color === state.color || card.value === top.value;
  }

  function playableIds(state, pi) {
    if (state.winner !== null || pi !== state.current) return [];
    return state.players[pi].hand.filter((c) => canPlay(state, c)).map((c) => c.id);
  }

  function describeCard(card) {
    if (/^\d$/.test(card.value)) return `${COLOR_RU[card.color]} ${card.value}`;
    const word = ACTION_RU[card.value];
    return card.color === 'wild' ? word : `${COLOR_RU[card.color]} ${word}`;
  }

  function cardsWord(n) {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return 'карту';
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'карты';
    return 'карт';
  }

  /** Создаёт новую партию: сдаёт по 7 карт и открывает стартовую карту. */
  function createGame(names) {
    if (names.length < MIN_PLAYERS || names.length > MAX_PLAYERS) {
      throw new Error('Неверное число игроков');
    }
    const deck = shuffle(buildDeck());
    const players = names.map((name) => ({ name, hand: [] }));
    for (let r = 0; r < HAND_SIZE; r++) {
      for (const p of players) p.hand.push(deck.pop());
    }

    // Стартовая карта не может быть «+4»: возвращаем её в низ колоды и тянем снова.
    let top;
    do {
      if (top) {
        deck.unshift(top);
        shuffle(deck);
      }
      top = deck.pop();
    } while (top.value === 'wild4');

    const state = {
      players,
      deck,
      discard: [top],
      color: top.color === 'wild' ? COLORS[Math.floor(Math.random() * COLORS.length)] : top.color,
      direction: 1,
      current: 0,
      pendingDraw: 0,
      winner: null,
      message: 'Игра началась',
    };

    // Эффекты стартовой карты
    if (top.value === 'skip') state.current = nextIndex(state, 1);
    if (top.value === 'reverse') state.direction = -1;
    if (top.value === 'draw2') state.pendingDraw = 2;
    return state;
  }

  /** Розыгрыш карты. Меняет состояние; при ошибке состояние не меняется. */
  function playCard(state, pi, cardId, chosenColor) {
    if (state.winner !== null) return fail('Игра уже окончена');
    if (pi !== state.current) return fail('Сейчас ходит другой игрок');
    const player = state.players[pi];
    const index = player.hand.findIndex((c) => c.id === cardId);
    if (index < 0) return fail('Такой карты у вас нет');
    const card = player.hand[index];
    if (!canPlay(state, card)) return fail('Эту карту сейчас нельзя сыграть');
    if (card.color === 'wild' && !COLORS.includes(chosenColor)) return fail('Выберите цвет');

    player.hand.splice(index, 1);
    state.discard.push(card);
    state.color = card.color === 'wild' ? chosenColor : card.color;

    let steps = 1;
    if (card.value === 'skip') steps = 2;
    if (card.value === 'reverse') {
      state.direction *= -1;
      if (state.players.length === 2) steps = 2; // при двух игроках реверс работает как пропуск
    }
    if (card.value === 'draw2') state.pendingDraw += 2;
    if (card.value === 'wild4') state.pendingDraw += 4;

    if (player.hand.length === 0) {
      state.winner = pi;
      state.message = `${player.name} избавился(ась) от всех карт!`;
      return { ok: true };
    }

    state.current = nextIndex(state, steps);
    let message = `${player.name}: ${describeCard(card)}`;
    if (card.color === 'wild') message += ` → ${COLOR_RU[state.color]}`;
    if (player.hand.length === 1) message += ' — УНО!';
    state.message = message;
    return { ok: true };
  }

  /**
   * Взять карту. Без штрафа — одна карта, ход переходит дальше.
   * Со штрафом — берётся весь штраф, ход пропускается.
   * Упрощение: взятую карту нельзя сыграть в этом же ходу.
   */
  function drawCard(state, pi) {
    if (state.winner !== null) return fail('Игра уже окончена');
    if (pi !== state.current) return fail('Сейчас ходит другой игрок');
    const player = state.players[pi];
    const count = state.pendingDraw > 0 ? state.pendingDraw : 1;
    let drawn = 0;
    for (let i = 0; i < count; i++) {
      const card = drawOne(state);
      if (!card) break;
      player.hand.push(card);
      drawn++;
    }
    state.pendingDraw = 0;
    state.current = nextIndex(state, 1);
    state.message = `${player.name} берёт ${drawn} ${cardsWord(drawn)}`;
    return { ok: true, drawn };
  }

  /** Представление состояния для конкретного игрока: чужие карты скрыты. */
  function viewFor(state, pi) {
    return {
      players: state.players.map((p, i) => ({
        name: p.name,
        count: p.hand.length,
        isCurrent: i === state.current,
      })),
      myIndex: pi,
      myHand: pi >= 0 && state.players[pi] ? state.players[pi].hand : [],
      top: topCard(state),
      color: state.color,
      direction: state.direction,
      current: state.current,
      pendingDraw: state.pendingDraw,
      deckCount: state.deck.length,
      winner: state.winner,
      message: state.message,
      playable: playableIds(state, pi),
    };
  }

  return {
    COLORS,
    COLOR_RU,
    MIN_PLAYERS,
    MAX_PLAYERS,
    buildDeck,
    shuffle,
    createGame,
    playCard,
    drawCard,
    canPlay,
    playableIds,
    viewFor,
    describeCard,
  };
});
