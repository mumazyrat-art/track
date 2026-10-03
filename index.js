/**
 * Статус аккаунта Syntx — версия на одного человека и один аккаунт.
 *
 * Очереди здесь нет: считается, что в сервис ходишь ты одна. Вместо «перед тобой N
 * человек» расширение говорит, чем аккаунт занят прямо сейчас и сколько ему осталось.
 *
 * Уведомления по ходу одной отправки:
 *   1. «Аккаунт генерирует.»        — слот занят другой (или брошенной) генерацией;
 *   2. «Аккаунт отдыхает N секунд.» — генерация кончилась, идёт пауза перед следующей;
 *   3. «Начинаю генерацию. Жди.»    — сервер взялся за твой запрос.
 * Каждое показывается не больше раза за отправку. Когда аккаунт свободен, приходит
 * только третье — остальным просто нечего сообщить.
 *
 * Отдых — это не «сервер думает». После каждого ответа слот аккаунта держится занятым
 * ещё 1–3 минуты, чтобы запросы не шли сплошным потоком. Длительность сервер выбирает
 * случайно, поэтому вычислить её со стороны нельзя — он сообщает её сам, в ручке
 * /account/status. Число там настоящее, а не прикидка по времени.
 *
 * Всё это — пока «Иконка» выключена. С включённой всплывашки молчат: кружок показывает
 * то же самое и всегда на виду, дублировать незачем. Следить за запросом расширение при
 * этом не перестаёт — окошко у кружка обновляется как раз из этих опросов.
 *
 * Кружок на экране («Иконка» в настройках) — то же самое, но не залезая в настройки.
 * Тап открывает окошко со статусом рядом с ним, ещё один — закрывает; кружок таскается
 * пальцем и помнит своё место. «Сброс» ставит его в середину экрана: на планшете окно
 * меньше, и сохранённое с компьютера место может оказаться за краем.
 *
 * Как расширение узнаёт, что началась ИМЕННО его генерация. Запрос уходит из бэкенда
 * таверны, а не из браузера, поэтому сам по себе он ничем не подписан. На событии
 * CHAT_COMPLETION_SETTINGS_READY расширение дописывает заголовок X-Queue-Id в данные
 * именно этой отправки (таверна для кастомного эндпоинта берёт заголовки оттуда).
 * Сохранённые настройки таверны при этом не меняются. Сервер вешает метку на запрос, и
 * дальше расширение спрашивает «взялись за мой?» и получает точный ответ — без догадок
 * по времени и без арифметики.
 *
 * Наружу расширение ходит только на адрес, указанный в его настройках, и только если
 * таверна отправляет генерацию туда же.
 */

const NS = 'syntxAccount';          // свой раздел настроек: с очередной версией не пересекается
const POLL_MS = 2000;               // как часто спрашивать сервер, пока ждём свою генерацию
const FIRST_POLL_MS = 400;          // первый раз — почти сразу, запрос уже в пути
const FETCH_TIMEOUT_MS = 4000;      // потолок на один запрос, чтобы не морозить таверну
const GIVE_UP_MS = 15 * 60 * 1000;  // страховка: когда-нибудь перестать спрашивать
const STATUS_POLL_MS = 3000;        // как часто ходить за состоянием, пока на него смотрят
const STATUS_TICK_MS = 1000;        // как часто перерисовывать таймер между запросами
const SKIP_TYPES = ['quiet'];       // фоновые генерации (саммари и подобное) не показываем
const HEADER = 'X-Queue-Id';
const DOT_PX = 40;                  // размер кружка; он же — габарит при удержании в экране
const BUBBLE_GAP = 48;              // отступ окошка от кружка
const DRAG_SLOP = 5;                // сдвиг меньше этого — это тап, а не перетаскивание

