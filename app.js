'use strict';

/* =========================================================
 * 影片字幕編輯器
 *  - 左上：影片（可直接點字幕編輯、可畫記）
 *  - 左下：時間軸（時間尺 / 字幕軌 / 音軌波形，可框選刪除片段）
 *  - 右側分頁：字幕校對、審片留言、刪除片段
 * ========================================================= */

const $ = (s) => document.querySelector(s);

const video = $('#video');
const player = $('#player');
const subLayer = $('#subLayer');
const overlay = $('#subOverlay');
const canvas = $('#timeline');
const ctx = canvas.getContext('2d');
const hscroll = $('#hscroll');
const zoomInput = $('#zoom');
const listEl = $('#subList');
const cutListEl = $('#cutList');
const noteListEl = $('#noteList');
const noteText = $('#noteText');
const timeLabel = $('#timeLabel');
const playBtn = $('#playBtn');
const drawCanvas = $('#drawCanvas');
const dctx = drawCanvas.getContext('2d');

const STORAGE_KEY = 'subtitle-editor-v1';
const MIN_LEN = 0.1;       // 字幕 / 刪除片段最短長度（秒）
const DEFAULT_LEN = 2;     // 新字幕預設長度（秒）
const FRAME = 1 / 30;

const state = {
  subs: [],                // { id, start, end, text, orig? }  orig = 修改前的原文
  cuts: [],                // { id, start, end }  要刪除的片段（不重疊、已排序）
  notes: [],               // { id, time, text, thumb, drawn } 審片留言
  selectedId: null,        // 選取的字幕
  selCutId: null,          // 選取的刪除片段
  sel: null,               // 音軌上框選的範圍 { start, end }
  activeId: null,
  duration: 0,
  pps: 64,                 // pixels per second
  scroll: 0,               // 時間軸左緣的秒數
  peaks: null,             // Float32Array [min, max, min, max, ...]
  peaksRate: 200,          // 每秒幾個 bucket
  audioStatus: 'none',     // none | loading | ready | noaudio | error
  videoName: 'subtitles',
  skipCuts: true,          // 播放時跳過刪除片段
  playUntil: null,         // 試聽：播到這個時間就停
  playSkip: false,         // 試聽時是否跳過刪除片段
  draft: { time: null },   // 正在寫的留言（time 鎖定）
  strokes: [],             // 畫記筆畫 [{ color, pts: [[x,y]...] }]，座標 0..1
  drawMode: false,
  drawColor: '#ffb800',
  style: {
    size: 5,               // 影片高度的百分比
    pos: 8,                // 距離底部（影片高度百分比）
    color: '#ffffff',
    bg: '#000000',
    bgA: 0.55,
    outline: true,
    bold: true,
  },
};
let nextId = 1;
let dirty = true;
let exporting = null;

/* ---------------- 時間格式 ---------------- */

const pad = (n, l = 2) => String(n).padStart(l, '0');

/** 顯示用：mm:ss.mmm（超過一小時為 h:mm:ss.mmm） */
function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return (h ? h + ':' : '') + pad(m) + ':' + pad(s) + '.' + pad(r, 3);
}

/** 短格式：mm:ss.s */
function fmtShort(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const d = Math.round(t * 10);
  const m = Math.floor(d / 600);
  const s = (d - m * 600) / 10;
  return pad(m) + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}

/** 字幕檔用：hh:mm:ss,mmm */
function fmtFile(t, sep) {
  const ms = Math.max(0, Math.round(t * 1000));
  return pad(Math.floor(ms / 3600000)) + ':' + pad(Math.floor((ms % 3600000) / 60000)) + ':' +
    pad(Math.floor((ms % 60000) / 1000)) + sep + pad(ms % 1000, 3);
}

/** 時間尺標籤 */
function fmtRuler(t, step) {
  const dec = step < 1 ? 1 : 0;
  const tenths = Math.round(t * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths - m * 600) / 10;
  const h = Math.floor(m / 60);
  const mm = h ? pad(m % 60) : String(m);
  return (h ? h + ':' : '') + mm + ':' + (s < 10 ? '0' : '') + s.toFixed(dec);
}

/**
 * 解析使用者輸入的時間，支援：
 *   83.5 / 1:23.5 / 01:23,500 / 00:01:23.500 / 1分23秒 / 1分23.5秒 / 1小時2分3秒
 */
function parseTime(input) {
  const str = String(input ?? '').trim().replace(/：/g, ':').replace(/，/g, ',').replace(',', '.');
  if (!str) return NaN;
  const zh = str.match(/^(?:(\d+)\s*(?:小時|時|h))?\s*(?:(\d+)\s*(?:分鐘|分|m))?\s*(?:(\d+(?:\.\d+)?)\s*(?:秒|s)?)?$/i);
  if (zh && (zh[1] || zh[2] || zh[3]) && /[小時分秒hms]/i.test(str)) {
    return (+zh[1] || 0) * 3600 + (+zh[2] || 0) * 60 + (+zh[3] || 0);
  }
  const parts = str.split(':');
  if (parts.length > 3 || parts.some((p) => p === '' || isNaN(p))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + parseFloat(p), 0);
}

/* ---------------- 復原 / 重做（字幕 + 刪除片段） ---------------- */

const undoStack = [];
const redoStack = [];
function snapshot(subs = state.subs) { return JSON.stringify({ subs, cuts: state.cuts }); }
function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}
function restore(json) {
  const d = JSON.parse(json);
  state.subs = d.subs;
  state.cuts = d.cuts || [];
  if (!byId(state.selectedId)) state.selectedId = null;
  if (!cutById(state.selCutId)) state.selCutId = null;
  changed();
}
function undo() {
  if (!undoStack.length) return toast('沒有可以復原的動作');
  redoStack.push(snapshot());
  restore(undoStack.pop());
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
}

/* ---------------- 字幕資料操作 ---------------- */

const byId = (id) => state.subs.find((s) => s.id === id);
function sortSubs() { state.subs.sort((a, b) => a.start - b.start || a.end - b.end); }
function subAt(t) {
  // 重疊時取最晚開始的那條
  let found = null;
  for (const s of state.subs) if (t >= s.start && t < s.end) found = s;
  return found;
}
function maxTime() { return state.duration || Infinity; }
const isEdited = (s) => s.orig !== undefined && s.orig !== s.text;

/** 改字幕文字，第一次修改時保留原文以便對照 */
function setText(s, text) {
  if (s.orig === undefined && s.text !== '' && s.text !== text) s.orig = s.text;
  s.text = text;
}

/** 在 t 開始的新字幕預設結束時間：預設長度，但不超過下一條字幕或影片結尾 */
function defaultEnd(t) {
  let end = t + DEFAULT_LEN;
  for (const s of state.subs) if (s.start > t + 1e-6 && s.start < end) end = s.start;
  end = Math.min(end, maxTime());
  if (end - t < MIN_LEN) end = t + DEFAULT_LEN;
  return end;
}

function addSub(start, end, text = '', { undoable = true } = {}) {
  if (undoable) pushUndo();
  start = Math.max(0, start);
  if (!(end > start + MIN_LEN / 2)) end = defaultEnd(start);
  const sub = { id: nextId++, start, end, text };
  state.subs.push(sub);
  sortSubs();
  state.selectedId = sub.id;
  state.selCutId = null;
  changed();
  return sub;
}

function deleteSub(id) {
  const i = state.subs.findIndex((s) => s.id === id);
  if (i < 0) return;
  pushUndo();
  state.subs.splice(i, 1);
  if (state.selectedId === id) state.selectedId = null;
  changed();
}

function splitAt(t) {
  const s = subAt(t);
  if (!s || t - s.start < MIN_LEN || s.end - t < MIN_LEN) return toast('目前時間沒有可以分割的字幕');
  pushUndo();
  const tail = { id: nextId++, start: t, end: s.end, text: s.text };
  if (s.orig !== undefined) tail.orig = s.orig;
  s.end = t;
  state.subs.push(tail);
  sortSubs();
  state.selectedId = tail.id;
  changed();
  toast('已分割字幕');
}

/** 字幕校對：從游標位置把一句拆成兩句，時間依字數比例切開 */
function splitText(s, pos) {
  const text = s.text;
  const a = text.slice(0, pos).replace(/\s+$/, '');
  const b = text.slice(pos).replace(/^\s+/, '');
  if (!a || !b) return toast('把游標放在句子中間，再按 Ctrl+Enter 拆句');
  if (s.end - s.start < MIN_LEN * 2) return toast('這句太短，無法再拆');
  pushUndo();
  const ratio = [...text.slice(0, pos)].length / [...text].length;
  const t = Math.min(s.end - MIN_LEN, Math.max(s.start + MIN_LEN, s.start + (s.end - s.start) * ratio));
  const orig = s.orig ?? text;
  const tail = { id: nextId++, start: t, end: s.end, text: b, orig };
  s.end = t;
  s.text = a;
  s.orig = orig;
  state.subs.push(tail);
  sortSubs();
  state.selectedId = tail.id;
  changed();
  focusItemText(tail.id, 0);
}

