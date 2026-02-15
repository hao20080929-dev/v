const APP_KEY = 'expTimerAppState';
const LEGACY_S_KEY = 'cumulativeSeconds';
const LEGACY_T_KEY = 'lastTimestamp';

const SEC_MS = 1000;
const MIN = 60;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('service-worker.js');
}

let deferredInstallPrompt = null;
function setupInstallButton() {
  const btnInstall = document.getElementById('btn-install');
  if (!btnInstall) return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    btnInstall.hidden = false;
  });
  btnInstall.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    btnInstall.disabled = true;
    try {
      await deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
    } finally {
      deferredInstallPrompt = null;
      btnInstall.hidden = true;
      btnInstall.disabled = false;
    }
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    btnInstall.hidden = true;
  });
}

function pad(n, len) {
  const s = String(n);
  if (s.length >= len) return s;
  return '0'.repeat(len - s.length) + s;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function setText(el, text) {
  if (!el) return;
  if (el.textContent !== text) el.textContent = text;
}

function createId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function defaultState() {
  return {
    version: 1,
    settings: {
      background: '#0f380f',
      glow: '#9bbc0f'
    },
    items: [
      {
        id: createId(),
        name: '預設項目',
        emoji: '',
        totalSeconds: 0,
        running: false,
        lastTimestamp: 0
      }
    ],
    activeItemId: null
  };
}

function readLegacyNumber(key, fallback) {
  const v = localStorage.getItem(key);
  if (!v) return fallback;
  const n = parseInt(v, 10);
  if (Number.isNaN(n) || n < 0) return fallback;
  return n;
}

function loadState() {
  const raw = localStorage.getItem(APP_KEY);
  const parsed = raw ? safeJsonParse(raw) : null;
  if (parsed && typeof parsed === 'object') {
    return normalizeState(parsed);
  }

  const legacySeconds = readLegacyNumber(LEGACY_S_KEY, 0);
  const legacyLast = readLegacyNumber(LEGACY_T_KEY, 0);

  const s = defaultState();
  const item = s.items[0];
  item.totalSeconds = legacySeconds;
  item.running = legacyLast > 0;
  item.lastTimestamp = legacyLast > 0 ? legacyLast : 0;
  s.activeItemId = null;
  return s;
}

function normalizeItem(x) {
  if (!x || typeof x !== 'object') return null;
  const id = typeof x.id === 'string' && x.id ? x.id : createId();
  const name = typeof x.name === 'string' && x.name.trim() ? x.name.trim().slice(0, 24) : '未命名';
  const emoji = typeof x.emoji === 'string' ? x.emoji.slice(0, 4) : '';
  const totalSeconds = Number.isFinite(x.totalSeconds) ? Math.max(0, Math.floor(x.totalSeconds)) : 0;
  const running = x.running === true;
  const lastTimestamp = Number.isFinite(x.lastTimestamp) ? Math.max(0, Math.floor(x.lastTimestamp)) : 0;
  return { id, name, emoji, totalSeconds, running, lastTimestamp };
}

function normalizeState(x) {
  const s = defaultState();
  if (!x || typeof x !== 'object') return s;
  const itemsRaw = Array.isArray(x.items) ? x.items : [];
  const items = itemsRaw.map(normalizeItem).filter(Boolean);
  s.items = items.length ? items : s.items;
  const settings = x.settings && typeof x.settings === 'object' ? x.settings : {};
  if (typeof settings.background === 'string' && settings.background) s.settings.background = settings.background;
  if (typeof settings.glow === 'string' && settings.glow) s.settings.glow = settings.glow;
  s.activeItemId = typeof x.activeItemId === 'string' ? x.activeItemId : null;
  return s;
}

function saveState(state) {
  localStorage.setItem(APP_KEY, JSON.stringify(state));
}

function settleAndPauseAll(state) {
  const now = Date.now();
  for (const item of state.items) {
    if (item.running && item.lastTimestamp > 0) {
      const delta = Math.floor((now - item.lastTimestamp) / SEC_MS);
      if (delta > 0) item.totalSeconds += delta;
    }
    item.running = false;
    item.lastTimestamp = 0;
  }
}

function formatYDHMS(totalSeconds) {
  let s = totalSeconds;
  const years = Math.floor(s / YEAR);
  s -= years * YEAR;
  const days = Math.floor(s / DAY);
  s -= days * DAY;
  const hours = Math.floor(s / HOUR);
  s -= hours * HOUR;
  const minutes = Math.floor(s / MIN);
  s -= minutes * MIN;
  const seconds = s;
  return `${pad(years, 3)}:${pad(days, 3)}:${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}`;
}

function levelInfo(totalSeconds) {
  const exact = Math.sqrt(totalSeconds) / 10;
  const level = Math.floor(exact);
  const prev = (level * 10) ** 2;
  const next = ((level + 1) * 10) ** 2;
  const progress = next === prev ? 1 : clamp((totalSeconds - prev) / (next - prev), 0, 1);
  return { level, prev, next, progress };
}

function createExpSegments(container) {
  container.innerHTML = '';
  const segs = [];
  for (let i = 0; i < 60; i += 1) {
    const d = document.createElement('div');
    d.className = 'exp-seg';
    container.appendChild(d);
    segs.push(d);
  }
  return segs;
}

function updateExp(segs, totalSeconds) {
  const filled = totalSeconds % 60;
  for (let i = 0; i < segs.length; i += 1) {
    if (i <= filled) segs[i].classList.add('filled');
    else segs[i].classList.remove('filled');
  }
}

function applyTheme(settings) {
  const root = document.documentElement;
  root.style.setProperty('--user-bg', settings.background);
  root.style.setProperty('--user-glow', settings.glow);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', settings.background);
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function openDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

function start() {
  const elItems = document.getElementById('items');
  const viewList = document.getElementById('view-list');
  const viewTimer = document.getElementById('view-timer');
  const btnHome = document.getElementById('btn-home');
  const btnBack = document.getElementById('btn-back');
  const btnAddItem = document.getElementById('btn-add-item');
  const btnEditItem = document.getElementById('btn-edit-item');
  const btnStart = document.getElementById('btn-start');
  const btnPause = document.getElementById('btn-pause');
  const btnSettings = document.getElementById('btn-settings');
  const btnBackup = document.getElementById('btn-backup');
  const fileImport = document.getElementById('file-import');

  const dialogAdd = document.getElementById('dialog-add-item');
  const dialogItemTitle = document.getElementById('dialog-item-title');
  const inputName = document.getElementById('item-name');
  const selectEmoji = document.getElementById('item-emoji');
  const btnSaveItem = document.getElementById('btn-save-item');

  const dialogSettings = document.getElementById('dialog-settings');
  const colorBg = document.getElementById('color-bg');
  const colorGlow = document.getElementById('color-glow');

  const timerEl = document.getElementById('timer');
  const expContainer = document.getElementById('exp-bar');
  const activeName = document.getElementById('active-name');
  const activeEmoji = document.getElementById('active-emoji');
  const levelEl = document.getElementById('level');
  const levelNextEl = document.getElementById('level-next');
  const levelProgress = document.getElementById('level-progress');

  let state = loadState();
  settleAndPauseAll(state);
  applyTheme(state.settings);
  saveState(state);
  setupInstallButton();

  let expSegs = [];
  let tickTimerId = null;
  let editingItemId = null;

  function findItem(id) {
    return state.items.find(i => i.id === id) || null;
  }

  function showList() {
    viewList.classList.remove('is-hidden');
    viewTimer.classList.add('is-hidden');
    viewTimer.setAttribute('aria-hidden', 'true');
    viewList.setAttribute('aria-hidden', 'false');
    state.activeItemId = null;
    saveState(state);
    renderList();
    updateControls();
  }

  function showTimer(id) {
    const item = findItem(id);
    if (!item) return;
    state.activeItemId = item.id;
    saveState(state);
    viewList.classList.add('is-hidden');
    viewTimer.classList.remove('is-hidden');
    viewList.setAttribute('aria-hidden', 'true');
    viewTimer.setAttribute('aria-hidden', 'false');
    expSegs = createExpSegments(expContainer);
    renderTimer();
    updateControls();
  }

  function updateControls() {
    const item = state.activeItemId ? findItem(state.activeItemId) : null;
    const running = item ? item.running : false;
    if (btnStart) btnStart.disabled = !item || running;
    if (btnPause) btnPause.disabled = !item || !running;
  }

  function renderList() {
    elItems.innerHTML = '';
    for (const item of state.items) {
      const info = levelInfo(item.totalSeconds);

      const row = document.createElement('div');
      row.className = 'item-row';

      const card = document.createElement('div');
      card.className = 'item-card nes-container is-dark';

      const left = document.createElement('div');
      left.className = 'item-left';

      const e = document.createElement('div');
      e.className = 'item-emoji';
      e.textContent = item.emoji || '⬚';

      const name = document.createElement('div');
      name.className = 'item-name';
      name.textContent = item.name;

      left.appendChild(e);
      left.appendChild(name);

      const right = document.createElement('div');
      right.className = 'item-right';

      const time = document.createElement('div');
      time.className = 'item-time';
      time.textContent = formatYDHMS(item.totalSeconds);

      const mini = document.createElement('progress');
      mini.className = 'nes-progress is-primary mini-progress';
      mini.max = 100;
      mini.value = Math.round(info.progress * 100);

      const lv = document.createElement('div');
      lv.className = 'scale-label';
      lv.textContent = `LV ${info.level}`;

      right.appendChild(time);
      right.appendChild(mini);
      right.appendChild(lv);

      card.appendChild(left);
      card.appendChild(right);

      const openBtn = document.createElement('button');
      openBtn.className = 'nes-btn is-dark item-btn item-open';
      openBtn.type = 'button';
      openBtn.dataset.id = item.id;
      openBtn.dataset.action = 'open';
      openBtn.appendChild(card);

      const editBtn = document.createElement('button');
      editBtn.className = 'nes-btn is-primary item-edit';
      editBtn.type = 'button';
      editBtn.dataset.id = item.id;
      editBtn.dataset.action = 'edit';
      editBtn.textContent = '修改';

      row.appendChild(openBtn);
      row.appendChild(editBtn);
      elItems.appendChild(row);
    }
  }

  function renderTimer() {
    const item = state.activeItemId ? findItem(state.activeItemId) : null;
    if (!item) return;

    setText(activeName, item.name);
    setText(activeEmoji, item.emoji || '');
    setText(timerEl, formatYDHMS(item.totalSeconds));
    updateExp(expSegs, item.totalSeconds);

    const info = levelInfo(item.totalSeconds);
    setText(levelEl, String(info.level));
    const remain = Math.max(0, info.next - item.totalSeconds);
    setText(levelNextEl, `下一級還差 ${remain} 秒`);
    if (levelProgress) levelProgress.value = Math.round(info.progress * 100);
  }

  function stepRunningItems() {
    const now = Date.now();
    let changed = false;
    for (const item of state.items) {
      if (!item.running || item.lastTimestamp <= 0) continue;
      const delta = Math.floor((now - item.lastTimestamp) / SEC_MS);
      if (delta <= 0) continue;
      item.totalSeconds += delta;
      item.lastTimestamp += delta * SEC_MS;
      changed = true;
    }
    if (changed) saveState(state);
  }

  function scheduleTick() {
    if (tickTimerId) clearTimeout(tickTimerId);
    const now = Date.now();
    const next = Math.ceil(now / SEC_MS) * SEC_MS;
    tickTimerId = setTimeout(() => {
      stepRunningItems();
      if (!viewTimer.classList.contains('is-hidden')) renderTimer();
      if (!viewList.classList.contains('is-hidden')) renderList();
      scheduleTick();
    }, Math.max(0, next - now));
  }

  function startActive() {
    const item = state.activeItemId ? findItem(state.activeItemId) : null;
    if (!item || item.running) return;
    item.running = true;
    item.lastTimestamp = Date.now();
    saveState(state);
    updateControls();
  }

  function pauseActive() {
    const item = state.activeItemId ? findItem(state.activeItemId) : null;
    if (!item || !item.running) return;
    stepRunningItems();
    item.running = false;
    item.lastTimestamp = 0;
    saveState(state);
    updateControls();
    renderTimer();
  }

  function addItem(name, emoji) {
    const item = {
      id: createId(),
      name: (name || '').trim().slice(0, 24) || '未命名',
      emoji: (emoji || '').slice(0, 4),
      totalSeconds: 0,
      running: false,
      lastTimestamp: 0
    };
    state.items.unshift(item);
    saveState(state);
    renderList();
  }

  function ensureEmojiOption(value) {
    if (!selectEmoji) return;
    if (!value) return;
    const existing = Array.from(selectEmoji.options).some(o => o.value === value);
    if (existing) return;
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = `${value} 自訂`;
    selectEmoji.appendChild(opt);
  }

  function updateItem(id, name, emoji) {
    const item = findItem(id);
    if (!item) return;
    item.name = (name || '').trim().slice(0, 24) || '未命名';
    item.emoji = (emoji || '').slice(0, 4);
    saveState(state);
    if (!viewTimer.classList.contains('is-hidden')) renderTimer();
    if (!viewList.classList.contains('is-hidden')) renderList();
  }

  function handleBackup() {
    const dt = new Date();
    const y = String(dt.getFullYear());
    const m = pad(dt.getMonth() + 1, 2);
    const d = pad(dt.getDate(), 2);
    const hh = pad(dt.getHours(), 2);
    const mm = pad(dt.getMinutes(), 2);
    const ss = pad(dt.getSeconds(), 2);
    downloadJson(`exp-timer-backup-${y}${m}${d}-${hh}${mm}${ss}.json`, state);
  }

  function handleImport(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = typeof reader.result === 'string' ? safeJsonParse(reader.result) : null;
      const normalized = parsed ? normalizeState(parsed) : null;
      if (!normalized) return;
      state = normalized;
      state.activeItemId = null;
      applyTheme(state.settings);
      saveState(state);
      showList();
    };
    reader.readAsText(file);
  }

  function openAddDialog() {
    editingItemId = null;
    if (inputName) inputName.value = '';
    if (selectEmoji) selectEmoji.value = '';
    if (dialogItemTitle) dialogItemTitle.textContent = '新增項目';
    if (btnSaveItem) btnSaveItem.textContent = '新增';
    openDialog(dialogAdd);
    if (inputName) inputName.focus();
  }

  function openEditDialog(itemId) {
    const item = findItem(itemId);
    if (!item) return;
    editingItemId = item.id;
    if (inputName) inputName.value = item.name;
    ensureEmojiOption(item.emoji);
    if (selectEmoji) selectEmoji.value = item.emoji || '';
    if (dialogItemTitle) dialogItemTitle.textContent = '修改項目';
    if (btnSaveItem) btnSaveItem.textContent = '儲存';
    openDialog(dialogAdd);
    if (inputName) inputName.focus();
  }

  function openSettingsDialog() {
    if (colorBg) colorBg.value = state.settings.background;
    if (colorGlow) colorGlow.value = state.settings.glow;
    openDialog(dialogSettings);
  }

  elItems.addEventListener('click', e => {
    const el = e.target.closest('[data-action][data-id]');
    if (!el) return;
    const id = el.dataset.id;
    const action = el.dataset.action;
    if (!id || !action) return;
    if (action === 'open') showTimer(id);
    if (action === 'edit') openEditDialog(id);
  });

  if (btnHome) btnHome.addEventListener('click', showList);
  if (btnBack) btnBack.addEventListener('click', showList);
  if (btnAddItem) btnAddItem.addEventListener('click', openAddDialog);
  if (btnEditItem) btnEditItem.addEventListener('click', () => {
    if (!state.activeItemId) return;
    openEditDialog(state.activeItemId);
  });
  if (btnStart) btnStart.addEventListener('click', startActive);
  if (btnPause) btnPause.addEventListener('click', pauseActive);
  if (btnSettings) btnSettings.addEventListener('click', openSettingsDialog);
  if (btnBackup) btnBackup.addEventListener('click', handleBackup);

  if (btnSaveItem) {
    btnSaveItem.addEventListener('click', e => {
      e.preventDefault();
      const name = inputName ? inputName.value : '';
      const emoji = selectEmoji ? selectEmoji.value : '';
      if (editingItemId) updateItem(editingItemId, name, emoji);
      else addItem(name, emoji);
      closeDialog(dialogAdd);
    });
  }

  if (colorBg) {
    colorBg.addEventListener('input', () => {
      state.settings.background = colorBg.value;
      applyTheme(state.settings);
      saveState(state);
    });
  }
  if (colorGlow) {
    colorGlow.addEventListener('input', () => {
      state.settings.glow = colorGlow.value;
      applyTheme(state.settings);
      saveState(state);
    });
  }

  if (fileImport) {
    fileImport.addEventListener('change', () => {
      const file = fileImport.files && fileImport.files[0];
      handleImport(file);
      fileImport.value = '';
    });
  }

  showList();
  scheduleTick();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