// Размер текста в окошке растёт вместе с шириной окна. Фиксированное число не годится:
// на телефоне те же пиксели занимают вдвое большую долю экрана, чем на ноутбуке, и
// комфортные на маке 19px там выглядят баннером. Задаём две опорные точки — телефон и
// большой экран, — между ними размер идёт по прямой, за ними упирается в границы.
// Отступы в em, поэтому подстраиваются сами. Кружок при этом не меняется: он не текст,
// а цель для пальца, и мельче 40px по нему трудно попасть.
const BUBBLE_FONT = { min: 13, max: 19, atWidth: 390, toWidth: 1440 };

/** Тот же расчёт, что и в clamp() ниже, — чтобы его можно было проверить без браузера. */
function bubbleFontAt(viewW) {
    const { min, max, atWidth, toWidth } = BUBBLE_FONT;
    const slope = (max - min) / (toWidth - atWidth);
    const w = Number(viewW) || 0;
    return Math.min(max, Math.max(min, min + slope * (w - atWidth)));
}

const DEFAULTS = { url: '', key: '', icon: false, x: null, y: null };

let watcher = null;    // таймер слежения за своим запросом
let skipNext = false;  // текущая генерация служебная (dry run или фоновая)
let live = { state: null, restLeft: 0, at: 0 };  // последний ответ сервера
let widget = null;     // корень плавающего кружка
let bubbleOpen = false;
let drag = null;

function context() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

function config() {
    const store = context()?.extensionSettings;
    if (!store) return { ...DEFAULTS };
    if (!store[NS]) store[NS] = { ...DEFAULTS };
    // Настройки, сохранённые прошлой версией, не знают про кружок — дописываем на месте.
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (!(key in store[NS])) store[NS][key] = value;
    }
    return store[NS];
}

function save() {
    context()?.saveSettingsDebounced?.();
}

/** Адрес без хвостов вида /v1 или /chat/completions и только абсолютный. */
function normalizeBase(url) {
    if (typeof url !== 'string') return '';
    const base = url.trim()
        .replace(/\/+$/, '')
        .replace(/\/chat\/completions$/, '')
        .replace(/\/v1$/, '');
    return /^https?:\/\//i.test(base) ? base : '';
}

/** 1 секунду, 2 секунды, 5 секунд. */
function secondsWord(n) {
    const ones = n % 10;
    const tens = n % 100;
    if (ones === 1 && tens !== 11) return 'секунду';
    if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return 'секунды';
    return 'секунд';
}

function notify(text) {
    // При включённом кружке всплывашки молчат: он показывает то же самое и никуда не
    // пропадает. Следить за запросом расширение при этом не перестаёт — окошко у кружка
    // обновляется как раз из этих опросов.
    if (config().icon) return;
    globalThis.toastr?.success(text);
}