/** 字幕校對：把這句併回上一句 */
function mergeWithPrev(s) {
  const i = state.subs.indexOf(s);
  if (i <= 0) return;
  const prev = state.subs[i - 1];
  pushUndo();
  const latin = (x, y) => /[A-Za-z0-9,.!?]$/.test(x) && /^[A-Za-z0-9]/.test(y) ? ' ' : '';
  const sep = latin(prev.text, s.text);
  const caret = prev.text.length + sep.length;
  const po = prev.orig ?? prev.text;
  const so = s.orig ?? s.text;
  // 兩句是同一句拆出來的（原文相同）→ 原文不重複
  const orig = prev.orig !== undefined && prev.orig === s.orig ? po : po + latin(po, so) + so;
  prev.text = prev.text + sep + s.text;
  prev.end = Math.max(prev.end, s.end);
  if (orig !== prev.text) prev.orig = orig; else delete prev.orig;
  state.subs.splice(i, 1);
  state.selectedId = prev.id;
  changed();
  focusItemText(prev.id, caret);
}

/** 資料變動後：存檔、重繪列表與時間軸 */
function changed({ list = true } = {}) {
  save();
  if (list) renderList();
  renderCuts();
  updateCounts();
  state.activeId = -1; // 強制刷新疊加字幕
  dirty = true;
}

function updateCounts() {
  $('#subCount').textContent = state.subs.length || '';
  $('#cutCount').textContent = state.cuts.length || '';
  $('#noteCount').textContent = state.notes.length || '';
  const edited = state.subs.filter(isEdited).length;
  const eb = $('#editedCount');
  eb.hidden = !edited;
  eb.textContent = `${edited} 句已改`;
}

/* ---------------- 刪除片段 ---------------- */

const cutById = (id) => state.cuts.find((c) => c.id === id);
function cutAt(t) { return state.cuts.find((c) => t >= c.start - 1e-3 && t < c.end - 0.02); }

/** 合併重疊的片段並排序 */
function normalizeCuts() {
  const sorted = [...state.cuts].sort((a, b) => a.start - b.start);
  const out = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c.start <= last.end + 1e-3) {
      last.end = Math.max(last.end, c.end);
      if (state.selCutId === c.id) state.selCutId = last.id;
    } else out.push(c);
  }
  state.cuts = out;
}

function addCut(start, end) {
  start = Math.max(0, start);
  end = Math.min(maxTime(), end);
  if (end - start < MIN_LEN / 2) return null;
  pushUndo();
  const c = { id: nextId++, start, end };
  state.cuts.push(c);
  state.selCutId = c.id;
  normalizeCuts();
  changed();
  return c;
}

function markCut() {
  if (!video.src) return toast('請先開啟影片');
  if (!state.sel) return toast('先在下方音軌上拖曳框選要刪除的範圍');
  const len = state.sel.end - state.sel.start;
  addCut(state.sel.start, state.sel.end);
  state.sel = null;
  updateSelUI();
  toast(`已標記刪除 ${len.toFixed(1)} 秒`);
}

function deleteCut(id) {
  if (!cutById(id)) return;
  pushUndo();
  state.cuts = state.cuts.filter((c) => c.id !== id);
  if (state.selCutId === id) state.selCutId = null;
  changed();
}

function cutStats() {
  const total = state.duration || 0;
  let removed = 0;
  for (const c of state.cuts) removed += Math.max(0, Math.min(c.end, total || c.end) - c.start);
  return { total, removed, after: Math.max(0, total - removed) };
}

/** 原始時間 → 剪掉刪除片段之後的時間 */
function mapTime(t) {
  let d = 0;
  for (const c of state.cuts) if (t > c.start) d += Math.min(t, c.end) - c.start;
  return t - d;
}

function statsText() {
  const st = cutStats();
  return `原長 ${fmtShort(st.total)}　刪 ${state.cuts.length} 段共 ${st.removed.toFixed(1)}s　→　剪後 ${fmtShort(st.after)}`;
}

function renderCuts() {
  const st = cutStats();
  $('#cutStats').innerHTML = '';
  $('#cutStats').append(
    '原長 ', el('b', { textContent: fmtShort(st.total) }),
    `　刪 ${state.cuts.length} 段共 ${st.removed.toFixed(1)}s　→　剪後 `,
    el('b', { textContent: fmtShort(st.after) }),
  );
  cutListEl.textContent = '';
  if (!state.cuts.length) {
    cutListEl.append(el('div', { className: 'empty-msg', textContent: '還沒有刪除片段。' }));
    return;
  }
  state.cuts.forEach((c, i) => {
    cutListEl.append(el('div', {
      className: 'cut-item' + (c.id === state.selCutId ? ' selected' : ''), dataset: { id: c.id },
    },
      el('span', { textContent: i + 1 + '.' }),
      el('span', { className: 'range', textContent: `${fmt(c.start)} — ${fmt(c.end)}` }),
      el('span', { className: 'len', textContent: (c.end - c.start).toFixed(1) + 's' }),
      el('span', { className: 'nudge' },
        el('button', { type: 'button', className: 'mini', textContent: '‹', title: '開始提早 0.1 秒', dataset: { act: 's-' } }),
        el('button', { type: 'button', className: 'mini', textContent: '›', title: '開始延後 0.1 秒', dataset: { act: 's+' } }),
        el('button', { type: 'button', className: 'mini', textContent: '‹', title: '結束提早 0.1 秒', dataset: { act: 'e-' } }),
        el('button', { type: 'button', className: 'mini', textContent: '›', title: '結束延後 0.1 秒', dataset: { act: 'e+' } }),
      ),
      el('button', { type: 'button', className: 'mini', textContent: '▶', title: '試聽（前後各 2 秒，跳過這段）', dataset: { act: 'play' } }),
      el('button', { type: 'button', className: 'mini danger', textContent: '✕', title: '取消這段刪除', dataset: { act: 'del' } }),
    ));
  });
}

function selectCut(id) {
  state.selCutId = id;
  if (state.selectedId != null) {
    listEl.querySelector('.sub-item.selected')?.classList.remove('selected');
    state.selectedId = null;
  }
  cutListEl.querySelectorAll('.cut-item').forEach((it) => it.classList.toggle('selected', +it.dataset.id === id));
  dirty = true;
}

cutListEl.addEventListener('click', (e) => {
  const item = e.target.closest('.cut-item');
  if (!item) return;
  const c = cutById(+item.dataset.id);
  if (!c) return;
  selectCut(c.id);
  const act = e.target.dataset.act;
  if (!act) { seek(c.start); revealTime(c.start); return; }
  if (act === 'del') return deleteCut(c.id);
  if (act === 'play') return previewCut(c);
  pushUndo();
  const d = act.endsWith('+') ? 0.1 : -0.1;
  if (act[0] === 's') c.start = Math.max(0, Math.min(c.start + d, c.end - MIN_LEN));
  else c.end = Math.min(maxTime(), Math.max(c.end + d, c.start + MIN_LEN));
  normalizeCuts();
  changed();
});

$('#clearCuts').addEventListener('click', () => {
  if (!state.cuts.length) return;
  if (!confirm(`確定要清除全部 ${state.cuts.length} 個刪除片段？（可以按 Ctrl+Z 復原）`)) return;
  pushUndo();
  state.cuts = [];
  state.selCutId = null;
  changed();
});

$('#skipCuts').addEventListener('change', (e) => { state.skipCuts = e.target.checked; save(); });

/* ---- 試聽 ---- */

function playRange(start, end, skip) {
  if (!video.src) return;
  seek(start);
  state.playUntil = end;
  state.playSkip = skip;
  video.play();
}
function previewCut(c) {
  playRange(Math.max(0, c.start - 2), Math.min(maxTime(), c.end + 2), true);
}
function playSelection() {
  if (state.sel) return playRange(state.sel.start, state.sel.end, false);
  const c = cutById(state.selCutId);
  if (c) return previewCut(c);
  toast('先在音軌上框選範圍，或選一個刪除片段');
}

function updateSelUI() {
  $('#markCutBtn').disabled = !state.sel;
  $('#playSelBtn').disabled = !state.sel && !cutById(state.selCutId);
  dirty = true;
}

/* ---------------- 儲存 ---------------- */

let saveTimer = 0;
let warnedQuota = false;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = { subs: state.subs, cuts: state.cuts, notes: state.notes, style: state.style, skipCuts: state.skipCuts };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      // 截圖太多存不下時，至少把文字存起來
      try {
        data.notes = state.notes.map((n) => ({ ...n, thumb: '' }));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        if (!warnedQuota) { warnedQuota = true; toast('瀏覽器空間不足，留言截圖不會被保存（文字有保存）'); }
      } catch (e2) { /* 無法存取 localStorage 時忽略 */ }
    }
  }, 300);
}
function load() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!data) return;
    const num = (x) => isFinite(x) && x !== null;
    if (Array.isArray(data.subs)) {
      state.subs = data.subs.filter((s) => num(s.start) && num(s.end)).map((s) => {
        const o = { id: nextId++, start: +s.start, end: +s.end, text: String(s.text ?? '') };
        if (typeof s.orig === 'string') o.orig = s.orig;
        return o;
      });
      sortSubs();
    }
    if (Array.isArray(data.cuts)) {
      state.cuts = data.cuts.filter((c) => num(c.start) && num(c.end) && c.end > c.start)
        .map((c) => ({ id: nextId++, start: +c.start, end: +c.end }));
      normalizeCuts();
    }
    if (Array.isArray(data.notes)) {
      state.notes = data.notes.filter((n) => num(n.time)).map((n) => ({
        id: nextId++, time: +n.time, text: String(n.text ?? ''), thumb: String(n.thumb || ''), drawn: !!n.drawn,
      }));
    }
    if (data.style) Object.assign(state.style, data.style);
    if (typeof data.skipCuts === 'boolean') state.skipCuts = data.skipCuts;
  } catch (e) { /* ignore */ }
}