/** Приводим адрес к виду, по которому их можно сравнивать: localhost и 127.0.0.1 — одно и то же. */
function serviceKey(url) {
    const base = normalizeBase(url);
    if (!base) return '';
    try {
        const parsed = new URL(base);
        const host = ['127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) ? 'localhost' : parsed.hostname;
        const path = parsed.pathname.replace(/\/+$/, '');
        return `${parsed.protocol}//${host}${parsed.port ? ':' + parsed.port : ''}${path}`;
    } catch {
        return base;
    }
}

function tavernUrl() {
    return context()?.chatCompletionSettings?.custom_url ?? '';
}

/** Выбранный в таверне источник Chat Completion: 'custom', 'makersuite', 'claude' и так далее. */
function tavernSource() {
    return context()?.chatCompletionSettings?.chat_completion_source ?? '';
}

/** Какой API выбран целиком: 'openai' — это Chat Completion, всё прочее — Text Completion и родня. */
function tavernApi() {
    return context()?.mainApi ?? '';
}

/**
 * Идёт ли текущая генерация в наш сервис. Одного адреса мало: таверна хранит custom_url
 * даже после переключения на Google AI или Claude, поэтому старый адрес продолжал
 * совпадать, расширение считало запрос своим и слало уведомления впустую.
 */
function generationGoesToOurService() {
    const api = tavernApi();
    if (api && api !== 'openai') return false;
    // Пустой источник — старая таверна, которая его не отдаёт: тогда судим по адресу,
    // как раньше. Молча отключаться из-за незнакомого поля было бы хуже всего.
    const source = tavernSource();
    if (source && source !== 'custom') return false;
    const ours = serviceKey(config().url);
    return Boolean(ours) && ours === serviceKey(tavernUrl());
}

/**
 * Состояние аккаунта. С меткой в `id` ответ дополнительно говорит, что с нашим запросом.
 * Вернёт null, если сервер недоступен или ответил не тем — это не повод шуметь.
 */
async function fetchAccount(id) {
    const { url, key } = config();
    const base = normalizeBase(url);
    if (!base || !key) return null;
    const query = id ? `?id=${encodeURIComponent(id)}` : '';
    try {
        const response = await fetch(`${base}/account/status${query}`, {
            cache: 'no-store',
            headers: { Authorization: `Bearer ${key}` },
            signal: typeof AbortSignal?.timeout === 'function'
                ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined,
        });
        if (!response.ok) return null;
        const data = await response.json();
        return typeof data?.state === 'string' ? data : null;
    } catch {
        return null;
    }
}

function stopWatching() {
    if (watcher) {
        clearInterval(watcher);
        watcher = null;
    }
}

/**
 * Следим за своей отправкой по метке. Про генерацию и отдых сообщаем, только пока свой
 * запрос ещё ждёт: раз он в очереди, значит слот занят не им, и говорить есть о чём.
 * Как только сервер взялся за него — последнее уведомление и перестаём спрашивать.
 */
function watchRequest(id) {
    stopWatching();
    const deadline = Date.now() + GIVE_UP_MS;
    let seen = false;         // сервер уже увидел наш запрос
    let toldGenerating = false;
    let toldResting = false;

    const tick = async () => {
        if (Date.now() > deadline) return stopWatching();
        const status = await fetchAccount(id);
        if (!status) return;
        remember(status);
        redraw();

        const mine = status.mine;
        if (!mine?.found) {
            // Запрос ещё не долетел до сервера — или уже отработал, пока мы не смотрели.
            if (seen) stopWatching();
            return;
        }
        seen = true;

        if (mine.state === 'active') {
            notify('Начинаю генерацию. Жди.');
            return stopWatching();
        }

        // Наш запрос ждёт — значит аккаунт занят чем-то другим. Чем именно, и надолго ли.
        if (status.state === 'generating' && !toldGenerating) {
            toldGenerating = true;
            notify('Аккаунт генерирует.');
        }
        if (status.state === 'resting' && !toldResting) {
            toldResting = true;
            const left = Math.max(1, Number(status.rest_left) || 0);
            notify(`Аккаунт отдыхает ${left} ${secondsWord(left)}.`);
        }
    };

    watcher = setInterval(tick, POLL_MS);
    setTimeout(tick, FIRST_POLL_MS);
}

function newRequestId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Запоминаем, служебная ли это генерация: тип известен только здесь. */
function onGenerationStarted(type, _options, dryRun) {
    skipNext = Boolean(dryRun) || SKIP_TYPES.includes(type);
    stopWatching();
}

/**
 * Помечаем свой запрос — но только если он идёт на наш сервис. Таверна складывает
 * заголовки кастомного эндпоинта из generate_data.custom_include_headers (YAML), и это
 * поле относится только к текущей отправке. Чужие заголовки сохраняем.
 */
function onSettingsReady(generateData) {
    if (skipNext || !generateData) return;
    const { url, key } = config();
    // Не настроено или таверна шлёт не к нам — тихо проходим мимо. Что именно не так,
    // человек посмотрит в настройках расширения по кнопке «Проверить».
    if (!normalizeBase(url) || !key || !generationGoesToOurService()) return;
    const id = newRequestId();
    const existing = String(generateData.custom_include_headers ?? '').trimEnd();
    generateData.custom_include_headers = (existing ? existing + '\n' : '') + `${HEADER}: ${id}`;
    watchRequest(id);
}

/**
 * Что сейчас не так. Возвращает {ok, text} — без единого обращения к DOM, чтобы это
 * можно было проверить тестами.
 */
async function checkStatus() {
    const { url, key } = config();
    if (!String(url).trim() && !String(key).trim()) return { ok: false, text: 'Заполните адрес и ключ.' };
    if (!String(url).trim()) return { ok: false, text: 'Не указан адрес сервиса.' };
    if (!String(key).trim()) return { ok: false, text: 'Не указан ключ.' };

    const base = normalizeBase(url);
    if (!base) return { ok: false, text: 'Адрес должен начинаться с http:// или https://' };
    // Ключ уезжает в HTTP-заголовке: непечатаемое или не-ASCII там уронит сам запрос,
    // и без этой проверки человек получил бы «сервер не отвечает» вместо правды.
    if (!/^[\x21-\x7e]+$/.test(String(key).trim())) {
        return { ok: false, text: 'Ключ содержит недопустимые символы — скопируйте его заново.' };
    }

    let response;
    try {
        response = await fetch(`${base}/account/status`, {
            cache: 'no-store',
            headers: { Authorization: `Bearer ${String(key).trim()}` },
            signal: typeof AbortSignal?.timeout === 'function'
                ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined,
        });
    } catch {
        return { ok: false, text: `Сервер не отвечает: ${base}` };
    }
    if (response.status === 401 || response.status === 403) return { ok: false, text: 'Ключ не подходит.' };
    if (response.status === 404) {
        return { ok: false, text: 'Сервер не отдаёт состояние аккаунта — нужна версия main.py из папки abuba.' };
    }
    if (!response.ok) return { ok: false, text: `Сервер ответил ошибкой ${response.status}.` };

    let data = null;
    try { data = await response.json(); } catch { /* not json */ }
    if (typeof data?.state !== 'string') {
        return { ok: false, text: 'Сервер не отдаёт состояние аккаунта — нужна версия main.py из папки abuba.' };
    }
    remember(data);

    // Связь с сервисом есть. Дальше — уйдёт ли к нему вообще текущая генерация.
    const api = tavernApi();
    const source = tavernSource();
    if ((api && api !== 'openai') || (source && source !== 'custom')) {
        return { ok: false, text: 'Выбран другой источник. Не работаю.' };
    }
    const tavern = tavernUrl();
    if (!normalizeBase(tavern)) {
        return { ok: false, text: 'Связь есть, но в таверне не задан кастомный эндпоинт — уведомлений не будет.' };
    }
    if (serviceKey(tavern) !== serviceKey(url)) {
        return { ok: false, text: `Связь есть, но таверна отправляет запросы на другой адрес (${normalizeBase(tavern)}) — уведомлений не будет.` };
    }
    return { ok: true, text: 'Подключено. Уведомления будут приходить.' };
}


// ---------- Состояние аккаунта: одно на всех, кто его показывает ----------

/** Секунды в 1:05, чтобы длинный отдых читался с одного взгляда. */
function clock(seconds) {
    const s = Math.max(0, Math.round(seconds));
    return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s} с`;
}

function remember(status) {
    if (!status) return;
    live = { state: status.state, restLeft: Number(status.rest_left) || 0, at: Date.now() };
}

/** Что показать сейчас: отдых тикает локально, между запросами к серверу. */
function accountLine() {
    if (!live.state) return { text: 'Состояние: —', color: '' };
    if (live.state === 'generating') return { text: 'Аккаунт генерирует', color: '#fbbf24' };
    if (live.state === 'resting') {
        const left = live.restLeft - (Date.now() - live.at) / 1000;
        // Ноль на экране, пока сервер не подтвердил освобождение: врать «свободен» рано.
        return { text: `Аккаунт отдыхает: ${clock(left)}`, color: '#fbbf24' };
    }
    return { text: 'Аккаунт свободен', color: '#4ade80' };
}

function redraw() {
    const { text, color } = accountLine();
    const inSettings = globalThis.document?.getElementById('syntx-account-live');
    if (inSettings) {
        inSettings.textContent = text;
        inSettings.style.color = color;
    }
    const inBubble = globalThis.document?.getElementById('syntx-account-bubble');
    if (inBubble) {
        inBubble.textContent = text;
        inBubble.style.color = color || '#e5e7eb';
    }
}

// Спрашиваем сервер, только пока на состояние кто-то смотрит: раскрытые настройки или
// открытое окошко у кружка. Закрыли оба — перестаём стучаться.
const watchers = new Set();
let statusPoll = null;
let statusTick = null;

async function askStatus() {
    const status = await fetchAccount(null);
    if (status) remember(status);
    else live = { state: null, restLeft: 0, at: Date.now() };
    redraw();
}

function wantStatus(who, on) {
    if (on) watchers.add(who); else watchers.delete(who);
    if (watchers.size && !statusPoll) {
        statusPoll = setInterval(askStatus, STATUS_POLL_MS);
        statusTick = setInterval(redraw, STATUS_TICK_MS);
        askStatus();
    } else if (!watchers.size && statusPoll) {
        clearInterval(statusPoll);
        clearInterval(statusTick);
        statusPoll = statusTick = null;
    }
}


// ---------- Плавающий кружок ----------

/**
 * Держим кружок в пределах экрана. Считается по одному кружку, без окошка: окошко
 * рисуется рядом и на видимость самого кружка не влияет.
 */
function clampPos(x, y, viewW, viewH, size = DOT_PX) {
    const maxX = Math.max(0, viewW - size);
    const maxY = Math.max(0, viewH - size);
    return {
        x: Math.min(Math.max(0, Number(x) || 0), maxX),
        y: Math.min(Math.max(0, Number(y) || 0), maxY),
    };
}

/** Середина экрана — сюда кружок возвращается по «Сбросу». */
function centerPos(viewW, viewH, size = DOT_PX) {
    return { x: Math.round((viewW - size) / 2), y: Math.round((viewH - size) / 2) };
}

/**
 * Розовая кошачья мордочка. Рисуем прямо здесь, а не картинкой: расширение не тянет
 * ни одного внешнего файла, и на любом размере кружка это остаётся чётким.
 * Идентификатор градиента с приставкой — в таверне на странице полно чужих svg.
 */
const DOT_SVG = `
<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="sa-face-grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffd6ea"/>
      <stop offset="1" stop-color="#ff9ac9"/>
    </linearGradient>
  </defs>
  <circle cx="20" cy="20" r="19.5" fill="url(#sa-face-grad)"/>
  <path d="M5.5 16.5 L9.6 2.2 L19.2 11.4 Z" fill="#ff9ac9"/>
  <path d="M34.5 16.5 L30.4 2.2 L20.8 11.4 Z" fill="#ff9ac9"/>
  <path d="M8.8 14.6 L11.1 5.8 L15.9 11 Z" fill="#ff6fae"/>
  <path d="M31.2 14.6 L28.9 5.8 L24.1 11 Z" fill="#ff6fae"/>
  <circle cx="8.4" cy="26.6" r="3.7" fill="#ff5f9e" opacity=".5"/>
  <circle cx="31.6" cy="26.6" r="3.7" fill="#ff5f9e" opacity=".5"/>
  <g stroke="#6d2f4e" fill="none" stroke-linecap="round">
    <path d="M11.4 23.2 q3.3 -4.2 6.6 0" stroke-width="2.7"/>
    <path d="M22 23.2 q3.3 -4.2 6.6 0" stroke-width="2.7"/>
    <path d="M16.4 27.8 q3.6 3.2 7.2 0" stroke-width="2.4"/>
  </g>
</svg>`;

const BUBBLE_FONT_CSS = (() => {
    const { min, max, atWidth, toWidth } = BUBBLE_FONT;
    const vw = (max - min) / (toWidth - atWidth) * 100;
    const base = min - (max - min) / (toWidth - atWidth) * atWidth;
    return `clamp(${min}px, calc(${vw.toFixed(3)}vw + ${base.toFixed(2)}px), ${max}px)`;
})();

const WIDGET_CSS = `
#syntx-account-widget{position:fixed;z-index:9999;width:${DOT_PX}px;height:${DOT_PX}px;
  touch-action:none;user-select:none;-webkit-user-select:none}