/* ---------------- 字幕列表（右側） ---------------- */

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

function renderList() {
  const scrollTop = listEl.scrollTop;
  listEl.textContent = '';
  if (!state.subs.length) {
    listEl.append(el('div', { className: 'empty-msg', textContent: '還沒有字幕。播放影片到想要的位置，按「＋ 字幕」或直接點影片上的提示框；也可以匯入 SRT / VTT。' }));
    return;
  }
  const frag = document.createDocumentFragment();
  state.subs.forEach((s, i) => {
    const edited = isEdited(s);
    const item = el('div', {
      className: 'sub-item' + (s.id === state.selectedId ? ' selected' : '') +
        (s.id === state.activeId ? ' active' : '') + (edited ? ' edited' : ''),
      dataset: { id: s.id },
    },
      el('div', { className: 'row' },
        el('span', { className: 'idx', textContent: '#' + (i + 1) }),
        el('button', { type: 'button', className: 'mini', title: '開始 = 目前時間', textContent: '⏱', dataset: { act: 'setStart' } }),
        el('input', { className: 't', value: fmt(s.start), title: '開始時間', dataset: { field: 'start' } }),
        el('span', { className: 'arrow', textContent: '→' }),
        el('input', { className: 't', value: fmt(s.end), title: '結束時間', dataset: { field: 'end' } }),
        el('button', { type: 'button', className: 'mini', title: '結束 = 目前時間', textContent: '⏱', dataset: { act: 'setEnd' } }),
        el('span', { className: 'spacer' }),
        el('button', { type: 'button', className: 'mini', title: '跳到這句', textContent: '▶', dataset: { act: 'jump' } }),
        el('button', { type: 'button', className: 'mini danger', title: '刪除', textContent: '✕', dataset: { act: 'del' } }),
      ),
      el('textarea', {
        rows: 1, value: s.text, placeholder: '輸入字幕…', dataset: { field: 'text' },
        title: 'Ctrl/⌘+Enter：從游標處拆句　句首 Backspace：併回上一句',
      }),
      el('div', { className: 'orig', textContent: s.orig ?? '', hidden: !edited, title: '修改前的原文' }),
    );
    frag.append(item);
  });
  listEl.append(frag);
  listEl.querySelectorAll('textarea').forEach(autoGrow);
  listEl.scrollTop = scrollTop;
}

function itemEl(id) { return listEl.querySelector(`.sub-item[data-id="${id}"]`); }

/** 只更新某一條的「已修改」顯示，不重繪整個列表 */
function refreshEdited(s) {
  const it = itemEl(s.id);
  if (!it) return;
  const edited = isEdited(s);
  it.classList.toggle('edited', edited);
  const o = it.querySelector('.orig');
  o.hidden = !edited;
  o.textContent = s.orig ?? '';
}

function select(id, { scroll = true } = {}) {
  if (state.selCutId != null) selectCut(null);
  if (state.selectedId === id) return;
  listEl.querySelector('.sub-item.selected')?.classList.remove('selected');
  state.selectedId = id;
  const it = itemEl(id);
  if (it) {
    it.classList.add('selected');
    if (scroll) it.scrollIntoView({ block: 'nearest' });
  }
  dirty = true;
}

listEl.addEventListener('click', (e) => {
  const item = e.target.closest('.sub-item');
  if (!item) return;
  const id = +item.dataset.id;
  const s = byId(id);
  if (!s) return;
  select(id, { scroll: false });
  const act = e.target.dataset.act;
  if (act === 'jump') { seek(s.start + 0.001); revealTime(s.start); }
  else if (act === 'del') deleteSub(id);
  else if (act === 'setStart') setEdge(s, 'start', video.currentTime);
  else if (act === 'setEnd') setEdge(s, 'end', video.currentTime);
});

let textEditPending = false;
listEl.addEventListener('focusin', (e) => {
  const item = e.target.closest('.sub-item');
  if (item) select(+item.dataset.id, { scroll: false });
  if (e.target.dataset.field === 'text') textEditPending = true;
});
listEl.addEventListener('input', (e) => {
  if (e.target.dataset.field !== 'text') return;
  const s = byId(+e.target.closest('.sub-item').dataset.id);
  if (!s) return;
  if (textEditPending) { pushUndo(); textEditPending = false; }
  setText(s, e.target.value);
  autoGrow(e.target);
  refreshEdited(s);
  changed({ list: false });
});
listEl.addEventListener('change', (e) => {
  const field = e.target.dataset.field;
  if (field !== 'start' && field !== 'end') return;
  const s = byId(+e.target.closest('.sub-item').dataset.id);
  const t = parseTime(e.target.value);
  if (!s || !isFinite(t) || t < 0) {
    e.target.classList.add('invalid');
    toast('時間格式看不懂，例：1:23.5、83.5、1分23秒');
    return;
  }
  e.target.classList.remove('invalid');
  setEdge(s, field, t);
});
listEl.addEventListener('keydown', (e) => {
  if (e.target.matches('input.t') && e.key === 'Enter') { e.target.blur(); return; }
  if (e.target.dataset.field !== 'text' || e.isComposing) return;
  const s = byId(+e.target.closest('.sub-item').dataset.id);
  if (!s) return;
  const ta = e.target;
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    splitText(s, ta.selectionStart);
  } else if (e.key === 'Backspace' && ta.selectionStart === 0 && ta.selectionEnd === 0 && state.subs.indexOf(s) > 0) {
    e.preventDefault();
    mergeWithPrev(s);
  }
});

function setEdge(s, field, t) {
  pushUndo();
  t = Math.max(0, Math.min(t, maxTime()));
  if (field === 'start') {
    s.start = t;
    if (s.end - s.start < MIN_LEN) s.end = Math.min(s.start + DEFAULT_LEN, Math.max(maxTime(), s.start + MIN_LEN));
  } else {
    s.end = t;
    if (s.end - s.start < MIN_LEN) s.start = Math.max(0, s.end - DEFAULT_LEN);
    if (s.end - s.start < MIN_LEN) s.end = s.start + MIN_LEN;
  }
  sortSubs();
  changed();
}

function autoGrow(ta) {
  if (!ta.offsetParent) return; // 隱藏中的分頁量不到高度
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 2 + 'px';
}

/* ---------------- 指定時間改字幕（右上表單） ---------------- */

$('#quickForm').addEventListener('click', (e) => {
  const target = e.target.dataset.now;
  if (target) $('#' + target).value = fmt(video.currentTime);
});
$('#quickForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const startIn = $('#qStart');
  const endIn = $('#qEnd');
  const text = $('#qText').value.replace(/\s+$/, '');
  const start = parseTime(startIn.value);
  const end = endIn.value.trim() ? parseTime(endIn.value) : NaN;
  startIn.classList.toggle('invalid', !isFinite(start));
  endIn.classList.toggle('invalid', !!endIn.value.trim() && !(end > start));
  if (!isFinite(start)) return toast('開始時間格式不正確');
  if (endIn.value.trim() && !(end > start)) return toast('結束時間必須晚於開始時間');

  const existing = subAt(start + 0.0005);
  if (existing) {
    pushUndo();
    setText(existing, text);
    if (isFinite(end)) { existing.start = start; existing.end = end; sortSubs(); }
    state.selectedId = existing.id;
    changed();
    toast(`已把 ${fmt(existing.start)} 的字幕改成「${text}」`);
  } else {
    const s = addSub(start, isFinite(end) ? end : defaultEnd(start), text);
    toast(`已在 ${fmt(s.start)} 新增字幕`);
  }
  seek(start + 0.001);
  revealTime(start);
  itemEl(state.selectedId)?.scrollIntoView({ block: 'nearest' });
  $('#qText').value = '';
  endIn.value = '';
});

/* ---------------- 影片上直接編輯字幕 ---------------- */

let overlayEditId = null;
let overlayCreated = false;
let overlayUndoPending = false;

function updateOverlay() {
  if (document.activeElement === overlay) return; // 編輯中不覆寫
  const s = subAt(video.currentTime);
  const id = s ? s.id : null;
  if (id === state.activeId && (!s || overlay.textContent === s.text)) return;

  // 列表高亮
  listEl.querySelector('.sub-item.active')?.classList.remove('active');
  state.activeId = id;
  if (s) {
    const it = itemEl(id);
    if (it) {
      it.classList.add('active');
      if (!video.paused && !listEl.contains(document.activeElement)) it.scrollIntoView({ block: 'nearest' });
    }
    overlay.textContent = s.text;
    overlay.classList.remove('empty');
    overlay.classList.toggle('hidden', s.text === '' && !video.paused);
  } else {
    overlay.textContent = '';
    overlay.classList.add('empty');
    overlay.classList.toggle('hidden', !video.paused || !video.src || state.drawMode);
  }
}

function applyOverlayStyle() {
  const st = state.style;
  const h = parseFloat(subLayer.style.height) || player.clientHeight;
  overlay.style.fontSize = (st.size / 100) * h + 'px';
  overlay.style.bottom = (st.pos / 100) * h + 'px';
  overlay.style.color = st.color;
  overlay.style.fontWeight = st.bold ? '700' : '400';
  overlay.style.backgroundColor = hexA(st.bg, st.bgA);
  overlay.style.textShadow = st.outline
    ? '0 0 2px #000, 0 0 2px #000, 1px 1px 2px #000, -1px -1px 2px #000'
    : 'none';
}