#syntx-account-widget .sa-dot{width:100%;height:100%;border-radius:50%;cursor:grab;
  overflow:hidden;background:#ffd6ea;border:2px solid rgba(255,255,255,.8);
  box-shadow:0 2px 10px rgba(0,0,0,.5);box-sizing:border-box}
#syntx-account-widget .sa-dot svg{display:block;width:100%;height:100%}
#syntx-account-widget .sa-bubble{position:absolute;top:50%;left:${BUBBLE_GAP}px;
  transform:translateY(-50%);padding:.55em .7em;border-radius:.55em;
  font-size:${BUBBLE_FONT_CSS};
  line-height:1.3;white-space:nowrap;font-weight:500;
  background:rgba(24,24,28,.96);border:1px solid rgba(255,255,255,.22);
  box-shadow:0 4px 16px rgba(0,0,0,.55);color:#e5e7eb;cursor:grab}
#syntx-account-widget .sa-bubble.sa-left{left:auto;right:${BUBBLE_GAP}px}
#syntx-account-widget.sa-dragging .sa-dot,#syntx-account-widget.sa-dragging .sa-bubble{cursor:grabbing}
`;

function applyPos() {
    if (!widget) return;
    const cfg = config();
    const view = { w: globalThis.innerWidth || 1024, h: globalThis.innerHeight || 768 };
    const start = (cfg.x === null || cfg.y === null) ? centerPos(view.w, view.h) : { x: cfg.x, y: cfg.y };
    const { x, y } = clampPos(start.x, start.y, view.w, view.h);
    widget.style.left = `${x}px`;
    widget.style.top = `${y}px`;
    if (cfg.x !== x || cfg.y !== y) {
        cfg.x = x;
        cfg.y = y;
        save();
    }
    layoutBubble();
}

/** Окошко открывается справа от кружка, а у правого края — слева, чтобы не уехало. */
function layoutBubble() {
    const bubble = widget?.querySelector('.sa-bubble');
    if (!bubble || bubble.hidden) return;
    const view = globalThis.innerWidth || 1024;
    const left = parseFloat(widget.style.left) || 0;
    bubble.classList.remove('sa-left');
    if (left + BUBBLE_GAP + bubble.offsetWidth > view) bubble.classList.add('sa-left');
}

function toggleBubble(open) {
    const bubble = widget?.querySelector('.sa-bubble');
    if (!bubble) return;
    bubbleOpen = open === undefined ? !bubbleOpen : Boolean(open);
    bubble.hidden = !bubbleOpen;
    wantStatus('bubble', bubbleOpen);
    if (bubbleOpen) {
        redraw();
        layoutBubble();
    }
}

function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    const cfg = config();
    drag = {
        id: event.pointerId,
        fromX: event.clientX, fromY: event.clientY,
        wasX: cfg.x ?? 0, wasY: cfg.y ?? 0,
        moved: false,
        onDot: Boolean(event.target?.closest?.('.sa-dot')),
    };
    // Захват указателя нужен, чтобы палец не «соскакивал» с кружка при быстром движении.
    // Если браузер его не даёт (или указателя уже нет), это не повод ронять перетаскивание.
    try { widget.setPointerCapture?.(event.pointerId); } catch { /* переживём */ }
    widget.classList.add('sa-dragging');
    event.preventDefault();
}

function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.fromX;
    const dy = event.clientY - drag.fromY;
    // Пока палец почти не сдвинулся, это ещё тап — иначе кружок дёргался бы от каждого
    // касания, и открыть окошко на планшете было бы невозможно.
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    drag.moved = true;
    const view = { w: globalThis.innerWidth || 1024, h: globalThis.innerHeight || 768 };
    const { x, y } = clampPos(drag.wasX + dx, drag.wasY + dy, view.w, view.h);
    widget.style.left = `${x}px`;
    widget.style.top = `${y}px`;
    layoutBubble();
}

function onPointerUp(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const { moved, onDot } = drag;
    drag = null;
    widget.classList.remove('sa-dragging');
    if (moved) {
        const cfg = config();
        cfg.x = parseFloat(widget.style.left) || 0;
        cfg.y = parseFloat(widget.style.top) || 0;
        save();
    } else if (onDot) {
        toggleBubble();
    }
}

function mountWidget() {
    const doc = globalThis.document;
    if (!doc || widget) return;
    if (!doc.getElementById('syntx-account-css')) {
        const style = doc.createElement('style');
        style.id = 'syntx-account-css';
        style.textContent = WIDGET_CSS;
        doc.head.append(style);
    }
    widget = doc.createElement('div');
    widget.id = 'syntx-account-widget';
    widget.innerHTML = `<div class="sa-dot">${DOT_SVG}</div>`
        + '<div class="sa-bubble" id="syntx-account-bubble" hidden></div>';
    doc.body.append(widget);

    widget.addEventListener('pointerdown', onPointerDown);
    widget.addEventListener('pointermove', onPointerMove);
    widget.addEventListener('pointerup', onPointerUp);
    widget.addEventListener('pointercancel', onPointerUp);
    globalThis.addEventListener?.('resize', applyPos);

    bubbleOpen = false;
    applyPos();
}

function unmountWidget() {
    if (!widget) return;
    globalThis.removeEventListener?.('resize', applyPos);
    widget.remove();
    widget = null;
    drag = null;
    bubbleOpen = false;
    wantStatus('bubble', false);
}

function syncWidget() {
    if (config().icon) mountWidget();
    else unmountWidget();
}

/** «Сброс»: кружок возвращается в середину экрана, откуда его можно утащить куда надо. */
function resetPosition() {
    const cfg = config();
    const { x, y } = centerPos(globalThis.innerWidth || 1024, globalThis.innerHeight || 768);
    cfg.x = x;
    cfg.y = y;
    save();
    applyPos();
}


// ---------- Настройки в списке расширений ----------

const SETTINGS_HTML = `
<div class="syntx-account-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Статус аккаунта Syntx</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label for="syntx-account-url" style="display:block">Адрес сервиса</label>
      <input id="syntx-account-url" class="text_pole widthNatural" type="text"
             style="display:block;width:100%;box-sizing:border-box" placeholder="https://example.com/syn">
      <label for="syntx-account-key" style="display:block;margin-top:10px">Ключ</label>
      <input id="syntx-account-key" class="text_pole widthNatural" type="password"
             style="display:block;width:100%;box-sizing:border-box" placeholder="syn-…">
      <label for="syntx-account-icon"
             style="display:flex;align-items:center;gap:8px;margin-top:12px;cursor:pointer">
        <input id="syntx-account-icon" type="checkbox">
        <span>Иконка</span>
      </label>
      <div style="margin-top:10px;padding:6px 8px;border-radius:6px;background:rgba(255,255,255,.06)">
        <span id="syntx-account-live" style="font-size:13px">Состояние: —</span>
      </div>
      <div style="margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <button id="syntx-account-check" class="menu_button">Проверить</button>
        <button id="syntx-account-reset" class="menu_button">Сброс</button>
        <span id="syntx-account-status" style="font-size:12px;opacity:.85"></span>
      </div>
    </div>
  </div>