/** 讓字幕層、畫記層剛好蓋在影片實際畫面上（扣掉黑邊） */
function layoutOverlay() {
  const cw = player.clientWidth;
  const ch = player.clientHeight;
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;
  const scale = Math.min(cw / vw, ch / vh);
  const w = vw * scale;
  const h = vh * scale;
  const rect = { left: (cw - w) / 2 + 'px', top: (ch - h) / 2 + 'px', width: w + 'px', height: h + 'px' };
  Object.assign(subLayer.style, rect);
  Object.assign(drawCanvas.style, rect);
  const dpr = window.devicePixelRatio || 1;
  drawCanvas.width = Math.max(1, Math.round(w * dpr));
  drawCanvas.height = Math.max(1, Math.round(h * dpr));
  applyOverlayStyle();
  redrawStrokes();
}

overlay.addEventListener('focus', () => {
  if (!video.src || state.drawMode) { overlay.blur(); return; }
  video.pause();
  let s = subAt(video.currentTime);
  overlayCreated = false;
  if (!s) {
    s = addSub(video.currentTime, defaultEnd(video.currentTime), '');
    overlayCreated = true;
    overlay.textContent = '';
  }
  overlayEditId = s.id;
  overlayUndoPending = !overlayCreated;
  select(s.id);
  overlay.classList.remove('empty', 'hidden');
});

overlay.addEventListener('input', () => {
  const s = byId(overlayEditId);
  if (!s) return;
  if (overlayUndoPending) { pushUndo(); overlayUndoPending = false; }
  setText(s, overlay.innerText.replace(/\n$/, ''));
  const ta = itemEl(s.id)?.querySelector('textarea');
  if (ta) { ta.value = s.text; autoGrow(ta); }
  refreshEdited(s);
  changed({ list: false });
});

overlay.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if ((e.key === 'Enter' && !e.shiftKey && !e.isComposing) || e.key === 'Escape') {
    e.preventDefault();
    overlay.blur();
  }
});

overlay.addEventListener('paste', (e) => {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  document.execCommand('insertText', false, text);
});

overlay.addEventListener('blur', () => {
  const s = byId(overlayEditId);
  if (s && overlayCreated && s.text.trim() === '') {
    // 新建但沒打字 → 取消
    state.subs = state.subs.filter((x) => x !== s);
    undoStack.pop();
    if (state.selectedId === s.id) state.selectedId = null;
    changed();
  } else if (s) {
    changed();
  }
  overlayEditId = null;
  overlayCreated = false;
  state.activeId = -1;
  updateOverlay();
});

/* ---------------- 畫記 ---------------- */

let curStroke = null;

function paintStrokes(c, w, h, strokes = state.strokes) {
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.lineWidth = Math.max(2, Math.min(w, h) * 0.008);
  for (const st of strokes) {
    if (!st.pts.length) continue;
    c.strokeStyle = st.color;
    c.beginPath();
    c.moveTo(st.pts[0][0] * w, st.pts[0][1] * h);
    for (const p of st.pts) c.lineTo(p[0] * w, p[1] * h);
    if (st.pts.length === 1) c.lineTo(st.pts[0][0] * w + 0.1, st.pts[0][1] * h);
    c.stroke();
  }
}

function redrawStrokes() {
  const dpr = window.devicePixelRatio || 1;
  const w = drawCanvas.width / dpr;
  const h = drawCanvas.height / dpr;
  dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  dctx.clearRect(0, 0, w, h);
  paintStrokes(dctx, w, h);
  drawCanvas.classList.toggle('show', state.drawMode || state.strokes.length > 0);
}

function setDrawMode(on) {
  if (on && !video.src) return toast('請先開啟影片');
  state.drawMode = on;
  player.classList.toggle('drawing', on);
  $('#drawBar').hidden = !on;
  $('#drawBtn').classList.toggle('on', on);
  $('#drawBtn2').classList.toggle('on', on);
  if (on) {
    video.pause();
    overlay.blur();
    switchTab('review');
  }
  state.activeId = -1;
  redrawStrokes();
}

function normPt(e) {
  const r = drawCanvas.getBoundingClientRect();
  return [
    Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
    Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
  ];
}

drawCanvas.addEventListener('pointerdown', (e) => {
  if (!state.drawMode) return;
  e.preventDefault();
  drawCanvas.setPointerCapture(e.pointerId);
  lockDraft();
  curStroke = { color: state.drawColor, pts: [normPt(e)] };
  state.strokes.push(curStroke);
  redrawStrokes();
});
drawCanvas.addEventListener('pointermove', (e) => {
  if (!curStroke) return;
  curStroke.pts.push(normPt(e));
  redrawStrokes();
});
const endStroke = () => { curStroke = null; updateNoteHead(); };
drawCanvas.addEventListener('pointerup', endStroke);
drawCanvas.addEventListener('pointercancel', endStroke);

$('#drawBar').addEventListener('click', (e) => {
  const sw = e.target.closest('.swatch');
  if (!sw) return;
  state.drawColor = sw.dataset.color;
  document.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('active', b === sw));
});
$('#drawUndo').addEventListener('click', () => { state.strokes.pop(); redrawStrokes(); updateNoteHead(); });
$('#drawClear').addEventListener('click', () => { state.strokes = []; redrawStrokes(); updateNoteHead(); });
$('#drawDone').addEventListener('click', () => { setDrawMode(false); noteText.focus(); });
$('#drawBtn').addEventListener('click', () => setDrawMode(!state.drawMode));
$('#drawBtn2').addEventListener('click', () => setDrawMode(!state.drawMode));

/* ---------------- 審片留言 ---------------- */

function lockDraft() {
  if (state.draft.time != null) return;
  video.pause();
  state.draft.time = video.currentTime;
  updateNoteHead();
}

let lastNoteHead = '';
function updateNoteHead() {
  const locked = state.draft.time != null;
  const t = locked ? state.draft.time : video.currentTime;
  const label = '⏱ ' + fmt(t) + (locked ? 'L' : '') + state.strokes.length;
  if (label === lastNoteHead) return;
  lastNoteHead = label;
  $('#noteTime').textContent = '⏱ ' + fmt(t);
  $('#noteLock').hidden = !locked;
  $('#noteHint').textContent = state.strokes.length ? `已畫 ${state.strokes.length} 筆，會跟留言一起送出` : '';
}

noteText.addEventListener('input', () => { if (noteText.value.trim()) lockDraft(); });
noteText.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); addNote(); }
});

function resetDraft() {
  state.draft.time = null;
  noteText.value = '';
  state.strokes = [];
  if (state.drawMode) setDrawMode(false);
  redrawStrokes();
  updateNoteHead();
}
$('#noteClear').addEventListener('click', resetDraft);

function seekTo(t) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 0.001 && !video.seeking && video.readyState >= 2) return resolve();
    video.addEventListener('seeked', () => resolve(), { once: true });
    video.currentTime = t;
  });
}

/** 擷取目前畫面（含畫記）做縮圖 */
function captureThumb() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return '';
  const scale = 360 / Math.max(vw, vh);
  const w = Math.round(vw * scale);
  const h = Math.round(vh * scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const cx = c.getContext('2d');
  try {
    cx.drawImage(video, 0, 0, w, h);
    paintStrokes(cx, w, h);
    return c.toDataURL('image/jpeg', 0.75);
  } catch (e) {
    return '';
  }
}

async function addNote() {
  if (!video.src) return toast('請先開啟影片');
  const text = noteText.value.trim();
  if (!text && !state.strokes.length) return toast('先輸入修改意見');
  const t = state.draft.time ?? video.currentTime;
  video.pause();
  await seekTo(t);
  const note = { id: nextId++, time: t, text, thumb: captureThumb(), drawn: state.strokes.length > 0 };
  state.notes.push(note);
  state.notes.sort((a, b) => a.time - b.time);
  resetDraft();
  renderNotes();
  updateCounts();
  save();
  toast(`已加入 ${fmtShort(t)} 的留言`);
}
$('#noteAdd').addEventListener('click', addNote);

function renderNotes() {
  noteListEl.textContent = '';
  if (!state.notes.length) {
    noteListEl.append(el('div', { className: 'empty-msg', textContent: '暫停在要改的地方，在上面打意見後按「加入留言」，就會排在這裡。' }));
    return;
  }
  for (const n of state.notes) {
    noteListEl.append(el('div', { className: 'note-item' + (n.drawn ? ' drawn' : ''), dataset: { id: n.id } },
      n.thumb ? el('img', { src: n.thumb, alt: '', title: '跳到這個時間', dataset: { act: 'seek' } }) : '',
      el('div', { className: 'body' },
        el('div', { className: 'meta' },
          el('span', { className: 'time', textContent: fmtShort(n.time), title: '跳到這個時間', dataset: { act: 'seek' } }),
          n.drawn ? el('span', { className: 'tag', textContent: '✏ 畫記' }) : '',
          el('span', { className: 'spacer' }),
          el('button', { type: 'button', className: 'mini danger', textContent: '✕', title: '刪除這則留言', dataset: { act: 'del' } }),
        ),
        el('div', { className: 'text', textContent: n.text || '（見畫記）' }),
      ),
    ));
  }
}

noteListEl.addEventListener('click', (e) => {
  const item = e.target.closest('.note-item');
  if (!item) return;
  const n = state.notes.find((x) => x.id === +item.dataset.id);
  if (!n) return;
  const act = e.target.dataset.act;
  if (act === 'seek') { video.pause(); seek(n.time); revealTime(n.time); }
  else if (act === 'del') {
    state.notes = state.notes.filter((x) => x !== n);
    renderNotes();
    updateCounts();
    save();
  }
});

/** 審片意見文字（給 Claude Code 或剪輯師） */
function reviewText({ images }) {
  const L = [`# 審片意見：${state.videoName}`, ''];
  L.push('## 修改清單', '');
  if (state.notes.length) {
    state.notes.forEach((n, i) => L.push(`${i + 1}. [${fmtShort(n.time)}] — ${n.text || '（見附圖）'}${n.drawn ? '（有附圖）' : ''}`));
  } else L.push('（無）');

  if (state.cuts.length) {
    L.push('', '## 刪除片段', '');
    state.cuts.forEach((c, i) => L.push(`${i + 1}. ${fmt(c.start)} — ${fmt(c.end)}（${(c.end - c.start).toFixed(1)}s）`));
    L.push('', statsText());
  }

  const edited = state.subs.filter(isEdited);
  if (edited.length) {
    L.push('', '## 字幕修改', '');
    edited.forEach((s, i) => L.push(`${i + 1}. [${fmtShort(s.start)} — ${fmtShort(s.end)}] 「${s.orig}」→「${s.text}」`));
  }

  if (images) {
    const withImg = state.notes.filter((n) => n.thumb);
    if (withImg.length) {
      L.push('', '## 附圖', '');
      withImg.forEach((n) => {
        const i = state.notes.indexOf(n) + 1;
        L.push(`### ${i}. [${fmtShort(n.time)}] ${n.text || ''}`.trim(), '', `![${fmtShort(n.time)}](${n.thumb})`, '');
      });
    }
  } else if (state.notes.some((n) => n.drawn)) {
    L.push('', '（有附圖的留言，圖片在匯出的 .md 檔裡）');
  }
  return L.join('\n') + '\n';
}

function hasReview() {
  return state.notes.length || state.cuts.length || state.subs.some(isEdited);
}

$('#exportMd').addEventListener('click', () => {
  if (!hasReview()) return toast('還沒有任何留言、刪除片段或字幕修改');
  download(new Blob([reviewText({ images: true })], { type: 'text/markdown;charset=utf-8' }), `${state.videoName}_review.md`);
});

$('#copyReview').addEventListener('click', async () => {
  if (!hasReview()) return toast('還沒有任何留言、刪除片段或字幕修改');
  const ok = await copyText(reviewText({ images: false }));
  toast(ok ? '已複製，貼到 Claude Code 跟他說「照審片意見改」' : '複製失敗，請改用「匯出審片意見」');
});

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch (e) {
    const ta = el('textarea', { value: t });
    Object.assign(ta.style, { position: 'fixed', opacity: '0', top: '0' });
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { /* ignore */ }
    ta.remove();
    return ok;
  }
}

/* ---------------- 右側分頁 ---------------- */

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  if (name === 'subs') listEl.querySelectorAll('textarea').forEach(autoGrow);
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

/* ---------------- 時間軸 ---------------- */

const RULER_H = 24;
const SUB_H = 46;
let tlW = 0;
let tlH = 0;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  tlW = Math.max(1, Math.floor(r.width));
  tlH = Math.max(1, Math.floor(r.height));
  canvas.width = tlW * dpr;
  canvas.height = tlH * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  clampScroll();
  dirty = true;
}

const xOf = (t) => (t - state.scroll) * state.pps;
const tOf = (x) => x / state.pps + state.scroll;
const viewSecs = () => tlW / state.pps;

function clampScroll() {
  const max = Math.max(0, state.duration - viewSecs() * 0.9);
  state.scroll = Math.max(0, Math.min(state.scroll, max));
  hscroll.max = String(max);
  hscroll.value = String(state.scroll);
  hscroll.disabled = max <= 0;
}

/** 讓某個時間出現在時間軸畫面裡 */
function revealTime(t) {
  const x = xOf(t);
  if (x < 0 || x > tlW) {
    state.scroll = t - viewSecs() * 0.2;
    clampScroll();
    dirty = true;
  }
}

/** zoom slider（0..900）↔ pixels per second（1..512，指數刻度） */
const ppsFromSlider = (v) => Math.pow(2, v / 100);
const sliderFromPps = (p) => Math.round(Math.log2(p) * 100);

function setZoom(pps, anchorX = tlW / 2) {
  const anchorT = tOf(anchorX);
  state.pps = Math.max(1, Math.min(512, pps));
  state.scroll = anchorT - anchorX / state.pps;
  zoomInput.value = String(sliderFromPps(state.pps));
  clampScroll();
  dirty = true;
}

function fitZoom() {
  if (!state.duration) return;
  state.scroll = 0;
  setZoom((tlW - 20) / state.duration, 0);
}

function niceStep(minSecs) {
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return steps.find((s) => s >= minSecs) || 7200;
}

function roundRect(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function draw() {
  const W = tlW, H = tlH;
  const audioY = RULER_H + SUB_H;
  const audioH = H - audioY;
  ctx.clearRect(0, 0, W, H);

  // 背景
  ctx.fillStyle = '#111318';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#171a21';
  ctx.fillRect(0, RULER_H, W, SUB_H);
  ctx.fillStyle = '#0d0f13';
  ctx.fillRect(0, audioY, W, audioH);

  const t0 = state.scroll;
  const t1 = tOf(W);
  const endX = state.duration ? xOf(state.duration) : W;

  // 影片範圍外變暗
  if (state.duration && endX < W) {
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.fillRect(endX, RULER_H, W - endX, H - RULER_H);
  }

  // 時間尺
  ctx.fillStyle = '#1d2027';
  ctx.fillRect(0, 0, W, RULER_H);
  const step = niceStep(80 / state.pps);
  const minor = step / 5;
  ctx.strokeStyle = '#3a404d';
  ctx.fillStyle = '#9097a6';
  ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
    const x = Math.round(xOf(t)) + 0.5;
    const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    ctx.moveTo(x, major ? 10 : 17);
    ctx.lineTo(x, RULER_H);
    if (major) ctx.fillText(fmtRuler(Math.max(0, t), step), x + 3, 2);
  }
  ctx.stroke();
  // 格線
  ctx.strokeStyle = 'rgba(255,255,255,.04)';
  ctx.beginPath();
  for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) {
    const x = Math.round(xOf(t)) + 0.5;
    ctx.moveTo(x, RULER_H);
    ctx.lineTo(x, H);
  }
  ctx.stroke();

  // 音軌波形
  const mid = audioY + audioH / 2;
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  ctx.beginPath(); ctx.moveTo(0, mid + 0.5); ctx.lineTo(W, mid + 0.5); ctx.stroke();
  if (state.peaks) {
    const p = state.peaks;
    const n = p.length / 2;
    const rate = state.peaksRate;
    const amp = audioH / 2 - 4;
    ctx.fillStyle = '#4f8cff';
    const xEnd = Math.min(W, endX);
    for (let x = 0; x < xEnd; x++) {
      const b0 = Math.floor(tOf(x) * rate);
      const b1 = Math.max(b0 + 1, Math.floor(tOf(x + 1) * rate));
      if (b1 <= 0 || b0 >= n) continue;
      let lo = 0, hi = 0;
      for (let b = Math.max(0, b0); b < Math.min(n, b1); b++) {
        if (p[b * 2] < lo) lo = p[b * 2];
        if (p[b * 2 + 1] > hi) hi = p[b * 2 + 1];
      }
      const y0 = mid - hi * amp;
      const y1 = mid - lo * amp;
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  } else if (video.src) {
    const msg = {
      loading: '音軌解析中…',
      noaudio: '這個檔案沒有音軌',
      error: '無法解析音軌波形（仍可正常編輯字幕）',
      none: '',
    }[state.audioStatus];
    ctx.fillStyle = '#5b6170';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(msg, 12, mid);
  }

  // 字幕方塊
  ctx.font = '12px system-ui, "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';
  ctx.textBaseline = 'middle';
  for (const s of state.subs) {
    if (s.end < t0 || s.start > t1) continue;
    const x = xOf(s.start);
    const w = Math.max(2, (s.end - s.start) * state.pps);
    const sel = s.id === state.selectedId;
    roundRect(ctx, x + 0.5, RULER_H + 5.5, w - 1, SUB_H - 11, 4);
    ctx.fillStyle = sel ? '#52b67f' : '#2f6b4b';
    ctx.fill();
    ctx.strokeStyle = sel ? '#bff5d6' : isEdited(s) ? '#ff8a3d' : '#4c9a70';
    ctx.lineWidth = 1;
    ctx.stroke();
    if (w > 14) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 4, RULER_H, w - 8, SUB_H);
      ctx.clip();
      ctx.fillStyle = sel ? '#06210f' : '#e3f6ea';
      const label = s.text.replace(/\n/g, ' ⏎ ') || '（空白）';
      ctx.fillText(label, x + 6, RULER_H + SUB_H / 2);
      ctx.restore();
    }
  }

  // 刪除片段
  for (const c of state.cuts) {
    if (c.end < t0 || c.start > t1) continue;
    const x0 = xOf(c.start);
    const w = Math.max(2, (c.end - c.start) * state.pps);
    const sel = c.id === state.selCutId;
    ctx.fillStyle = sel ? 'rgba(255,77,79,.45)' : 'rgba(255,77,79,.3)';
    ctx.fillRect(x0, RULER_H, w, H - RULER_H);
    ctx.fillStyle = '#ff4d4f';
    ctx.fillRect(x0, RULER_H - 4, w, 4);
    ctx.strokeStyle = sel ? '#ffd0d1' : '#ff4d4f';
    ctx.lineWidth = sel ? 2 : 1;
    ctx.strokeRect(x0 + 0.5, audioY + 0.5, w - 1, audioH - 1);
    if (w > 30) {
      ctx.fillStyle = '#ffd0d1';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(`刪 ${(c.end - c.start).toFixed(1)}s`, x0 + 4, audioY + 4);
    }
  }

  // 框選範圍
  if (state.sel) {
    const x0 = xOf(state.sel.start);
    const w = Math.max(1, (state.sel.end - state.sel.start) * state.pps);
    ctx.fillStyle = 'rgba(255,214,0,.18)';
    ctx.fillRect(x0, RULER_H, w, H - RULER_H);
    ctx.strokeStyle = '#ffd600';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, RULER_H + 0.5, w - 1, H - RULER_H - 1);
    ctx.fillStyle = '#ffd600';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(`${(state.sel.end - state.sel.start).toFixed(2)}s　按 X 刪除`, x0 + 4, audioY + 4);
  }

  // 軌道名稱
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(144,151,166,.7)';
  ctx.fillText('字幕', 4, RULER_H + 2);
  ctx.fillText(state.sel || state.cuts.length ? '音訊' : '音訊（拖曳框選 → X 刪除）', 4, audioY + audioH - 14);

  // 留言標記
  for (const n of state.notes) {
    const x = xOf(n.time);
    if (x < -6 || x > W + 6) continue;
    ctx.fillStyle = '#b6ff3b';
    ctx.beginPath();
    ctx.moveTo(x - 5, RULER_H - 9); ctx.lineTo(x + 5, RULER_H - 9); ctx.lineTo(x, RULER_H - 2);
    ctx.closePath();
    ctx.fill();
  }

  // 播放頭
  const px = Math.round(xOf(video.currentTime || 0)) + 0.5;
  if (px >= 0 && px <= W) {
    ctx.strokeStyle = '#ff5a5f';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
    ctx.fillStyle = '#ff5a5f';
    ctx.beginPath(); ctx.moveTo(px - 6, 0); ctx.lineTo(px + 6, 0); ctx.lineTo(px, 8); ctx.closePath(); ctx.fill();
  }
}