</div>`;

async function refreshStatusLine() {
    const el = globalThis.document?.getElementById('syntx-account-status');
    if (!el) return;
    el.textContent = 'Проверяю…';
    el.style.color = '';
    const { ok, text } = await checkStatus();
    el.textContent = (ok ? '✅ ' : '⚠️ ') + text;
    el.style.color = ok ? '#4ade80' : '#fbbf24';
    redraw();
}

function mountSettings() {
    const host = globalThis.document?.getElementById('extensions_settings');
    if (!host || host.querySelector('.syntx-account-settings')) return;
    const holder = document.createElement('div');
    holder.innerHTML = SETTINGS_HTML;
    const root = holder.firstElementChild;
    host.append(root);

    const current = config();
    let debounce = null;
    for (const [id, field] of [['syntx-account-url', 'url'], ['syntx-account-key', 'key']]) {
        const input = document.getElementById(id);
        if (!input) continue;
        input.value = current[field] ?? '';
        input.addEventListener('input', () => {
            config()[field] = input.value.trim();
            save();
            clearTimeout(debounce);
            debounce = setTimeout(refreshStatusLine, 700);
        });
    }

    const icon = document.getElementById('syntx-account-icon');
    if (icon) {
        icon.checked = Boolean(current.icon);
        icon.addEventListener('change', () => {
            config().icon = icon.checked;
            save();
            syncWidget();
        });
    }

    document.getElementById('syntx-account-check')?.addEventListener('click', (e) => {
        e.preventDefault();
        refreshStatusLine();
    });
    document.getElementById('syntx-account-reset')?.addEventListener('click', (e) => {
        e.preventDefault();
        resetPosition();
    });

    // Состояние спрашиваем, только пока ящик раскрыт. Класс на содержимом ставит сама
    // таверна, поэтому смотрим на видимость, а не на её внутренние флаги.
    const drawer = root.querySelector('.inline-drawer-content');
    const isOpen = () => Boolean(drawer && drawer.offsetParent !== null);
    root.querySelector('.inline-drawer-toggle')?.addEventListener('click', () => {
        setTimeout(() => wantStatus('settings', isOpen()), 100);
    });
    if (isOpen()) wantStatus('settings', true);

    refreshStatusLine();
}

function subscribe() {
    const ctx = context();
    const events = ctx?.eventSource;
    const types = ctx?.eventTypes ?? ctx?.event_types;
    if (!events || !types) {
        setTimeout(subscribe, 500);   // таверна ещё не поднялась
        return;
    }
    events.on(types.GENERATION_STARTED, onGenerationStarted);
    events.on(types.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);
    events.on(types.GENERATION_ENDED, stopWatching);
    events.on(types.GENERATION_STOPPED, stopWatching);
    mountSettings();
    syncWidget();
    if (types.APP_READY) events.on(types.APP_READY, () => { mountSettings(); syncWidget(); });
}

subscribe();

// Только для тестов — таверна эти экспорты не использует.
export const _internals = {
    SETTINGS_HTML, DEFAULTS, DOT_PX, DOT_SVG, WIDGET_CSS, BUBBLE_FONT, bubbleFontAt,
    secondsWord, clock, normalizeBase, serviceKey, config, generationGoesToOurService,
    tavernSource, tavernApi, checkStatus, accountLine, remember, redraw,
    clampPos, centerPos, resetPosition, syncWidget, toggleBubble, wantStatus,
    onGenerationStarted, onSettingsReady, mountSettings, stopWatching, fetchAccount,
    _live: () => live, _setLive: (v) => { live = v; },
};