/* ---- 時間軸滑鼠操作 ---- */

const EDGE = 6;
let drag = null;

function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function region(y) {
  if (y < RULER_H) return 'ruler';
  if (y <= RULER_H + SUB_H) return 'subs';
  return 'audio';
}

function hitSub(x, y) {
  if (region(y) !== 'subs') return null;
  // 優先判斷選取中的字幕
  const ordered = [...state.subs].sort((a, b) => (a.id === state.selectedId) - (b.id === state.selectedId)).reverse();
  for (const s of ordered) {
    const x0 = xOf(s.start);
    const x1 = xOf(s.end);
    if (x < x0 - EDGE || x > x1 + EDGE) continue;
    const w = x1 - x0;
    const edge = Math.min(EDGE, w / 3);
    if (Math.abs(x - x0) <= edge) return { sub: s, mode: 'l' };
    if (Math.abs(x - x1) <= edge) return { sub: s, mode: 'r' };
    if (x >= x0 && x <= x1) return { sub: s, mode: 'move' };
  }
  return null;
}

function snap(t, exclude) {
  const cands = [video.currentTime, 0];
  if (state.duration) cands.push(state.duration);
  for (const s of state.subs) if (s !== exclude) cands.push(s.start, s.end);
  for (const c of cands) if (Math.abs((c - t) * state.pps) < 6) return c;
  return t;
}

canvas.addEventListener('pointerdown', (e) => {
  if (!video.src) return;
  canvas.setPointerCapture(e.pointerId);
  const { x, y } = canvasPos(e);
  const reg = region(y);
  const hit = hitSub(x, y);
  if (hit) {
    select(hit.sub.id);
    drag = { kind: 'sub', ...hit, startX: x, origStart: hit.sub.start, origEnd: hit.sub.end, moved: false, undo: false };
  } else if (reg === 'audio') {
    drag = { kind: 'select', startX: x, t0: Math.max(0, tOf(x)), moved: false };
  } else {
    drag = { kind: 'scrub' };
    seek(tOf(x));
  }
});

canvas.addEventListener('pointermove', (e) => {
  const { x, y } = canvasPos(e);
  if (!drag) {
    const hit = hitSub(x, y);
    canvas.style.cursor = !video.src ? 'default'
      : hit ? (hit.mode === 'move' ? 'grab' : 'ew-resize')
        : region(y) === 'audio' ? 'crosshair' : 'text';
    return;
  }
  if (drag.kind === 'scrub') {
    seek(tOf(x));
    autoScrollEdge(x);
    return;
  }
  if (drag.kind === 'select') {
    if (!drag.moved && Math.abs(x - drag.startX) < 3) return;
    drag.moved = true;
    autoScrollEdge(x);
    const t = Math.max(0, Math.min(maxTime(), tOf(x)));
    state.sel = { start: Math.min(drag.t0, t), end: Math.max(drag.t0, t) };
    updateSelUI();
    return;
  }
  const dx = x - drag.startX;
  if (!drag.moved && Math.abs(dx) < 3) return;
  if (!drag.undo) {
    undoStack.push(snapshot(state.subs.map((s) => s === drag.sub ? { ...s, start: drag.origStart, end: drag.origEnd } : s)));
    redoStack.length = 0;
    drag.undo = true;
  }
  drag.moved = true;
  const s = drag.sub;
  const dt = dx / state.pps;
  const len = drag.origEnd - drag.origStart;
  if (drag.mode === 'move') {
    canvas.style.cursor = 'grabbing';
    let ns = drag.origStart + dt;
    const sStart = snap(ns, s);
    const sEnd = snap(ns + len, s);
    if (sStart !== ns) ns = sStart; else if (sEnd !== ns + len) ns = sEnd - len;
    ns = Math.max(0, Math.min(ns, maxTime() - len));
    s.start = ns;
    s.end = ns + len;
  } else if (drag.mode === 'l') {
    s.start = Math.max(0, Math.min(snap(drag.origStart + dt, s), s.end - MIN_LEN));
  } else {
    s.end = Math.min(maxTime(), Math.max(snap(drag.origEnd + dt, s), s.start + MIN_LEN));
  }
  syncItemTimes(s);
  state.activeId = -1;
  dirty = true;
});

function endDrag() {
  if (!drag) return;
  if (drag.kind === 'sub') {
    if (drag.moved) {
      sortSubs();
      changed();
    } else {
      seek(drag.sub.start + 0.001);
    }
  } else if (drag.kind === 'select' && !drag.moved) {
    // 在音軌上單擊：點到刪除片段就選取它，否則清除框選並跳到該時間
    const c = state.cuts.find((k) => drag.t0 >= k.start && drag.t0 <= k.end);
    state.sel = null;
    if (c) {
      selectCut(c.id);
      cutListEl.querySelector(`.cut-item[data-id="${c.id}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (state.selCutId != null) selectCut(null);
    seek(drag.t0);
    updateSelUI();
  }
  drag = null;
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener('dblclick', (e) => {
  if (!video.src) return;
  const { x, y } = canvasPos(e);
  const hit = hitSub(x, y);
  if (hit) {
    focusItemText(hit.sub.id);
  } else if (region(y) === 'subs') {
    const t = Math.max(0, tOf(x));
    const s = addSub(t, defaultEnd(t), '');
    seek(t + 0.001);
    focusItemText(s.id);
  }
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const { x } = canvasPos(e);
  if (e.ctrlKey || e.metaKey) {
    setZoom(state.pps * Math.pow(1.0015, -e.deltaY), x);
  } else {
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    state.scroll += d / state.pps;
    clampScroll();
    dirty = true;
  }
}, { passive: false });

hscroll.addEventListener('input', () => {
  state.scroll = +hscroll.value;
  dirty = true;
});
zoomInput.addEventListener('input', () => {
  const px = xOf(video.currentTime);
  setZoom(ppsFromSlider(+zoomInput.value), px >= 0 && px <= tlW ? px : tlW / 2);
});

function autoScrollEdge(x) {
  if (x > tlW - 20) state.scroll += 10 / state.pps;
  else if (x < 20) state.scroll -= 10 / state.pps;
  clampScroll();
  dirty = true;
}

/** 播放時讓播放頭保持在畫面內 */
function followPlayhead() {
  const x = xOf(video.currentTime);
  if (x > tlW * 0.92 || x < 0) {
    state.scroll = video.currentTime - viewSecs() * 0.08;
    clampScroll();
  }
}

function syncItemTimes(s) {
  const it = itemEl(s.id);
  if (!it) return;
  const [a, b] = it.querySelectorAll('input.t');
  if (document.activeElement !== a) a.value = fmt(s.start);
  if (document.activeElement !== b) b.value = fmt(s.end);
}

function focusItemText(id, caret) {
  switchTab('subs');
  select(id);
  const ta = itemEl(id)?.querySelector('textarea');
  if (!ta) return;
  ta.focus();
  if (caret == null) ta.select();
  else ta.setSelectionRange(caret, caret);
}

/* ---------------- 音軌波形 ---------------- */

async function computePeaks(file) {
  state.peaks = null;
  state.audioStatus = 'loading';
  dirty = true;
  const token = (computePeaks.token = (computePeaks.token || 0) + 1);
  if (file.size > 1.5e9) { state.audioStatus = 'error'; return; }
  let ac;
  try {
    const buf = await file.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    ac = new AC();
    const audio = await ac.decodeAudioData(buf);
    if (token !== computePeaks.token) return;
    const rate = state.peaksRate;
    const spb = Math.max(1, Math.floor(audio.sampleRate / rate));
    const n = Math.ceil(audio.length / spb);
    const peaks = new Float32Array(n * 2);
    const chans = [];
    for (let c = 0; c < Math.min(2, audio.numberOfChannels); c++) chans.push(audio.getChannelData(c));
    const nc = chans.length;
    let b = 0;
    // 分段計算，避免畫面卡住
    while (b < n) {
      const until = Math.min(n, b + 20000);
      for (; b < until; b++) {
        let lo = 0, hi = 0;
        const end = Math.min(audio.length, (b + 1) * spb);
        for (let i = b * spb; i < end; i++) {
          let v = chans[0][i];
          if (nc > 1) v = (v + chans[1][i]) / 2;
          if (v < lo) lo = v; else if (v > hi) hi = v;
        }
        peaks[b * 2] = lo;
        peaks[b * 2 + 1] = hi;
      }
      await new Promise((r) => setTimeout(r));
      if (token !== computePeaks.token) return;
    }
    // 正規化讓小聲的音檔也看得清楚
    let mx = 0;
    for (let i = 0; i < peaks.length; i++) mx = Math.max(mx, Math.abs(peaks[i]));
    if (mx > 0 && mx < 1) for (let i = 0; i < peaks.length; i++) peaks[i] /= mx;
    state.peaks = peaks;
    state.audioStatus = 'ready';
  } catch (err) {
    if (token !== computePeaks.token) return;
    console.warn('waveform:', err);
    state.audioStatus = /decode|EncodingError|unable/i.test(String(err)) ? 'noaudio' : 'error';
  } finally {
    ac?.close?.();
    dirty = true;
  }
}

/* ---------------- 載入影片 / 字幕 ---------------- */

let videoURL = null;
function loadVideo(file) {
  if (videoURL) URL.revokeObjectURL(videoURL);
  videoURL = URL.createObjectURL(file);
  state.videoName = file.name.replace(/\.[^.]+$/, '') || 'subtitles';
  state.duration = 0;
  state.sel = null;
  video.src = videoURL;
  video.playbackRate = +$('#rate').value;
  document.body.classList.add('has-video');
  document.title = file.name + ' - 影片字幕編輯器';
  computePeaks(file);
}

video.addEventListener('loadedmetadata', () => {
  state.duration = video.duration || 0;
  layoutOverlay();
  resizeCanvas();
  fitZoom();
  renderCuts();
  state.activeId = -1;
  dirty = true;
});
video.addEventListener('error', () => toast('瀏覽器無法播放這個影片格式，建議轉成 MP4 (H.264) 或 WebM'));

function parseSubs(text) {
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const out = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = parseTime(a.trim());
    const end = parseTime(b.trim().split(/\s+/)[0]);
    if (!isFinite(start) || !isFinite(end)) continue;
    const body = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').trim();
    out.push({ start, end: Math.max(end, start + MIN_LEN), text: body });
  }
  return out;
}

async function loadSubFile(file) {
  const subs = parseSubs(await file.text());
  if (!subs.length) return toast('字幕檔裡沒有讀到任何字幕');
  if (state.subs.length && !confirm(`要用匯入的 ${subs.length} 條字幕取代目前的 ${state.subs.length} 條嗎？\n（按「取消」則合併）`)) {
    pushUndo();
    for (const s of subs) state.subs.push({ id: nextId++, ...s });
  } else {
    pushUndo();
    state.subs = subs.map((s) => ({ id: nextId++, ...s }));
  }
  sortSubs();
  changed();
  switchTab('subs');
  toast(`已匯入 ${subs.length} 條字幕`);
}

function handleFiles(files) {
  for (const f of files) {
    if (/\.(srt|vtt)$/i.test(f.name)) loadSubFile(f);
    else if (/^(video|audio)\//.test(f.type) || /\.(mp4|webm|mov|mkv|ogv|m4v|mp3|wav|m4a|ogg)$/i.test(f.name)) loadVideo(f);
    else toast('不支援的檔案：' + f.name);
  }
}

$('#videoInput').addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
$('#subInput').addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });

player.addEventListener('dragover', (e) => { e.preventDefault(); player.classList.add('dragover'); });
player.addEventListener('dragleave', () => player.classList.remove('dragover'));
player.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  player.classList.remove('dragover');
  handleFiles(e.dataTransfer.files);
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); });

/* ---------------- 匯出字幕 ---------------- */

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/** 有刪除片段時，詢問要不要把字幕時間對齊剪後的影片 */
function subsForExport() {
  if (!state.cuts.length) return state.subs;
  const align = confirm(`目前有 ${state.cuts.length} 個刪除片段。\n\n要把字幕時間對齊「剪掉之後」的影片嗎？\n確定 = 對齊剪後影片（搭配「輸出含字幕影片」）\n取消 = 保留原始影片的時間`);
  if (!align) return state.subs;
  return state.subs
    .map((s) => ({ ...s, start: mapTime(s.start), end: mapTime(s.end) }))
    .filter((s) => s.end - s.start >= 0.05);
}

function toSRT(list = state.subs) {
  return list.map((s, i) =>
    `${i + 1}\n${fmtFile(s.start, ',')} --> ${fmtFile(s.end, ',')}\n${s.text}\n`).join('\n');
}
function toVTT(list = state.subs) {
  return 'WEBVTT\n\n' + list.map((s) =>
    `${fmtFile(s.start, '.')} --> ${fmtFile(s.end, '.')}\n${s.text}\n`).join('\n');
}

$('#exportSrt').addEventListener('click', () => {
  if (!state.subs.length) return toast('還沒有字幕可以匯出');
  download(new Blob(['﻿' + toSRT(subsForExport())], { type: 'application/x-subrip;charset=utf-8' }), state.videoName + '.srt');
});
$('#exportVtt').addEventListener('click', () => {
  if (!state.subs.length) return toast('還沒有字幕可以匯出');
  download(new Blob([toVTT(subsForExport())], { type: 'text/vtt;charset=utf-8' }), state.videoName + '.vtt');
});

/* ---------------- 輸出含字幕（燒錄）影片 ---------------- */

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** 把字幕畫到 canvas 上（與影片上的預覽樣式一致） */
function drawSubtitle(c, text, W, H) {
  if (!text) return;
  const st = state.style;
  const size = (st.size / 100) * H;
  c.font = `${st.bold ? 700 : 400} ${size}px system-ui, "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const maxW = W * 0.9 - size;
  const lines = [];
  for (const raw of text.split('\n')) {
    let line = '';
    for (const ch of raw) {
      if (line && c.measureText(line + ch).width > maxW) {
        // 英文盡量在空白處斷行
        const sp = line.lastIndexOf(' ');
        if (/\w/.test(ch) && sp > 0) { lines.push(line.slice(0, sp)); line = line.slice(sp + 1) + ch; }
        else { lines.push(line); line = ch; }
      } else line += ch;
    }
    lines.push(line);
  }
  const lh = size * 1.25;
  const padX = size * 0.5;
  const padY = size * 0.15;
  const boxW = Math.max(...lines.map((l) => c.measureText(l).width)) + padX * 2;
  const boxH = lh * lines.length + padY * 2;
  const bottom = H - (st.pos / 100) * H;
  const top = bottom - boxH;
  if (st.bgA > 0) {
    c.fillStyle = hexA(st.bg, st.bgA);
    roundRect(c, W / 2 - boxW / 2, top, boxW, boxH, size * 0.2);
    c.fill();
  }
  lines.forEach((l, i) => {
    const y = top + padY + lh * (i + 0.5);
    if (st.outline) {
      c.lineJoin = 'round';
      c.lineWidth = Math.max(2, size * 0.12);
      c.strokeStyle = '#000';
      c.strokeText(l, W / 2, y);
    }
    c.fillStyle = st.color;
    c.fillText(l, W / 2, y);
  });
}

let audioGraph = null;

async function exportBurned() {
  if (!video.src || !video.videoWidth) return toast('請先開啟影片');
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return toast('這個瀏覽器不支援輸出影片，請改用 Chrome / Edge / Firefox');
  if (state.drawMode) setDrawMode(false);

  const W = video.videoWidth;
  const H = video.videoHeight;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const c = cv.getContext('2d');
  const stream = cv.captureStream(30);

  try {
    if (!audioGraph) {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ac = new AC();
      const src = ac.createMediaElementSource(video);
      const dest = ac.createMediaStreamDestination();
      src.connect(ac.destination);
      src.connect(dest);
      audioGraph = { ac, src, dest };
    }
    await audioGraph.ac.resume();
    audioGraph.dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  } catch (err) {
    console.warn('audio capture:', err);
  }

  const types = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: Math.min(16e6, W * H * 30 * 0.15) });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const modal = $('#exportModal');
  const prog = $('#exportProgress');
  const status = $('#exportStatus');
  modal.hidden = false;
  prog.value = 0;
  exporting = { cancelled: false, done: false };
  const job = exporting;

  const wasMuted = video.muted;
  const wasRate = video.playbackRate;
  video.pause();
  state.playUntil = null;
  video.muted = false;
  video.playbackRate = 1;
  await seekTo(0);

  const outTotal = cutStats().after || state.duration;
  const drawFrame = () => {
    c.drawImage(video, 0, 0, W, H);
    const s = subAt(video.currentTime);
    if (s) drawSubtitle(c, s.text, W, H);
    const outT = mapTime(video.currentTime);
    const p = outTotal ? Math.min(1, outT / outTotal) : 0;
    prog.value = p;
    status.textContent = `${Math.floor(p * 100)}%　${fmt(outT)} / ${fmt(outTotal)}`;
  };

  const done = new Promise((resolve) => {
    rec.onstop = resolve;
    const finish = () => {
      if (job.done) return;
      job.done = true;
      drawFrame();
      if (rec.state !== 'inactive') rec.stop();
    };
    const schedule = () => {
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(loop);
      else requestAnimationFrame(loop);
    };
    // 碰到刪除片段：暫停錄影 → 跳過 → 繼續
    const jumpOver = async (cut) => {
      video.pause();
      if (rec.state === 'recording') rec.pause();
      if (cut.end >= state.duration - 0.05) return finish();
      await seekTo(cut.end);
      if (job.cancelled) return finish();
      drawFrame();
      if (rec.state === 'paused') rec.resume();
      try { await video.play(); } catch (e) { job.cancelled = true; return finish(); }
      schedule();
    };
    function loop() {
      if (job.done) return;
      if (job.cancelled || video.ended) return finish();
      const cut = cutAt(video.currentTime);
      if (cut) { jumpOver(cut); return; }
      drawFrame();
      schedule();
    }
    // 影片結束時 requestVideoFrameCallback 不會再觸發，用 ended 事件保底
    video.addEventListener('ended', function onEnd() {
      video.removeEventListener('ended', onEnd);
      setTimeout(finish, 50);
    });

    const start = async () => {
      const first = cutAt(0);
      if (first) await seekTo(first.end);
      drawFrame();
      rec.start(1000);
      try { await video.play(); } catch (e) { console.warn(e); job.cancelled = true; return finish(); }
      schedule();
    };
    start();
  });

  await done;
  video.pause();
  video.muted = wasMuted;
  video.playbackRate = wasRate;
  modal.hidden = true;
  exporting = null;
  if (job.cancelled) return toast('已取消輸出');
  const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
  download(new Blob(chunks, { type: mimeType || 'video/webm' }), `${state.videoName}_subtitled.${ext}`);
  toast('輸出完成！');
}

$('#exportVideo').addEventListener('click', exportBurned);
$('#exportCancel').addEventListener('click', () => { if (exporting) exporting.cancelled = true; });

/* ---------------- 播放控制 ---------------- */

function seek(t) {
  if (!video.src) return;
  video.currentTime = Math.max(0, Math.min(t, state.duration || t));
  state.activeId = -1;
  dirty = true;
}
function togglePlay() {
  if (!video.src) return;
  if (video.paused) {
    if (state.drawMode) setDrawMode(false);
    video.play();
  } else video.pause();
}
function addAtCurrent() {
  if (!video.src) return toast('請先開啟影片');
  const t = video.currentTime;
  const existing = subAt(t);
  if (existing && t - existing.start < MIN_LEN) { focusItemText(existing.id); return; }
  video.pause();
  const s = addSub(t, defaultEnd(t), '');
  focusItemText(s.id);
}

playBtn.addEventListener('click', togglePlay);
video.addEventListener('click', togglePlay);
video.addEventListener('play', () => { playBtn.textContent = '❚❚'; state.activeId = -1; });
video.addEventListener('pause', () => {
  playBtn.textContent = '▶';
  if (!exporting) state.playUntil = null;
  state.activeId = -1;
  dirty = true;
});
video.addEventListener('seeked', () => { dirty = true; });
$('#rate').addEventListener('change', (e) => { if (!exporting) video.playbackRate = +e.target.value; });
$('#addSubBtn').addEventListener('click', addAtCurrent);
$('#splitBtn').addEventListener('click', () => splitAt(video.currentTime));
$('#markCutBtn').addEventListener('click', markCut);
$('#playSelBtn').addEventListener('click', playSelection);
$('#undoBtn').addEventListener('click', undo);
$('#redoBtn').addEventListener('click', redo);
$('#clearBtn').addEventListener('click', () => {
  if (!state.subs.length) return;
  if (!confirm(`確定要刪除全部 ${state.subs.length} 條字幕？（可以按 Ctrl+Z 復原）`)) return;
  pushUndo();
  state.subs = [];
  state.selectedId = null;
  changed();
});

/* ---- 快捷鍵 ---- */

document.addEventListener('keydown', (e) => {
  if (exporting) return;
  const tag = e.target.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable;
  const mod = e.ctrlKey || e.metaKey;

  if (mod && e.key.toLowerCase() === 'z' && !typing) {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); return; }
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal:not(#exportModal)').forEach((m) => (m.hidden = true));
    if (typing) { e.target.blur(); return; }
    if (state.drawMode) setDrawMode(false);
    state.sel = null;
    if (state.selCutId != null) selectCut(null);
    updateSelUI();
    return;
  }
  if (typing || mod || e.altKey) return;

  const sel = byId(state.selectedId);
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); seek(video.currentTime - (e.shiftKey ? 5 : 1)); break;
    case 'ArrowRight': e.preventDefault(); seek(video.currentTime + (e.shiftKey ? 5 : 1)); break;
    case ',': video.pause(); seek(video.currentTime - FRAME); break;
    case '.': video.pause(); seek(video.currentTime + FRAME); break;
    case 'n': case 'N': e.preventDefault(); addAtCurrent(); break;
    case 's': case 'S': splitAt(video.currentTime); break;
    case 'x': case 'X': markCut(); break;
    case 'p': case 'P': playSelection(); break;
    case 'd': case 'D': setDrawMode(!state.drawMode); break;
    case '[': if (sel) setEdge(sel, 'start', video.currentTime); break;
    case ']': if (sel) setEdge(sel, 'end', video.currentTime); break;
    case 'Delete': case 'Backspace':
      if (state.selCutId != null) { e.preventDefault(); deleteCut(state.selCutId); }
      else if (sel) { e.preventDefault(); deleteSub(sel.id); }
      break;
    default: return;
  }
});

/* ---------------- 樣式設定 ---------------- */

const styleInputs = {
  size: $('#stSize'), pos: $('#stPos'), color: $('#stColor'), bg: $('#stBg'),
  bgA: $('#stBgA'), outline: $('#stOutline'), bold: $('#stBold'),
};
for (const [k, inp] of Object.entries(styleInputs)) {
  inp.addEventListener('input', () => {
    state.style[k] = inp.type === 'checkbox' ? inp.checked : inp.type === 'range' ? +inp.value : inp.value;
    applyOverlayStyle();
    save();
  });
}
function syncStyleInputs() {
  for (const [k, inp] of Object.entries(styleInputs)) {
    if (inp.type === 'checkbox') inp.checked = !!state.style[k];
    else inp.value = state.style[k];
  }
}

/* ---------------- 其他 UI ---------------- */

$('#helpBtn').addEventListener('click', () => { $('#helpModal').hidden = false; });
document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', () => { b.closest('.modal').hidden = true; }));

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

new ResizeObserver(() => { resizeCanvas(); }).observe(canvas);
new ResizeObserver(() => { layoutOverlay(); }).observe(player);

/* ---------------- 主迴圈 ---------------- */

let lastLabel = '';
function tick() {
  const playing = !video.paused;
  if (playing && !exporting) {
    const t = video.currentTime;
    if (state.playUntil != null && t >= state.playUntil) {
      video.pause();
      state.playUntil = null;
    } else {
      const skip = state.playUntil != null ? state.playSkip : state.skipCuts;
      const c = skip && cutAt(t);
      if (c) video.currentTime = Math.min(c.end, state.duration);
    }
  }
  if (playing && !drag) followPlayhead();
  if (playing || dirty) {
    draw();
    dirty = false;
  }
  updateOverlay();
  updateNoteHead();
  const label = fmt(video.currentTime) + ' / ' + fmt(state.duration);
  if (label !== lastLabel) { timeLabel.textContent = label; lastLabel = label; }
  requestAnimationFrame(tick);
}

/* ---------------- 啟動 ---------------- */

load();
syncStyleInputs();
$('#skipCuts').checked = state.skipCuts;
renderList();
renderCuts();
renderNotes();
updateCounts();
updateSelUI();
resizeCanvas();
layoutOverlay();
requestAnimationFrame(tick);

// 方便測試 / 除錯
window.__editor = { state, parseTime, parseSubs, toSRT, toVTT, fmt, mapTime, reviewText, cutStats };
