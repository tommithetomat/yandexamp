'use strict'
/* YandexAmp 2.0 — Hi-Fi Deck.
   Talks to the backend only through window.api (tauri-bridge.js). The Yandex
   token never reaches this code: every request is made by the Rust side. */

// ---------- helpers ----------
const $ = (s, root = document) => root.querySelector(s)
const $$ = (s, root = document) => [...root.querySelectorAll(s)]
const api = window.api
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fmt = (sec) => {
  sec = Math.max(0, Math.floor(sec || 0))
  return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0')
}
// time with the colon drawn as two matrix dots (the font's own sits too low)
const tmh = (sec) => fmt(sec).replace(':', '<i class="cl"></i>')
const icon = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`
const cover = (uri, size = 200) => (uri ? 'https://' + String(uri).replace('%%', `${size}x${size}`) : '')
const initials = (name) =>
  (String(name || '').replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('') || '♪').toUpperCase()
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many
}
function hash(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
function rng(seed) {
  let x = seed || 1
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296 }
}
const store = {
  get(k, d) { try { const v = localStorage.getItem('yamp2:' + k); return v == null ? d : JSON.parse(v) } catch { return d } },
  set(k, v) { try { localStorage.setItem('yamp2:' + k, JSON.stringify(v)) } catch {} },
}
function hexA(hex, a) {
  const n = parseInt(String(hex).replace('#', ''), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

// ---------- constants ----------
const FINISHES = [
  { id: 'aluminium', name: 'Алюминий', body: '#D6D7D2', glow: '#FFCE2E' },
  { id: 'graphite', name: 'Графит', body: '#222326', glow: '#FFCE2E' },
  { id: 'classic', name: 'Classic ’98', body: '#2C2C38', glow: '#3CFF6E' },
  { id: 'amber', name: 'Янтарь', body: '#2A1E14', glow: '#FFB54A' },
  { id: 'crimson', name: 'Кармин', body: '#1F0E13', glow: '#FF7A92' },
]
const MOODS = [
  { id: 'all', label: 'Любое' }, { id: 'active', label: 'Бодрое' }, { id: 'fun', label: 'Весёлое' },
  { id: 'calm', label: 'Спокойное' }, { id: 'sad', label: 'Грустное' },
]
const BANDS = [
  { f: 60, l: '60', ru: '60 Гц' }, { f: 170, l: '170', ru: '170 Гц' }, { f: 310, l: '310', ru: '310 Гц' },
  { f: 600, l: '600', ru: '600 Гц' }, { f: 1000, l: '1K', ru: '1 кГц' }, { f: 3000, l: '3K', ru: '3 кГц' },
  { f: 6000, l: '6K', ru: '6 кГц' }, { f: 12000, l: '12K', ru: '12 кГц' }, { f: 14000, l: '14K', ru: '14 кГц' },
  { f: 16000, l: '16K', ru: '16 кГц' },
]
const PRESETS = {
  flat: { label: 'Ровно', g: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  rock: { label: 'Рок', g: [4, 3, 2, -1, -2, 1, 3, 4, 5, 5] },
  pop: { label: 'Поп', g: [-1, 2, 4, 4, 2, -1, -1, -1, 0, 0] },
  classic: { label: 'Классика', g: [4, 3, 2, 1, 0, 0, 0, -1, -2, -3] },
  bass: { label: 'Басы', g: [6, 5, 4, 2, 0, -1, -1, -2, -2, -2] },
}
const VIZ = [
  { k: 'OSC', ru: 'Осциллограф' }, { k: 'SPEC', ru: 'Точечный спектр' }, { k: 'LED', ru: 'LED-матрица' },
  { k: 'PHOS', ru: 'Фосфор' }, { k: 'AURA', ru: 'Сияние' }, { k: 'PULSAR', ru: 'Пульсар' },
  { k: 'FALL', ru: 'Спектрограмма' }, { k: 'ORBIT', ru: 'Орбита' }, { k: 'PRISM', ru: 'Призма' },
]
const ORBIT = 7
const OPEN = [
  { key: 'chart', label: 'Чарт', icon: 'chart' },
  { key: 'new', label: 'Новинки', icon: 'new' },
  { key: 'hist', label: 'История', icon: 'clock' },
]
const DIVERSITY = [
  { id: 'default', label: 'Всё подряд' }, { id: 'favorite', label: 'Любимое' },
  { id: 'discover', label: 'Незнакомое' }, { id: 'popular', label: 'Популярное' },
]
const LANGS = [{ id: 'any', label: 'Любой' }, { id: 'russian', label: 'Русский' }, { id: 'not-russian', label: 'Иностранный' }]
const STATION_GROUPS = { genre: 'Жанры', mood: 'Настроение', activity: 'Занятия', epoch: 'Эпохи', local: 'Места' }
const SIDE_STATIONS = 8
const CFG = {
  coverAccent: false, side: true, eq: true, panel: true, lyricLine: true, video: true,
  mini: 'h', miniPin: true, miniLyrics: true, prefetch: true,
}
const EQF = BANDS.map((b) => b.f)

// ---------- state ----------
const savedEq = store.get('eq', null)
const S = {
  finish: store.get('finish', 'aluminium'),
  viz: Math.min(VIZ.length - 1, Math.max(0, store.get('viz', 0) | 0)),
  vol: store.get('vol', 72), bal: store.get('bal', 0),
  eqOn: store.get('eqOn', true),
  eq: Array.isArray(savedEq) && savedEq.length === 11 ? savedEq : [0, ...PRESETS.rock.g],
  preset: store.get('preset', 'rock'),
  mood: store.get('mood', 'all'), div: store.get('div', 'default'), lang: store.get('lang', 'any'),
  queue: store.get('queue', []), cur: store.get('cur', -1), source: store.get('source', ''),
  wave: store.get('waveMode', false), nav: store.get('nav', null),
  shuffle: store.get('shuffle', false), repeat: store.get('repeat', false), pin: store.get('pin', false),
  tab: 'queue', history: [], liked: new Set(), dur: 0,
  smart: [], mine: null, stations: null, played: store.get('played', []),
  search: { q: '', results: [] }, artist: null, mini: false,
  cfg: { ...CFG, ...store.get('cfg', {}) },
}
if (!Array.isArray(S.queue)) S.queue = []
if (S.cur >= S.queue.length) S.cur = S.queue.length - 1

const audio = $('#audio')
let C = {}
function readColors() {
  const cs = getComputedStyle(document.documentElement)
  for (const k of ['scr', 'scrInk', 'scrDim', 'v1', 'v2', 'v3', 'led', 'trace']) C[k] = cs.getPropertyValue('--' + k).trim()
}

// ---------- toast & errors ----------
let toastTimer = null
function toast(msg) {
  const el = $('#toast')
  el.innerHTML = `<div>${esc(msg)}</div>`
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.innerHTML = '' }, 2600)
}
function fail(msg) {
  msg = msg || 'Что-то пошло не так'
  if (/Сессия истекла|Не выполнен вход/.test(msg)) return toLogin('Сессия истекла — войдите заново')
  toast(msg)
}

// ---------- screens ----------
function show(id) {
  for (const s of ['login', 'player', 'mini', 'mini-v']) $('#' + s).classList.toggle('hidden', s !== id)
}
async function layout(mode) {
  try { await api.window.layout(mode) } catch {}
}
function toLogin(message) {
  audio.pause()
  S.mini = false
  show('login')
  layout('login')
  $('#login-error').textContent = message || ''
}

// ---------- finish ----------
function applyFinish(id) {
  if (!FINISHES.some((f) => f.id === id)) id = 'aluminium'
  S.finish = id
  document.documentElement.dataset.finish = id
  store.set('finish', id)
  applyAccent()
  renderFinishes()
}
function renderFinishes() {
  $('#set-finish').innerHTML = FINISHES.map((f) =>
    `<button class="fin" role="radio" data-f="${f.id}" aria-checked="${S.finish === f.id}">
      <i style="background:${f.body};--s:linear-gradient(90deg, ${f.glow} 0 45%, #0B0C0D 45%);--g:${f.glow}"></i>${f.name}</button>`).join('')
}
// "Cover glow": the screen picks up the colour Yandex derives from the artwork
function liftColor(hex) {
  const n = parseInt(hex.slice(1), 16)
  let r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l0 = (mx + mn) / 2, dd = mx - mn
  let h = 0
  if (dd) h = mx === r ? ((g - b) / dd) % 6 : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4
  h = (h * 60 + 360) % 360
  const sat = Math.max(0.55, dd ? dd / (1 - Math.abs(2 * l0 - 1)) : 0), l = Math.min(0.72, Math.max(0.6, l0))
  const k = (1 - Math.abs(2 * l - 1)) * Math.min(1, sat), x = k * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - k / 2
  ;[r, g, b] = h < 60 ? [k, x, 0] : h < 120 ? [x, k, 0] : h < 180 ? [0, k, x] : h < 240 ? [0, x, k] : h < 300 ? [x, 0, k] : [k, 0, x]
  return '#' + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')
}
function applyAccent() {
  const t = S.queue[S.cur]
  const st = document.documentElement.style
  const col = S.cfg.coverAccent && t && /^#[0-9a-f]{6}$/i.test(t.color || '') ? liftColor(t.color) : null
  // --led also colours faders and lamps on the body: keep it on the light finish
  const keys = S.finish === 'aluminium' ? ['--trace', '--v2'] : ['--trace', '--v2', '--led']
  for (const k of ['--trace', '--v2', '--led']) st.removeProperty(k)
  if (col) for (const k of keys) st.setProperty(k, col)
  readColors()
}

// ---------- settings ----------
function applyCfg() {
  const p = $('#player')
  p.classList.toggle('no-side', !S.cfg.side)
  p.classList.toggle('no-eq', !S.cfg.eq)
  p.classList.toggle('no-panel', !S.cfg.panel)
  for (const inp of $$('[data-cfg]')) inp.checked = !!S.cfg[inp.dataset.cfg]
  for (const b of $$('[data-mini]')) b.setAttribute('aria-checked', String(S.cfg.mini === b.dataset.mini))
  for (const b of $$('.ly-toggle')) b.setAttribute('aria-pressed', String(S.cfg.miniLyrics))
}
function setCfg(k, v) {
  S.cfg[k] = v
  store.set('cfg', S.cfg)
  applyCfg()
  if (k === 'coverAccent') applyAccent()
  if (k === 'video') stageTrack(S.queue[S.cur])
  if (k === 'miniPin' && S.mini) api.window.setPin(v || S.pin)
}
function ensurePanel() {
  if (!S.cfg.panel) setCfg('panel', true)
}
function openSettings() {
  closeMenu()
  closeGallery()
  renderFinishes()
  applyCfg()
  $('#settings').classList.remove('hidden')
  $('#settings .sheet-head [data-close]').focus()
}
function closeSettings() {
  if ($('#settings').classList.contains('hidden')) return
  $('#settings').classList.add('hidden')
  $('#btn-settings').focus()
}

// ---------- login ----------
function initLogin() {
  const err = (m) => { $('#login-error').textContent = m || '' }
  const done = (r) => (r.success ? enterPlayer() : err(r.error || 'Вход отменён'))
  $('#login-browser').addEventListener('click', async (e) => {
    const b = e.currentTarget
    err('')
    b.disabled = true
    b.lastChild.textContent = 'Ждём вход в окне Яндекса…'
    const r = await api.yandex.loginBrowser()
    b.disabled = false
    b.lastChild.textContent = 'Войти через Яндекс'
    done(r)
  })
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    err('')
    const b = $('button', e.currentTarget)
    b.disabled = true
    const r = await api.yandex.login($('#login-user').value.trim(), $('#login-pass').value)
    b.disabled = false
    $('#login-pass').value = ''
    done(r)
  })
  $('#token-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    err('')
    const r = await api.yandex.loginWithToken($('#login-token').value.trim())
    $('#login-token').value = ''
    done(r)
  })
}

// ---------- player entry ----------
let entered = false
async function enterPlayer() {
  show('player')
  await layout('player')
  ensureAudio()
  if (!entered) {
    entered = true
    if (S.pin) api.window.setPin(true)
    checkUpdate()
  }
  renderAll()
  loadLibrary()
  refreshStaleQueue()
}

// A queue saved by an older version lacks artists, clips and colours — top it up
async function refreshStaleQueue() {
  if (!S.queue.some((t) => !('video' in t))) return
  const r = await api.yandex.refreshTracks(S.queue.map((t) => t.id))
  if (!r.success) return
  const fresh = new Map(r.data.map((t) => [String(t.id), t]))
  S.queue = S.queue.map((t) => fresh.get(String(t.id)) || { ...t, video: null })
  saveQueue()
  renderQueue()
  renderNowPlaying()
}

function renderAll() {
  renderSide()
  renderQueue()
  renderNowPlaying()
  renderTransport()
  renderVol()
  renderBal()
  renderPresets()
  paintFaders()
  renderViz()
  setTab(S.tab)
}

async function loadLibrary() {
  const [ids, smart, mine, st] = await Promise.all([
    api.yandex.getLikedIds(), api.yandex.getSmartPlaylists(), api.yandex.getPlaylists(), api.yandex.getStationsList(),
  ])
  if (!ids.success && /Сессия истекла/.test(ids.error || '')) return fail(ids.error)
  if (ids.success) S.liked = new Set(ids.data.map(String))
  S.smart = smart.success ? smart.data : []
  S.mine = mine.success ? mine.data : { error: mine.error }
  S.stations = st.success ? st.data : { error: st.error }
  renderSide()
  renderQueue()
  renderLike()
}

// ---------- sidebar ----------
function smartIcon(title) {
  const t = String(title).toLowerCase()
  if (t.includes('дня')) return 'sun'
  if (t.includes('премьер')) return 'spark'
  if (t.includes('дежавю')) return 'again'
  if (t.includes('тайник')) return 'lock'
  return 'list'
}
function navBtn(key, label, ic, count = '') {
  return `<button class="nav" data-src="${esc(key)}" data-label="${esc(label)}" aria-current="${S.nav === key ? 'page' : 'false'}">
    ${icon(ic)}<span class="lbl">${esc(label)}</span><span class="cnt">${esc(count)}</span></button>`
}
function renderSide() {
  $('#moods').innerHTML = MOODS.map((m) =>
    `<button class="mood" data-mood="${m.id}" aria-pressed="${S.mood === m.id}">${m.label}</button>`).join('')
  const mood = MOODS.find((m) => m.id === S.mood) || MOODS[0]
  $('#wave-sub').textContent = S.mood === 'all' ? 'Бесконечный поток под вас' : 'Настроение: ' + mood.label.toLowerCase()
  $('#pick-div > span').textContent = (DIVERSITY.find((d) => d.id === S.div) || DIVERSITY[0]).label
  $('#pick-lang > span').textContent = (LANGS.find((l) => l.id === S.lang) || LANGS[0]).label

  $('#nav-foryou').innerHTML = navBtn('likes', 'Мне нравится', 'heart', S.liked.size || '') +
    S.smart.map((p) => navBtn(`pl:${p.uid}:${p.kind}`, p.title, smartIcon(p.title))).join('')

  const mine = $('#nav-mine')
  if (S.mine === null) mine.innerHTML = '<p class="muted">Загружаем…</p>'
  else if (S.mine.error) mine.innerHTML = `<p class="muted">${esc(S.mine.error)} · <button class="link" data-retry>Повторить</button></p>`
  else if (!S.mine.length) mine.innerHTML = '<p class="muted">Своих плейлистов пока нет</p>'
  else mine.innerHTML = S.mine.map((p) => navBtn(`pl:${p.uid}:${p.kind}`, p.title, 'list', p.trackCount || '')).join('')

  $('#nav-open').innerHTML = OPEN.map((o) =>
    `<button class="key tile" data-src="${o.key}" data-label="${o.label}" aria-current="${S.nav === o.key ? 'page' : 'false'}">${icon(o.icon)}<span>${o.label}</span></button>`).join('')

  const st = $('#nav-stations')
  if (S.stations === null) st.innerHTML = '<p class="muted">Загружаем…</p>'
  else if (S.stations.error) st.innerHTML = `<p class="muted">${esc(S.stations.error)} · <button class="link" data-retry>Повторить</button></p>`
  else {
    st.innerHTML = S.stations.slice(0, SIDE_STATIONS).map(stationChip).join('') +
      (S.stations.length > SIDE_STATIONS ? `<button class="chip-btn more" data-panel="stations">Все станции · ${S.stations.length}${icon('arrow')}</button>` : '')
  }
}
function stationChip(s) {
  return `<button class="chip-btn" data-src="st:${esc(s.id)}" data-label="${esc(s.title)}" aria-pressed="${S.nav === 'st:' + s.id}" title="${esc(s.title)}">${esc(s.title)}</button>`
}

// "All stations" lives in the right panel: grouped, filterable, closable
function renderStations() {
  const list = Array.isArray(S.stations) ? S.stations : []
  const q = $('#st-filter').value.trim().toLowerCase()
  const shown = q ? list.filter((s) => s.title.toLowerCase().includes(q)) : list
  if (!shown.length) { $('#st-body').innerHTML = '<p class="empty">Ничего не нашлось</p>'; return }
  const groups = new Map()
  for (const s of shown) {
    const g = STATION_GROUPS[s.type] || 'Другое'
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push(s)
  }
  $('#st-body').innerHTML = [...groups].map(([g, items]) =>
    `<section class="st-group"><h3>${esc(g)} · ${items.length}</h3><div class="chips">${items.map(stationChip).join('')}</div></section>`).join('')
}

// "History": what Yandex lists as recently played + what played in this app
async function loadHistory() {
  const body = $('#hist-body')
  const local = S.played.length
    ? `<section><h3>Играло в YandexAmp</h3><ol class="rows">${S.played.slice(0, 50).map((t, i) => rowHtml(t, i, 'h')).join('')}</ol></section>`
    : ''
  body.innerHTML = '<p class="muted">Загружаем…</p>' + local
  const r = await api.yandex.getPlayHistory()
  if (S.tab !== 'history') return
  const ctx = r.success ? r.data.contexts : []
  const remote = ctx.length
    ? `<section><h3>Недавно слушали</h3>${ctx.map((c, i) =>
      `<button class="ctx" data-ctx="${i}">${c.cover ? `<img class="ctx-cover${c.kind === 'artist' ? ' artist' : ''}" alt="" loading="lazy" src="${esc(cover(c.cover, 100))}">` : `<i class="ctx-cover${c.kind === 'artist' ? ' artist' : ''}"></i>`}
        <span class="ctx-txt"><span class="ctx-t">${esc(c.title)}</span><span class="ctx-s">${esc(c.subtitle || '')}</span></span></button>`).join('')}</section>`
    : (r.success ? '' : `<p class="empty">${esc(r.error)}</p>`)
  S.historyCtx = ctx
  body.innerHTML = remote + local || '<p class="empty">История пока пуста</p>'
}
async function openContext(c) {
  if (c.kind === 'playlist') {
    const [uid, kind] = c.id.split(':')
    return openSource(`pl:${uid}:${kind}`, c.title)
  }
  if (c.kind === 'artist') return openArtist({ artistId: c.id })
  toast(`Загружаем альбом «${c.title}»`)
  const r = await api.yandex.getAlbumTracks(c.id)
  if (!r.success) return fail(r.error)
  if (!r.data.tracks.length) return toast('Альбом пуст')
  playFromList(r.data.tracks, 0, `Альбом: ${r.data.title}`)
}
function rememberPlayed(t) {
  S.played = [t, ...S.played.filter((x) => x.id !== t.id)].slice(0, 200)
  store.set('played', S.played)
}

// A dropdown under `btn`: a choice (value given → radio items with a check) or a plain list
function openPicker(btn, options, value, onPick) {
  const menu = $('#menu')
  if (!menu.classList.contains('hidden') && menu._anchor === btn) return closeMenu()
  menu._anchor = btn
  const radio = value !== undefined
  menu.innerHTML = options.map((o) => radio
    ? `<button role="menuitemradio" data-v="${esc(o.id)}" aria-checked="${o.id === value}">${esc(o.label)}${o.id === value ? icon('check', 'check') : ''}</button>`
    : `<button role="menuitem" data-v="${esc(o.id)}">${o.icon ? icon(o.icon) : ''}${esc(o.label)}</button>`).join('')
  menu.classList.remove('hidden')
  btn.setAttribute('aria-expanded', 'true')
  const r = btn.getBoundingClientRect()
  menu.style.minWidth = r.width + 'px'
  menu.style.left = Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8)) + 'px'
  menu.style.top = r.bottom + 4 + 'px'
  menu.onclick = (e) => {
    const b = e.target.closest('button[data-v]')
    if (!b) return
    closeMenu()
    onPick(b.dataset.v)
  }
  ;($('[aria-checked="true"]', menu) || $('button', menu))?.focus()
}

// ---------- artists ----------
function artistsOf(t) {
  if (!t) return []
  if (Array.isArray(t.artists) && t.artists.length) return t.artists
  return t.artistId ? [{ id: t.artistId, name: t.artist }] : []
}
// Several artists on a track: the name opens a list of all of them
function artistClick(btn) {
  const t = S.queue[S.cur]
  const list = artistsOf(t)
  if (list.length <= 1) return openArtist(t)
  openPicker(btn, list.map((a) => ({ id: a.id, label: a.name, icon: 'user' })), undefined, (id) => openArtist({ artistId: id }))
}

async function openSource(key, label) {
  let loader
  if (key === 'likes') loader = () => api.yandex.getLikedTracks()
  else if (key === 'chart') loader = () => api.yandex.getChart()
  else if (key === 'new') loader = () => api.yandex.getNewReleases()
  else if (key === 'hist') return setTab('history')
  else if (key.startsWith('pl:')) { const [, uid, kind] = key.split(':'); loader = () => api.yandex.getPlaylistTracks(uid, kind) }
  else if (key.startsWith('st:')) { const id = key.slice(3); loader = () => api.yandex.getStationTracks(id) }
  else return
  S.nav = key
  store.set('nav', key)
  renderSide()
  if (S.tab === 'stations') renderStations()
  toast(`Загружаем: ${label}`)
  const r = await loader()
  if (!r.success) return fail(r.error)
  if (!r.data.tracks.length) return toast('Здесь пока пусто')
  setQueue(r.data.tracks, label || r.data.title, false)
  playAt(0, false)
}

async function startWave() {
  S.nav = 'wave'
  store.set('nav', 'wave')
  renderSide()
  toast('Настраиваем волну')
  await api.yandex.setWaveSettings({ moodEnergy: S.mood, diversity: S.div, language: S.lang })
  const r = await api.yandex.getWaveTracks(false)
  if (!r.success) return fail(r.error)
  if (!r.data.tracks.length) return toast('Волна пока молчит — попробуйте позже')
  setQueue(r.data.tracks, 'Моя волна', true)
  playAt(0, false)
}

let waveLoading = null
function extendWave(force = false) {
  if (!S.wave || waveLoading) return waveLoading || Promise.resolve()
  if (!force && S.cur < S.queue.length - 3) return Promise.resolve()
  waveLoading = api.yandex.getWaveTracks(true).then((r) => {
    if (!r.success || !S.wave) return
    const have = new Set(S.queue.map((t) => t.id))
    const add = r.data.tracks.filter((t) => !have.has(t.id))
    if (add.length) {
      S.queue.push(...add)
      saveQueue()
      renderQueue()
    }
  }).finally(() => { waveLoading = null })
  return waveLoading
}

// ---------- queue & playback ----------
function setQueue(tracks, source, wave) {
  S.queue = tracks.slice()
  S.cur = -1
  S.source = source
  S.wave = !!wave
  S.history = []
  saveQueue()
  renderQueue()
  renderNowPlaying()
}
function saveQueue() {
  store.set('queue', S.queue.slice(0, 3000))
  store.set('cur', S.cur)
  store.set('source', S.source)
  store.set('waveMode', S.wave)
}

let playSeq = 0
async function playAt(i, remember = true) {
  const t = S.queue[i]
  if (!t) return
  ensureAudio()
  if (remember && S.cur >= 0 && S.cur !== i && S.queue[S.cur]) {
    S.history.push(S.queue[S.cur].id)
    if (S.history.length > 300) S.history.shift()
  }
  const prev = S.cur
  S.cur = i
  saveQueue()
  const seq = ++playSeq
  S.dur = (t.duration || 0) / 1000
  markCurrent(prev)
  renderNowPlaying()
  setState('load')
  const r = await api.yandex.getTrackUrl(t.id)
  if (seq !== playSeq) return
  if (!r.success) { setState('stop'); return fail(r.error) }
  audio.src = r.url
  try {
    await AC.resume()
    await audio.play()
  } catch (e) {
    if (seq !== playSeq || e.name === 'AbortError') return
    setState('stop')
    return toast('Не удалось воспроизвести: ' + e.message)
  }
  if (S.wave) api.yandex.waveFeedback('trackStarted', t.id)
  rememberPlayed(t)
  extendWave()
  mediaMeta(t)
  schedulePrefetch()
}

// The next track is downloaded ahead, so the change is instant and a network
// drop right at the boundary doesn't stop the music
let prefetchTimer = null
function schedulePrefetch() {
  clearTimeout(prefetchTimer)
  if (!S.cfg.prefetch) return
  prefetchTimer = setTimeout(() => {
    const k = peekNext()
    if (k >= 0 && S.queue[k]) api.yandex.prefetch(S.queue[k].id)
  }, 8000)
}

// Shuffle picks the next track in advance, so it can be prefetched too
let shufflePick = null
function peekNext() {
  const n = S.queue.length
  if (!n) return -1
  if (S.shuffle && n > 1) {
    const cur = S.queue[S.cur]?.id
    if (!shufflePick || shufflePick.from !== cur || !S.queue[shufflePick.k]) {
      let k
      do { k = Math.floor(Math.random() * n) } while (k === S.cur)
      shufflePick = { from: cur, k }
    }
    return shufflePick.k
  }
  if (S.cur + 1 < n) return S.cur + 1
  return S.wave ? -1 : 0
}
function nextIndex() {
  const k = peekNext()
  shufflePick = null
  return k
}
function next() {
  const k = nextIndex()
  if (k >= 0) return playAt(k)
  if (S.wave) {
    toast('Подгружаем волну')
    extendWave(true).then(() => { if (S.cur + 1 < S.queue.length) playAt(S.cur + 1) })
  }
}
function skip() {
  const t = S.queue[S.cur]
  if (S.wave && t) api.yandex.waveFeedback('skip', t.id, audio.currentTime || 0)
  next()
}
function prev() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return }
  while (S.history.length) {
    const id = S.history.pop()
    const k = S.queue.findIndex((t) => t.id === id)
    if (k >= 0) return playAt(k, false)
  }
  if (S.queue.length) playAt((S.cur - 1 + S.queue.length) % S.queue.length, false)
}
function togglePlay() {
  if (!S.queue.length) return toast('Выберите музыку слева или найдите трек')
  if (S.cur < 0) return playAt(0, false)
  if (!audio.src) return playAt(S.cur, false)
  ensureAudio()
  AC.resume()
  if (audio.paused) audio.play().catch((e) => toast('Не удалось воспроизвести: ' + e.message))
  else audio.pause()
}
function stop() {
  audio.pause()
  if (audio.src) audio.currentTime = 0
  setState('stop')
}

function moveTrack(from, to) {
  if (from === to || from < 0 || to < 0) return
  const curId = S.queue[S.cur]?.id
  const [t] = S.queue.splice(from, 1)
  S.queue.splice(to > from ? to - 1 : to, 0, t)
  S.cur = S.queue.findIndex((x) => x.id === curId)
  saveQueue()
  renderQueue()
}
function queueNext(i) {
  if (i === S.cur) return
  const t = S.queue[i]
  moveTrack(i, S.cur + 1)
  toast(`«${t.title}» заиграет следующим`)
}
function insertNext(t) {
  const have = S.queue.findIndex((x) => x.id === t.id)
  if (have >= 0) return queueNext(have)
  S.queue.splice(S.cur + 1, 0, t)
  saveQueue()
  renderQueue()
  toast(`«${t.title}» заиграет следующим`)
}
function appendTrack(t) {
  if (S.queue.some((x) => x.id === t.id)) return toast('Уже в очереди')
  S.queue.push(t)
  if (!S.source) S.source = 'Моя подборка'
  saveQueue()
  renderQueue()
  toast(`«${t.title}» добавлен в очередь`)
}
function removeAt(i) {
  const t = S.queue[i]
  if (!t) return
  const curId = S.queue[S.cur]?.id
  S.queue.splice(i, 1)
  if (t.id === curId) { stop(); S.cur = Math.min(i, S.queue.length - 1); audio.removeAttribute('src') }
  else S.cur = S.queue.findIndex((x) => x.id === curId)
  saveQueue()
  renderQueue()
  renderNowPlaying()
  toast(`«${t.title}» убран из очереди`)
}
async function trackRadio(t) {
  toast(`Радио по треку «${t.title}»`)
  const r = await api.yandex.getTrackRadio(t.id)
  if (!r.success) return fail(r.error)
  const rest = r.data.tracks.filter((x) => x.id !== t.id)
  setQueue([t, ...rest], `Радио: ${t.title}`, false)
  S.nav = null
  renderSide()
  playAt(0, false)
}
function playFromList(list, i, source) {
  setQueue(list, source, false)
  S.nav = null
  renderSide()
  playAt(i, false)
}
function playFromSearch(t) {
  const k = S.queue.findIndex((x) => x.id === t.id)
  if (k >= 0) return playAt(k)
  const at = S.cur + 1
  S.queue.splice(at, 0, t)
  if (!S.source) S.source = 'Моя подборка'
  saveQueue()
  renderQueue()
  playAt(at)
}

async function toggleLike(t) {
  const id = String(t.id)
  const was = S.liked.has(id)
  was ? S.liked.delete(id) : S.liked.add(id)
  refreshLikes()
  const r = await (was ? api.yandex.unlikeTrack(id) : api.yandex.likeTrack(id))
  if (!r.success) {
    was ? S.liked.add(id) : S.liked.delete(id)
    refreshLikes()
    return fail(r.error)
  }
  toast(was ? 'Убрано из «Мне нравится»' : 'Добавлено в «Мне нравится»')
}
async function dislike() {
  const t = S.queue[S.cur]
  if (!t) return
  const r = await api.yandex.dislikeTrack(t.id)
  if (!r.success) return fail(r.error)
  S.liked.delete(String(t.id))
  toast('Понятно — такое больше не предложим')
  skip()
}

// ---------- audio engine ----------
let AC = null
let N = null
function ensureAudio() {
  if (AC) return
  AC = new AudioContext()
  const src = AC.createMediaElementSource(audio)
  const pre = AC.createGain()
  const filters = BANDS.map((b, i) => {
    const f = AC.createBiquadFilter()
    f.type = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking'
    f.frequency.value = b.f
    f.Q.value = 1.2
    return f
  })
  const pan = AC.createStereoPanner()
  const an = AC.createAnalyser()
  an.fftSize = 4096
  an.smoothingTimeConstant = 0.7
  an.minDecibels = -88
  an.maxDecibels = -22
  const split = AC.createChannelSplitter(2)
  const aL = AC.createAnalyser(), aR = AC.createAnalyser()
  aL.fftSize = aR.fftSize = 1024
  const vol = AC.createGain()
  // Gentle limiter: evens out loudness between tracks, stops EQ boosts clipping
  const comp = AC.createDynamicsCompressor()
  comp.threshold.value = -14
  comp.knee.value = 18
  comp.ratio.value = 3
  comp.attack.value = 0.005
  comp.release.value = 0.25
  src.connect(pre)
  let node = pre
  for (const f of filters) { node.connect(f); node = f }
  node.connect(pan)
  pan.connect(an)
  pan.connect(split)
  split.connect(aL, 0)
  split.connect(aR, 1)
  pan.connect(vol)
  vol.connect(comp)
  comp.connect(AC.destination)
  N = {
    pre, filters, pan, an, aL, aR, vol,
    freq: new Uint8Array(an.frequencyBinCount), time: new Uint8Array(an.fftSize),
    tL: new Float32Array(aL.fftSize), tR: new Float32Array(aR.fftSize),
  }
  applyEq()
  applyVol()
  applyBal()
}
function applyEq() {
  eqDirty = true
  if (!N) return
  N.pre.gain.value = S.eqOn ? Math.pow(10, S.eq[0] / 20) : 1
  N.filters.forEach((f, i) => { f.gain.value = S.eqOn ? S.eq[i + 1] : 0 })
}
function applyVol() { if (N) N.vol.gain.value = Math.pow(S.vol / 100, 2) }
function applyBal() { if (N) N.pan.pan.value = S.bal / 50 }

// Network trouble (VPN reconnects): the backend keeps the download going and
// resumes it; here we re-attach the player at the same spot a few times
let recoverTries = 0, stallTimer = null
function recover() {
  const t = S.queue[S.cur], src = audio.getAttribute('src')
  if (!t || !src) return
  if (recoverTries >= 4) {
    setState('stop')
    return toast('Нет связи с Яндексом — проверьте сеть и нажмите Play')
  }
  recoverTries++
  const pos = audio.currentTime || 0
  setState('load')
  setTimeout(() => {
    if (S.queue[S.cur] !== t || audio.getAttribute('src') !== src) return
    audio.src = src
    audio.addEventListener('loadedmetadata', () => {
      try { audio.currentTime = pos } catch {}
      audio.play().catch(() => {})
    }, { once: true })
  }, 700 * recoverTries)
}
function watchStall() {
  clearTimeout(stallTimer)
  stallTimer = setTimeout(() => { if (playState === 'load' && audio.getAttribute('src') && !audio.paused) recover() }, 25000)
}
audio.addEventListener('playing', () => { recoverTries = 0; clearTimeout(stallTimer); setState('play') })
audio.addEventListener('pause', () => { clearTimeout(stallTimer); setState(audio.currentTime > 0.5 ? 'pause' : 'stop') })
audio.addEventListener('waiting', () => { setState('load'); watchStall() })
audio.addEventListener('stalled', watchStall)
audio.addEventListener('ended', () => {
  const t = S.queue[S.cur]
  if (S.repeat) { audio.currentTime = 0; audio.play(); return }
  if (S.wave && t) api.yandex.waveFeedback('trackFinished', t.id, audio.duration || 0)
  next()
})
audio.addEventListener('error', () => {
  if (audio.error && audio.error.code !== 1 && audio.getAttribute('src')) recover()
})

// ---------- now playing ----------
let playState = 'stop'
function setState(kind) {
  playState = kind
  document.body.classList.toggle('playing', kind === 'play')
  $('#st-state b').textContent = { play: 'PLAY', pause: 'PAUSE', load: 'LOAD', stop: 'STOP' }[kind]
  const playing = kind === 'play' || kind === 'load'
  for (const b of [$('#btn-play'), $('#m-play'), $('#mv-play')]) {
    $('use', b).setAttribute('href', playing ? '#i-pause' : '#i-play')
    b.setAttribute('aria-label', playing ? 'Пауза' : 'Играть')
  }
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
  syncVideo()
}

function vinylLabel(t) {
  if (!t) return '♪'
  return t.coverUri ? `<img alt="" src="${esc(cover(t.coverUri, 200))}">` : esc(initials(t.artist))
}
function renderNowPlaying() {
  const t = S.queue[S.cur]
  const title = t ? t.title : 'YandexAmp'
  const el = $('#np-title')
  el.classList.remove('marquee')
  el.innerHTML = `<span>${esc(title)}</span>`
  requestAnimationFrame(() => {
    const sp = el.firstElementChild
    if (sp && sp.scrollWidth > el.clientWidth + 2) {
      el.classList.add('marquee')
      el.style.setProperty('--mq', Math.max(8, Math.round(title.length * 0.45)) + 's')
      sp.innerHTML = `<span>${esc(title)}</span><span aria-hidden="true">${esc(title)}</span>`
    }
  })
  const many = artistsOf(t).length > 1
  for (const b of [$('#np-artist'), $('#mv-artist')]) {
    $('span', b).textContent = t ? t.artist : b.id === 'np-artist' ? 'Выберите музыку слева' : ''
    $('.chev', b).classList.toggle('hidden', !many)
    b.setAttribute('aria-haspopup', many ? 'menu' : 'false')
    b.setAttribute('aria-label', many ? `Исполнители: ${t.artist}` : t ? `Об исполнителе: ${t.artist}` : '')
  }
  $('#np-source').textContent = S.source || ''
  $('.np-sub .dot').classList.toggle('hidden', !t || !S.source)
  $('#vinyl-label').innerHTML = vinylLabel(t)
  $('#m-label').innerHTML = vinylLabel(t)
  $('#m-title').textContent = title
  $('#m-artist').textContent = t ? t.artist : ''
  $('#mv-title').textContent = title
  $('#led-wave').classList.toggle('on', S.wave)
  $('#led-eq').classList.toggle('on', S.eqOn)
  document.title = t ? `${t.title} — ${t.artist}` : 'YandexAmp'
  lastSec = -1
  renderLike()
  buildSeekBars()
  applyAccent()
  stageTrack(t)
  fetchLyrics(t)
}
function renderLike() {
  const t = S.queue[S.cur]
  const liked = !!t && S.liked.has(String(t.id))
  for (const b of [$('#btn-like'), $('#m-like'), $('#mv-like')]) {
    b.setAttribute('aria-pressed', String(liked))
    b.setAttribute('aria-label', liked ? 'Убрать из «Мне нравится»' : 'Нравится')
    $('use', b).setAttribute('href', liked ? '#i-heart-f' : '#i-heart')
  }
}
function refreshLikes() {
  renderLike()
  for (const b of $$('.row [data-a="like"]')) {
    const row = b.closest('.row')
    const liked = S.liked.has(row.dataset.id)
    b.setAttribute('aria-pressed', String(liked))
    $('use', b).setAttribute('href', liked ? '#i-heart-f' : '#i-heart')
  }
  const likes = $('[data-src="likes"] .cnt')
  if (likes) likes.textContent = S.liked.size || ''
}

// seek bar: stylised bars, lit up to the play position
let seekEls = [], seekHead = -2
function buildSeekBars() {
  const box = $('#seek-bars')
  const n = Math.max(24, Math.floor((box.clientWidth || 560) / 7))
  const t = S.queue[S.cur]
  const r = rng(hash(t ? String(t.id) : 'idle'))
  let html = ''
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1)
    const env = Math.min(1, 0.25 + x * 4) * (x > 0.6 && x < 0.68 ? 0.45 : 1) * Math.min(1, (1 - x) * 6 + 0.2)
    html += `<i style="height:${Math.round(5 + 25 * env * (0.5 + 0.5 * r()))}px"></i>`
  }
  box.innerHTML = html
  seekEls = [...box.children]
  seekHead = -2
}
function paintSeek(frac) {
  const n = seekEls.length
  const head = frac > 0 ? Math.min(n - 1, Math.floor(frac * n)) : -1
  if (head === seekHead) return
  seekHead = head
  seekEls.forEach((el, i) => { el.className = i === head ? 'head' : i < head ? 'on' : '' })
}
let lastSec = -1
function tickTime() {
  const cur = audio.currentTime || 0
  const dur = audio.duration && isFinite(audio.duration) ? audio.duration : S.dur
  const sec = Math.floor(cur)
  if (sec !== lastSec) {
    lastSec = sec
    const c = tmh(cur), total = tmh(dur)
    $('#t-cur').innerHTML = c
    $('#t-left').innerHTML = '-' + tmh(Math.max(0, dur - cur))
    $('#seek-cur').innerHTML = c
    $('#seek-total').innerHTML = total
    $('#m-time').innerHTML = c
    $('#mv-cur').innerHTML = c
    $('#mv-total').innerHTML = total
    for (const seek of [$('#seek'), $('#mv-seek')]) {
      seek.max = String(Math.max(1, dur))
      if (document.activeElement !== seek) seek.value = String(cur)
    }
    if ('mediaSession' in navigator && dur > 0 && navigator.mediaSession.setPositionState) {
      try { navigator.mediaSession.setPositionState({ duration: dur, position: Math.min(cur, dur), playbackRate: 1 }) } catch {}
    }
  }
  const frac = dur > 0 ? Math.min(1, cur / dur) : 0
  paintSeek(frac)
  $('#mv-fill').style.width = frac * 100 + '%'
  $('#mv-cap').style.left = frac * 100 + '%'
}

// ---------- queue / list rendering ----------
function rowHtml(t, i, kind) {
  const cur = kind === 'q' && i === S.cur
  const liked = S.liked.has(String(t.id))
  const lead = kind === 'q'
    ? `<span class="row-n">${cur ? '<span class="eqbars"><i></i><i></i><i></i></span>' : i + 1}</span>`
    : (t.coverUri ? `<img class="row-cover" alt="" loading="lazy" src="${esc(cover(t.coverUri, 50))}">` : '<span class="row-cover"></span>')
  return `<li class="row${cur ? ' cur' : ''}" data-i="${i}" data-id="${esc(t.id)}" data-kind="${kind}"${kind === 'q' ? ' draggable="true"' : ''}>
    <button class="row-main" data-a="play" aria-label="Играть: ${esc(t.title)} — ${esc(t.artist)}">${lead}<span class="row-txt"><span class="row-t">${esc(t.title)}</span><span class="row-a">${t.video ? `<svg class="ic clip-mark" aria-label="Есть клип"><use href="#i-film"/></svg>` : ''}${esc(t.artist)}</span></span></button>
    <button class="row-b" data-a="like" aria-pressed="${liked}" aria-label="${liked ? 'Убрать из «Мне нравится»' : 'Нравится'}">${icon(liked ? 'heart-f' : 'heart')}</button>
    <span class="row-d tm">${tmh((t.duration || 0) / 1000)}</span>
    <button class="row-b" data-a="more" aria-haspopup="menu" aria-label="Действия с треком">${icon('more')}</button></li>`
}
function renderQueue() {
  $('#q-source').textContent = S.source || 'Пусто'
  const min = Math.round(S.queue.reduce((a, t) => a + (t.duration || 0), 0) / 60000)
  $('#q-meta').textContent = S.queue.length ? `${S.queue.length} ${plural(S.queue.length, 'трек', 'трека', 'треков')} · ${min} мин` : ''
  const el = $('#q-rows')
  if (!S.queue.length) {
    el.innerHTML = '<li class="empty">Очередь пуста. Запустите Мою волну, выберите плейлист слева или найдите трек.</li>'
    return
  }
  el.innerHTML = S.queue.map((t, i) => rowHtml(t, i, 'q')).join('')
  el.children[S.cur]?.scrollIntoView({ block: 'nearest' })
}
function markCurrent(prevIdx) {
  const rows = $('#q-rows').children
  const set = (i, on) => {
    const row = rows[i]
    if (!row || row.dataset.kind !== 'q') return
    row.classList.toggle('cur', on)
    $('.row-n', row).innerHTML = on ? '<span class="eqbars"><i></i><i></i><i></i></span>' : String(i + 1)
  }
  if (prevIdx >= 0) set(prevIdx, false)
  set(S.cur, true)
  rows[S.cur]?.scrollIntoView({ block: 'nearest' })
}

function listFor(kind) {
  if (kind === 'q') return S.queue
  if (kind === 's') return S.search.results
  if (kind === 'ar') return S.artist ? S.artist.popular : []
  if (kind === 'h') return S.played
  return []
}
function bindRows(container) {
  container.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-a]')
    const row = e.target.closest('.row')
    if (!b || !row) return
    const kind = row.dataset.kind, i = +row.dataset.i
    const list = listFor(kind)
    const t = list[i]
    if (!t) return
    if (b.dataset.a === 'play') {
      if (kind === 'q') playAt(i)
      else if (kind === 's') playFromSearch(t)
      else if (kind === 'h') playFromList(list.slice(), i, 'Играло в YandexAmp')
      else playFromList(list, i, `Исполнитель: ${S.artist.name}`)
    } else if (b.dataset.a === 'like') toggleLike(t)
    else if (b.dataset.a === 'more') openMenu(t, kind, i, b.getBoundingClientRect())
  })
  container.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.row')
    if (!row) return
    e.preventDefault()
    const t = listFor(row.dataset.kind)[+row.dataset.i]
    if (t) openMenu(t, row.dataset.kind, +row.dataset.i, { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY })
  })
}

// drag & drop reorder in the queue
let dragFrom = -1
function bindDrag() {
  const el = $('#q-rows')
  el.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.row')
    if (!row) return
    dragFrom = +row.dataset.i
    e.dataTransfer.effectAllowed = 'move'
  })
  el.addEventListener('dragover', (e) => {
    const row = e.target.closest('.row')
    if (!row || dragFrom < 0) return
    e.preventDefault()
    $$('.row.drag-over', el).forEach((r) => r.classList.remove('drag-over'))
    row.classList.add('drag-over')
  })
  el.addEventListener('drop', (e) => {
    const row = e.target.closest('.row')
    $$('.row.drag-over', el).forEach((r) => r.classList.remove('drag-over'))
    if (!row || dragFrom < 0) return
    e.preventDefault()
    moveTrack(dragFrom, +row.dataset.i)
    dragFrom = -1
  })
  el.addEventListener('dragend', () => {
    dragFrom = -1
    $$('.row.drag-over', el).forEach((r) => r.classList.remove('drag-over'))
  })
}

// ---------- context menu ----------
function openMenu(t, kind, i, rect) {
  const ars = artistsOf(t)
  const who = ars.length > 1 ? ars.map((a) => [`artist:${a.id}`, 'user', a.name]) : [['artist', 'user', 'Об исполнителе']]
  const items = kind === 'q'
    ? [['next', 'next-up', 'Поставить следующим'], ['radio', 'radio', 'Радио по треку'], ...who, ['del', 'trash', 'Убрать из очереди', 'danger']]
    : [['playnext', 'next-up', 'Играть следующим'], ['add', 'list', 'Добавить в очередь'], ['radio', 'radio', 'Радио по треку'], ...who]
  const menu = $('#menu')
  menu._anchor = null
  menu.innerHTML = items.map(([a, ic, l, c]) => `<button role="menuitem" data-m="${esc(a)}" class="${c || ''}">${icon(ic)}${esc(l)}</button>`).join('')
  menu.classList.remove('hidden')
  const w = menu.offsetWidth, h = menu.offsetHeight
  menu.style.left = Math.max(8, Math.min(rect.right - w, innerWidth - w - 8)) + 'px'
  menu.style.top = (rect.bottom + h + 8 > innerHeight ? rect.top - h - 4 : rect.bottom + 4) + 'px'
  menu.onclick = (e) => {
    const b = e.target.closest('button[data-m]')
    if (!b) return
    closeMenu()
    const m = b.dataset.m
    if (m === 'next') queueNext(i)
    else if (m === 'del') removeAt(i)
    else if (m === 'playnext') insertNext(t)
    else if (m === 'add') appendTrack(t)
    else if (m === 'radio') trackRadio(t)
    else if (m === 'artist') openArtist(t)
    else if (m.startsWith('artist:')) openArtist({ artistId: m.slice(7) })
  }
  $('button', menu).focus()
}
function closeMenu() {
  $('#menu').classList.add('hidden')
  $('#menu')._anchor = null
  $$('.pick[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'))
}

// ---------- side panel ----------
const VIEWS = ['queue', 'lyrics', 'stage', 'artist', 'search', 'stations', 'history']
let backTab = 'queue'
function setTab(tab, autoload = true) {
  if (tab === 'search' && !S.search.q) tab = 'queue'
  // stations / history are pop-in panels: remember where to go back to
  if ((tab === 'stations' || tab === 'history') && S.tab !== 'stations' && S.tab !== 'history') backTab = S.tab
  S.tab = tab
  for (const b of $$('#tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab))
  for (const v of VIEWS) $('#view-' + v).classList.toggle('hidden', v !== tab)
  if (tab === 'stations') { renderStations(); $('#st-filter').focus() }
  if (tab === 'history') loadHistory()
  if (tab === 'lyrics') lyricIdx = -2
  syncVideo()
  if (!autoload) return
  if (tab === 'artist' && !S.artist) openArtist()
}

// Lyrics are fetched once per track and shared by the lyrics tab, the stage,
// the line on the display and the vertical mini player
let LY = { id: null, lines: null, text: '', state: 'none' }
let lyricIdx = -2
async function fetchLyrics(t) {
  if ((t ? t.id : null) === LY.id) return
  LY = { id: t ? t.id : null, lines: null, text: '', state: t ? 'load' : 'none' }
  lyricIdx = -2
  renderLyrics()
  if (!t) return
  const r = await api.yandex.getLyrics(t.id)
  if (LY.id !== t.id) return
  if (!r.success) {
    LY.state = 'error'
    LY.error = r.error
  } else {
    LY.text = r.data.text || ''
    const lines = r.data.synced ? parseLrc(LY.text) : []
    LY.lines = lines.some((l) => l.text) ? lines : null
    LY.state = LY.text ? 'ok' : 'none'
  }
  renderLyrics()
}
function renderLyrics() {
  const t = S.queue[S.cur]
  const body = $('#ly-body')
  $('#ly-title').textContent = t ? t.title : '—'
  body.classList.toggle('synced', !!LY.lines)
  $('#ly-sync').classList.toggle('hidden', !LY.lines)
  if (!t) body.innerHTML = '<p class="empty">Включите трек — текст появится здесь</p>'
  else if (LY.state === 'load') body.innerHTML = '<p class="muted">Загружаем текст…</p>'
  else if (LY.state === 'error') body.innerHTML = `<p class="empty">${esc(LY.error)}</p>`
  else if (!LY.text) body.innerHTML = '<p class="empty">Для этого трека текста нет</p>'
  else if (LY.lines) body.innerHTML = LY.lines.map((l) => (l.text ? `<p>${esc(l.text)}</p>` : '<p class="gap"></p>')).join('')
  else body.innerHTML = LY.text.split(/\r?\n/).map((l) => (l.trim() ? `<p>${esc(l)}</p>` : '<p class="gap"></p>')).join('')
  for (const el of $$('.stage-lyrics, #viz-lyric, #m-line')) el._idx = -2
}
function parseLrc(s) {
  const out = []
  for (const line of s.split(/\r?\n/)) {
    const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/)
    if (m) out.push({ t: +m[1] * 60 + +m[2], text: m[3].trim() })
  }
  return out.sort((a, b) => a.t - b.t)
}
// Where we are in the synced lyrics: line index and how far into it (0…1)
function lyricNow() {
  if (!LY.lines) return null
  const now = (audio.currentTime || 0) + 0.2
  const L = LY.lines
  let idx = -1
  for (let i = 0; i < L.length; i++) {
    if (L[i].t <= now) idx = i
    else break
  }
  const t0 = idx >= 0 ? L[idx].t : 0, t1 = L[idx + 1] ? L[idx + 1].t : t0 + 6
  // a line is "sung" over most of its slot, not all of it — reads more naturally
  const p = idx < 0 ? 0 : Math.min(1, (now - t0) / Math.max(0.5, (t1 - t0) * 0.85))
  return { idx, p }
}
function paintLyrics(K) {
  if (!K || S.tab !== 'lyrics') return
  if (K.idx === lyricIdx) return
  lyricIdx = K.idx
  const ps = $('#ly-body').children
  for (let i = 0; i < ps.length; i++) ps[i].className = !LY.lines[i]?.text ? 'gap' : i === K.idx ? 'now' : i < K.idx ? 'past' : ''
  ps[K.idx]?.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' })
}
const lineText = (i) => (LY.lines && LY.lines[i] ? LY.lines[i].text || '♪' : '')
// Karaoke block of a stage: previous line, the current one filling up, the next one
function paintKaraoke(el, K) {
  const stage = el.parentElement
  stage.classList.toggle('has-lyrics', !!K)
  if (!K) return
  const now = $('.l-now', el)
  if (el._idx !== K.idx) {
    el._idx = K.idx
    $('.l-prev', el).textContent = K.idx > 0 ? lineText(K.idx - 1) : ''
    $('span', now).textContent = K.idx >= 0 ? lineText(K.idx) : '♪'
    $('.l-next', el).textContent = lineText(K.idx + 1)
    now.classList.remove('rise')
    void now.offsetWidth
    now.classList.add('rise')
  }
  $('span', now).style.setProperty('--p', K.p.toFixed(3))
}
// Strip mini: the artist line gives way to the line being sung
function paintMiniLine(K) {
  const el = $('#m-line')
  const on = !!K && K.idx >= 0 && !!LY.lines[K.idx]?.text
  el.classList.toggle('hidden', !on)
  $('#m-artist').classList.toggle('hidden', on)
  if (!on) return
  if (el._idx !== K.idx) { el._idx = K.idx; $('span', el).textContent = LY.lines[K.idx].text }
  $('span', el).style.setProperty('--p', K.p.toFixed(3))
}
function paintVizLyric(K) {
  const el = $('#viz-lyric')
  const on = !!K && S.cfg.lyricLine && K.idx >= 0 && !!LY.lines[K.idx]?.text
  el.classList.toggle('hidden', !on)
  if (!on) return
  if (el._idx !== K.idx) {
    el._idx = K.idx
    $('span', el).textContent = LY.lines[K.idx].text
  }
  $('span', el).style.setProperty('--p', K.p.toFixed(3))
}

// ---------- stage (clip / cover + visualizer) ----------
function stageTrack(t) {
  const art = t && t.coverUri ? cover(t.coverUri, 400) : ''
  const vid = t && S.cfg.video && t.video ? t.video : ''
  for (const st of $$('.stage')) {
    const bg = $('.stage-bg', st), im = $('.stage-art', st), v = $('.stage-video', st)
    if (bg.dataset.src !== art) {
      bg.dataset.src = art
      for (const img of [bg, im]) art ? (img.src = art) : img.removeAttribute('src')
    }
    st.classList.toggle('has-art', !!art)
    if (v.dataset.src !== vid) {
      v.dataset.src = vid
      st.classList.remove('has-video')
      if (vid) {
        v.src = vid
        v.onloadeddata = () => { if (v.dataset.src === vid) { st.classList.add('has-video'); syncVideo() } }
        v.onerror = () => st.classList.remove('has-video')
      } else {
        v.removeAttribute('src')
        v.load()
      }
    }
  }
  const clip = $('#led-clip')
  clip.disabled = !vid
  // Clips exist for only some tracks — say so, so an empty stage isn't mistaken for a bug
  $('#stage-kind').textContent = !t ? 'Сцена' : vid ? 'Клип' : !S.cfg.video ? 'Сцена · клипы выключены' : t.video === undefined ? 'Сцена' : 'Сцена · у трека нет клипа'
  $('#stage-title').textContent = t ? `${t.title} — ${t.artist}` : '—'
  syncVideo()
}
// Only a visible clip plays, and only while the music does
function syncVideo() {
  const playing = playState === 'play'
  for (const st of $$('.stage')) {
    const v = $('.stage-video', st)
    if (!v.getAttribute('src')) continue
    if (playing && st.offsetParent) v.play().catch(() => {})
    else v.pause()
  }
}
function paintStage(st, K) {
  if (!st.offsetParent) return
  if (!st.classList.contains('has-video')) {
    let ring = null
    if (S.viz === ORBIT && st.classList.contains('has-art')) {
      const art = $('.stage-art', st), dpr = window.devicePixelRatio || 1
      ring = { x: art.offsetLeft * dpr, y: art.offsetTop * dpr, r: art.offsetWidth * 0.74 * dpr }
    }
    drawViz($('.stage-canvas', st), S.viz, { stage: true, ring })
  }
  paintKaraoke($('.stage-lyrics', st), K)
}


async function openArtist(t) {
  if (S.mini) await setMini(false)
  ensurePanel()
  t = t || S.queue[S.cur]
  const body = $('#ar-body')
  setTab('artist', false)
  if (!t) { body.innerHTML = '<p class="empty">Включите трек — здесь появится исполнитель</p>'; return }
  if (!t.artistId) { body.innerHTML = '<p class="empty">Для этого трека нет данных об исполнителе</p>'; return }
  body.innerHTML = '<p class="muted">Загружаем…</p>'
  const r = await api.yandex.getArtist(t.artistId)
  if (!r.success) { body.innerHTML = `<p class="empty">${esc(r.error)}</p>`; return }
  const a = r.data
  S.artist = a
  body.innerHTML = `
    <div class="ar-head"><div class="ar-ava">${a.cover ? `<img alt="" src="${esc(cover(a.cover, 200))}">` : esc(initials(a.name))}</div>
      <div><span class="eyebrow">Исполнитель</span><h2 class="ar-name">${esc(a.name)}</h2></div></div>
    <div class="ar-btns"><button class="key hot" data-ar="play">${icon('play')}Слушать</button><button class="key" data-ar="radio">${icon('radio')}Радио</button></div>
    ${a.popular.length ? `<section class="ar-sec"><h3>Популярное</h3><ol class="rows">${a.popular.slice(0, 10).map((p, i) => rowHtml(p, i, 'ar')).join('')}</ol></section>` : ''}
    ${a.albums.length ? `<section class="ar-sec"><h3>Альбомы</h3><div class="albums">${a.albums.slice(0, 24).map((al) =>
      `<button class="album" data-album="${esc(al.id)}" data-title="${esc(al.title)}">${al.coverUri ? `<img alt="" loading="lazy" src="${esc(cover(al.coverUri, 200))}">` : '<i class="ph"></i>'}<span>${esc(al.title)}</span><small>${esc(al.year || '')}</small></button>`).join('')}</div></section>` : ''}`
}

async function runSearch(q) {
  S.search = { q, results: [] }
  $('#tab-search').classList.remove('hidden')
  setTab('search', false)
  $('#s-title').textContent = q
  $('#s-rows').innerHTML = '<li class="empty">Ищем…</li>'
  const r = await api.yandex.search(q)
  if (S.search.q !== q) return
  if (!r.success) { $('#s-rows').innerHTML = `<li class="empty">${esc(r.error)}</li>`; return }
  S.search.results = r.data
  $('#s-rows').innerHTML = r.data.length
    ? r.data.map((t, i) => rowHtml(t, i, 's')).join('')
    : '<li class="empty">Ничего не нашлось — попробуйте иначе</li>'
}

// ---------- transport, volume, balance ----------
function renderTransport() {
  $('#btn-shuffle').setAttribute('aria-pressed', String(S.shuffle))
  $('#btn-repeat').setAttribute('aria-pressed', String(S.repeat))
  $('#btn-pin').setAttribute('aria-pressed', String(S.pin))
}
function buildKnob(wrap, size) {
  const c = size / 2, r = size / 2 - 4, dot = size > 70 ? 4 : 3, n = size > 70 ? 25 : 19
  let html = ''
  for (let i = 0; i < n; i++) {
    const a = (-135 + (i * 270) / (n - 1)) * Math.PI / 180
    html += `<i style="left:${(c + r * Math.sin(a) - dot / 2).toFixed(1)}px;top:${(c - r * Math.cos(a) - dot / 2).toFixed(1)}px"></i>`
  }
  $('.knob-dots', wrap).innerHTML = html
}
function renderVol() {
  $('#vol-val').textContent = S.vol
  for (const w of $$('.knob-wrap')) {
    $('input', w).value = S.vol
    $('.knob-rot', w).style.transform = `rotate(${-135 + (S.vol / 100) * 270}deg)`
    const dots = $$('.knob-dots i', w)
    dots.forEach((d, i) => d.classList.toggle('on', i / (dots.length - 1) <= S.vol / 100 + 0.001))
  }
}
function setVol(v) {
  S.vol = Math.max(0, Math.min(100, Math.round(v)))
  store.set('vol', S.vol)
  applyVol()
  renderVol()
}
function renderBal() {
  $('#bal').value = S.bal
  $('#bal-val').textContent = S.bal === 0 ? 'C' : (S.bal < 0 ? 'L' : 'R') + Math.abs(S.bal)
  $('#bal-cap').style.left = ((S.bal + 50) / 100) * 90 + 'px'
}

// ---------- equalizer ----------
function buildFaders() {
  const f = (i, label, aria) => `<div class="fader ctl" data-i="${i}"><span class="rd"></span><div class="fbody"><i class="fticks"></i><i class="fslot"></i><i class="ffill"></i><i class="fcap cap"></i>
    <input class="hit" type="range" min="-12" max="12" step="0.5" aria-label="${aria}"></div><span class="fl">${label}</span></div>`
  $('#faders').innerHTML = f(0, 'PRE', 'Предусиление') + '<i class="fsep"></i>' + BANDS.map((b, i) => f(i + 1, b.l, b.ru)).join('')
  for (const el of $$('#faders .fader')) {
    const i = +el.dataset.i
    const inp = $('input', el)
    inp.addEventListener('input', () => setBand(i, parseFloat(inp.value)))
    el.addEventListener('dblclick', () => setBand(i, 0))
  }
}
function paintFaders() {
  $('#faders').classList.toggle('off', !S.eqOn)
  for (const el of $$('#faders .fader')) {
    const i = +el.dataset.i, v = S.eq[i]
    const top = 4 + (1 - (v + 12) / 24) * 64, cc = top + 6, z = 42
    $('.fcap', el).style.top = top + 'px'
    const fill = $('.ffill', el)
    fill.style.top = Math.min(cc, z) + 'px'
    fill.style.height = Math.abs(cc - z) + 'px'
    const rd = $('.rd', el)
    rd.textContent = v === 0 ? '0' : (v > 0 ? '+' : '-') + Math.abs(v)
    rd.classList.toggle('set', v !== 0)
    const inp = $('input', el)
    if (document.activeElement !== inp) inp.value = v
    inp.setAttribute('aria-valuetext', `${v > 0 ? '+' : ''}${v} дБ`)
  }
  const tg = $('#eq-toggle')
  tg.setAttribute('aria-pressed', String(S.eqOn))
  tg.setAttribute('aria-label', S.eqOn ? 'Эквалайзер включён' : 'Эквалайзер выключен')
  $('span', tg).textContent = S.eqOn ? 'ON' : 'OFF'
  $('#led-eq').classList.toggle('on', S.eqOn)
}
function setBand(i, v) {
  S.eq[i] = v
  if (i > 0) S.preset = 'custom'
  saveEq()
  applyEq()
  paintFaders()
  renderPresets()
}
function saveEq() {
  store.set('eq', S.eq)
  store.set('preset', S.preset)
  store.set('eqOn', S.eqOn)
}
function renderPresets() {
  const items = Object.entries(PRESETS).map(([k, p]) => [k, p.label])
  if (S.preset === 'custom') items.push(['custom', 'Своё'])
  $('#eq-presets').innerHTML = items.map(([k, l]) => `<button data-preset="${k}" aria-pressed="${S.preset === k}">${l}</button>`).join('')
}

// ---------- visualizers ----------
const LV = new Float32Array(64)
const RIDGE = [] // recent spectra for the "pulsar" ridgelines
const VS = new WeakMap() // per-canvas visualizer state (peaks, history…)
const vstate = (cv) => { let st = VS.get(cv); if (!st) VS.set(cv, (st = {})); return st }
let eqDirty = true, eqCurve = null, eqNodes = null, eqW = 0
let meterPeak = [0, 0]

function fit(c) {
  if (!c || !c.clientWidth) return null
  const d = window.devicePixelRatio || 1
  const w = Math.round(c.clientWidth * d), h = Math.round(c.clientHeight * d)
  if (!w || !h) return null
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h }
  return { c: c.getContext('2d'), w, h, d }
}
let ridgeTick = 0
function updateLevels() {
  if (++ridgeTick % 3 === 0) {
    RIDGE.push(Float32Array.from(LV))
    if (RIDGE.length > 26) RIDGE.shift()
  }
  if (!N) { for (let i = 0; i < 64; i++) LV[i] *= 0.9; return }
  N.an.getByteFrequencyData(N.freq)
  const nyq = AC.sampleRate / 2, bins = N.freq.length
  for (let i = 0; i < 64; i++) {
    const f0 = 35 * Math.pow(16000 / 35, i / 64), f1 = 35 * Math.pow(16000 / 35, (i + 1) / 64)
    const a = Math.floor((f0 / nyq) * bins), b = Math.max(a + 1, Math.ceil((f1 / nyq) * bins))
    let m = 0
    for (let k = a; k < b && k < bins; k++) if (N.freq[k] > m) m = N.freq[k]
    const v = m / 255
    LV[i] += (v - LV[i]) * (v > LV[i] ? 0.6 : 0.18)
  }
}
function lvAt(f) {
  const x = Math.max(0, Math.min(1, f)) * 63, i = Math.floor(x), fr = x - i
  return LV[i] * (1 - fr) + LV[Math.min(63, i + 1)] * fr
}
function lvAtFreq(hz) { return lvAt(Math.log(Math.max(35, hz) / 35) / Math.log(16000 / 35)) }
function col(x) { return x > 0.78 ? C.v3 : x > 0.5 ? C.v2 : C.v1 }

// time-domain samples, triggered on a rising zero crossing so the trace stands still
function wavePoints(M) {
  const out = new Float32Array(M + 1)
  if (!N) return out
  N.an.getByteTimeDomainData(N.time)
  const buf = N.time, L = buf.length
  let start = 0
  for (let i = 1; i < L / 2; i++) if (buf[i - 1] < 128 && buf[i] >= 128) { start = i; break }
  const span = Math.min(1024, L - start)
  for (let i = 0; i <= M; i++) out[i] = (buf[start + Math.floor((i / M) * (span - 1))] - 128) / 128
  return out
}
function trace(c, pts, w, h, gain, mirror = false) {
  c.beginPath()
  const M = pts.length - 1
  for (let i = 0; i <= M; i++) {
    const y = h / 2 + (mirror ? 1 : -1) * pts[i] * h * gain
    i ? c.lineTo((i / M) * w, y) : c.moveTo(0, y)
  }
  c.stroke()
}

// Colour ramp for the spectrogram, rebuilt when the finish changes
let palKey = '', pal = null
function palette() {
  const key = C.scr + C.v1 + C.v2 + C.v3 + C.scrInk
  if (key === palKey) return pal
  const cv = document.createElement('canvas')
  cv.width = 256
  cv.height = 1
  const x = cv.getContext('2d')
  const gr = x.createLinearGradient(0, 0, 256, 0)
  gr.addColorStop(0, C.scr); gr.addColorStop(0.3, C.v1); gr.addColorStop(0.62, C.v2); gr.addColorStop(0.86, C.v3); gr.addColorStop(1, '#ffffff')
  x.fillStyle = gr
  x.fillRect(0, 0, 256, 1)
  pal = x.getImageData(0, 0, 256, 1).data
  palKey = key
  return pal
}
function rowAt(row, f) {
  const x = Math.max(0, Math.min(1, f)) * 63, i = Math.floor(x), fr = x - i
  return row[i] * (1 - fr) + row[Math.min(63, i + 1)] * fr
}
function smooth(c, pts) {
  c.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]
    c.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2)
  }
  const [xl, yl] = pts[pts.length - 1]
  c.lineTo(xl, yl)
}

const DRAW = [
  // OSC — oscilloscope on a dotted graticule
  (c, w, h, d) => {
    c.fillStyle = hexA(C.scrDim, 0.28)
    for (let gx = 1; gx < 10; gx++) { const x = Math.round((gx * w) / 10); for (let y = 0; y < h; y += 4 * d) c.fillRect(x, y, d, d) }
    for (let x = 0; x < w; x += 4 * d) c.fillRect(x, Math.round(h / 2), d, d)
    c.lineWidth = 2 * d
    c.strokeStyle = C.trace
    c.shadowColor = C.trace
    c.shadowBlur = 12 * d
    trace(c, wavePoints(300), w, h, 0.45)
  },
  // SPEC — dot-matrix spectrum with falling peaks
  (c, w, h, d, st) => {
    const step = 6 * d, r = 2.1 * d
    const cols = Math.floor(w / step), rows = Math.max(4, Math.floor((h - 6 * d) / step))
    if (!st.pk || st.pk.length !== cols) st.pk = new Float32Array(cols)
    const off = (w - cols * step) / 2 + step / 2
    const P = { dim: new Path2D(), a: new Path2D(), b: new Path2D(), c: new Path2D(), pk: new Path2D() }
    for (let k = 0; k < cols; k++) {
      const lit = lvAt(k / (cols - 1)) * rows
      st.pk[k] = Math.max(lit, st.pk[k] - 0.16)
      const x = off + k * step
      for (let ro = 0; ro < rows; ro++) {
        const y = h - (ro + 0.5) * step - 3 * d, fr = ro / rows
        const p = ro < lit ? (fr > 0.78 ? P.c : fr > 0.5 ? P.b : P.a) : P.dim
        p.moveTo(x + r, y); p.arc(x, y, r, 0, 6.2832)
      }
      const pr = Math.floor(st.pk[k])
      if (pr > 0 && pr < rows) { const y = h - (pr + 0.5) * step - 3 * d; P.pk.moveTo(x + r, y); P.pk.arc(x, y, r, 0, 6.2832) }
    }
    c.fillStyle = hexA(C.scrDim, 0.13); c.fill(P.dim)
    c.fillStyle = C.v1; c.fill(P.a)
    c.fillStyle = C.v2; c.fill(P.b)
    c.fillStyle = C.v3; c.fill(P.c)
    c.fillStyle = C.scrInk; c.fill(P.pk)
  },
  // LED — segmented bar matrix
  (c, w, h, d, st) => {
    const compact = h < 60 * d
    const cols = compact ? 28 : 40, rows = compact ? 6 : Math.max(8, Math.min(16, Math.round(h / (9 * d)))), gap = (compact ? 2 : 3) * d
    const cw = (w - 16 * d) / cols, ch = (h - 12 * d) / rows
    if (!st.pk || st.pk.length !== cols) st.pk = new Float32Array(cols)
    const P = { dim: new Path2D(), a: new Path2D(), b: new Path2D(), c: new Path2D(), pk: new Path2D() }
    const rr = (p, x, y) => (p.roundRect ? p.roundRect(x, y, cw - gap, ch - gap, 1.5 * d) : p.rect(x, y, cw - gap, ch - gap))
    for (let k = 0; k < cols; k++) {
      const lit = lvAt(k / (cols - 1)) * rows
      st.pk[k] = Math.max(lit, st.pk[k] - 0.12)
      const x = 8 * d + k * cw + gap / 2
      for (let ro = 0; ro < rows; ro++) {
        const fr = ro / rows
        rr(ro < lit ? (fr > 0.75 ? P.c : fr > 0.45 ? P.b : P.a) : P.dim, x, h - 6 * d - (ro + 1) * ch + gap / 2)
      }
      const pr = Math.floor(st.pk[k])
      if (pr > 0 && pr < rows) rr(P.pk, x, h - 6 * d - (pr + 1) * ch + gap / 2)
    }
    c.fillStyle = hexA(C.scrDim, 0.12); c.fill(P.dim)
    c.fillStyle = C.v1; c.fill(P.a)
    c.fillStyle = C.v2; c.fill(P.b)
    c.fillStyle = C.v3; c.fill(P.c)
    c.fillStyle = C.scrInk; c.fill(P.pk)
  },
  // PHOS — phosphor trace with afterglow, coloured by loudness
  (c, w, h, d) => {
    const pts = wavePoints(220), SEG = 11
    c.lineWidth = 1.8 * d
    for (let s0 = 0; s0 < 220; s0 += SEG) {
      let pk = 0
      for (let i = s0; i <= Math.min(220, s0 + SEG); i++) pk = Math.max(pk, Math.abs(pts[i]))
      const seg = pts.slice(s0, Math.min(221, s0 + SEG + 1))
      const x0 = (s0 / 220) * w, sw = ((seg.length - 1) / 220) * w
      const colr = col(Math.min(1, pk * 1.6))
      c.save()
      c.translate(x0, 0)
      c.strokeStyle = colr; c.shadowColor = colr; c.shadowBlur = (6 + pk * 14) * d; c.globalAlpha = 1
      trace(c, seg, sw, h, 0.46)
      c.shadowBlur = 0; c.globalAlpha = 0.22
      trace(c, seg, sw, h, 0.46, true)
      c.restore()
    }
  },
  // AURA — three additive curtains of light riding the spectrum
  (c, w, h, d, st) => {
    const t = performance.now() / 1000, M = 40
    c.globalCompositeOperation = 'lighter'
    ;[[C.v1, 0, 1], [C.v2, 0.37, 0.82], [C.v3, 0.71, 0.62]].forEach(([k, ph, amp]) => {
      const pts = []
      for (let i = 0; i <= M; i++) {
        const u = i / M
        const v = lvAt(0.03 + ((u + ph * 0.15) % 1) * 0.78)
        const sway = 0.5 + 0.5 * Math.sin(u * 5.5 + t * (0.5 + ph) + ph * 7)
        pts.push([u * w, h - (0.06 + v * 0.78 * amp + sway * 0.1) * h])
      }
      const top = Math.min(...pts.map((p) => p[1]))
      const area = new Path2D()
      smooth(area, pts)
      area.lineTo(w, h); area.lineTo(0, h); area.closePath()
      const gr = c.createLinearGradient(0, top, 0, h)
      gr.addColorStop(0, hexA(k, 0.7)); gr.addColorStop(0.4, hexA(k, 0.22)); gr.addColorStop(1, hexA(k, 0))
      c.fillStyle = gr
      c.fill(area)
      const crest = new Path2D()
      smooth(crest, pts)
      c.strokeStyle = k; c.lineWidth = 1.4 * d; c.shadowColor = k; c.shadowBlur = 12 * d
      c.stroke(crest)
      c.shadowBlur = 0
      // curtain rays hanging from the crest
      c.globalAlpha = 0.16
      for (let i = 0; i <= M; i += 2) {
        const [x, y] = pts[i]
        const ray = c.createLinearGradient(0, y, 0, y + h * 0.5)
        ray.addColorStop(0, k); ray.addColorStop(1, hexA(k, 0))
        c.fillStyle = ray
        c.fillRect(x - d, y, 2 * d, h * 0.5)
      }
      c.globalAlpha = 1
    })
    c.globalCompositeOperation = 'source-over'
  },
  // PULSAR — stacked ridgelines of recent spectra (the famous pulsar plot)
  (c, w, h, d, st, bg) => {
    if (!RIDGE.length) return
    const L = Math.min(RIDGE.length, h < 60 * d ? 9 : h < 160 * d ? 15 : 24)
    const top = h * 0.14, gap = (h * 0.8) / L, amp = Math.max(gap * 3.2, h * 0.3)
    const x0 = w * 0.06, x1 = w * 0.94, M = Math.min(120, Math.floor((x1 - x0) / (3 * d)))
    c.lineJoin = 'round'
    for (let k = 0; k < L; k++) {
      const row = RIDGE[RIDGE.length - L + k]
      const base = top + (k + 1) * gap
      const line = new Path2D()
      line.moveTo(0, base); line.lineTo(x0, base)
      for (let i = 0; i <= M; i++) {
        const u = i / M, f = Math.abs(u - 0.5) * 2
        const env = Math.pow(Math.sin(Math.PI * u), 1.5)
        line.lineTo(x0 + u * (x1 - x0), base - rowAt(row, 0.04 + f * 0.7) * amp * env)
      }
      line.lineTo(w, base)
      const fill = new Path2D(line)
      fill.lineTo(w, h); fill.lineTo(0, h); fill.closePath()
      c.fillStyle = bg
      c.fill(fill)
      const front = k === L - 1
      c.strokeStyle = front ? C.trace : hexA(C.scrInk, 0.18 + 0.62 * (k / L))
      c.lineWidth = (front ? 1.8 : 1.2) * d
      if (front) { c.shadowColor = C.trace; c.shadowBlur = 10 * d }
      c.stroke(line)
      c.shadowBlur = 0
    }
  },
  // FALL — scrolling spectrogram, newest on top
  (c, w, h, d, st) => {
    const W = 128, H = 110
    if (!st.off) {
      st.off = document.createElement('canvas')
      st.off.width = W
      st.off.height = H
      st.ox = st.off.getContext('2d')
      st.ox.fillStyle = '#000'
      st.ox.fillRect(0, 0, W, H)
      st.row = st.ox.createImageData(W, 1)
      st.n = 0
    }
    {
      const P = palette(), px = st.row.data
      st.ox.drawImage(st.off, 0, 0, W, H - 1, 0, 1, W, H - 1)
      for (let x = 0; x < W; x++) {
        const v = Math.min(255, Math.floor(Math.pow(lvAt(x / (W - 1)), 1.35) * 255))
        px[x * 4] = P[v * 4]; px[x * 4 + 1] = P[v * 4 + 1]; px[x * 4 + 2] = P[v * 4 + 2]; px[x * 4 + 3] = 255
      }
      st.ox.putImageData(st.row, 0, 0)
    }
    c.imageSmoothingEnabled = true
    c.imageSmoothingQuality = 'high'
    c.drawImage(st.off, 0, 0, w, h)
    // the live spectrum as a bright edge on top
    c.beginPath()
    for (let x = 0; x <= w; x += 3 * d) { const y = (1 - lvAt(x / w)) * h * 0.3; x ? c.lineTo(x, y) : c.moveTo(x, y) }
    c.strokeStyle = hexA(C.scrInk, 0.55); c.lineWidth = d
    c.stroke()
  },
  // ORBIT — radial spectrum around a pulsing core (around the cover on the stage)
  (c, w, h, d, st, bg, opt) => {
    const bass = lvAt(0.05)
    let cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.24
    if (opt.ring) { cx = opt.ring.x; cy = opt.ring.y; R = opt.ring.r }
    const Rb = R * (1 + bass * 0.07)
    const maxLen = opt.ring ? Math.min(R * 0.55, Math.min(w, h) * 0.2) : Math.min(w, h) * 0.24
    st.rot = ((st.rot || 0) + 0.0015 + bass * 0.008) % 6.2832
    if (!opt.ring && w > h * 2.2) {
      // on a wide screen the waveform streams out of the ring like wings
      const pts = wavePoints(180)
      c.strokeStyle = hexA(C.trace, 0.55); c.lineWidth = 1.4 * d; c.shadowColor = C.trace; c.shadowBlur = 8 * d
      for (const side of [-1, 1]) {
        c.beginPath()
        const from = cx + side * (Rb + maxLen * 0.4), to = side < 0 ? 0 : w
        for (let i = 0; i <= 90; i++) {
          const u = i / 90, x = from + (to - from) * u
          const y = cy + pts[side < 0 ? i : 90 + i] * h * 0.42 * (1 - u) * (0.4 + u * 2.4 > 1 ? 1 : 0.4 + u * 2.4)
          i ? c.lineTo(x, y) : c.moveTo(x, y)
        }
        c.stroke()
      }
      c.shadowBlur = 0
    }
    const NB = opt.ring ? 144 : 96
    const P = [new Path2D(), new Path2D(), new Path2D()]
    for (let i = 0; i < NB; i++) {
      const a = st.rot + (i / NB) * 6.2832 - 1.5708
      const f = i < NB / 2 ? i / (NB / 2) : (NB - i) / (NB / 2)
      const v = lvAt(0.03 + f * 0.72)
      const len = 1.5 * d + v * maxLen
      const ca = Math.cos(a), sa = Math.sin(a)
      const p = P[v > 0.7 ? 2 : v > 0.42 ? 1 : 0]
      p.moveTo(cx + ca * Rb, cy + sa * Rb)
      p.lineTo(cx + ca * (Rb + len), cy + sa * (Rb + len))
    }
    c.lineCap = 'round'
    c.lineWidth = Math.max(1.4 * d, ((6.2832 * Rb) / NB) * 0.5)
    ;[C.v1, C.v2, C.v3].forEach((k, n) => { c.strokeStyle = k; c.shadowColor = k; c.shadowBlur = 9 * d; c.stroke(P[n]) })
    c.shadowBlur = 0
    c.lineCap = 'butt'
    c.beginPath()
    c.arc(cx, cy, Rb - 3 * d, 0, 6.2832)
    c.strokeStyle = hexA(C.trace, 0.7); c.lineWidth = 1.2 * d
    c.stroke()
    if (!opt.ring) {
      const core = c.createRadialGradient(cx, cy, 0, cx, cy, Rb - 5 * d)
      core.addColorStop(0, hexA(C.trace, 0.35 + bass * 0.5)); core.addColorStop(1, hexA(C.trace, 0))
      c.fillStyle = core
      c.beginPath(); c.arc(cx, cy, Rb - 5 * d, 0, 6.2832); c.fill()
    }
  },
  // PRISM — glowing gradient bars over a glassy reflection
  (c, w, h, d, st) => {
    const NB = Math.max(24, Math.min(72, Math.floor(w / (9 * d))))
    const slot = w / NB, bw = Math.max(2 * d, slot * 0.56), base = Math.round(h * 0.7)
    if (!st.pk || st.pk.length !== NB) st.pk = new Float32Array(NB)
    const grad = c.createLinearGradient(0, 0, w, 0)
    grad.addColorStop(0, C.v1); grad.addColorStop(0.5, C.v2); grad.addColorStop(1, C.v3)
    const up = new Path2D(), down = new Path2D(), caps = new Path2D()
    const rr = (p, x, y, ww, hh, r) => (p.roundRect ? p.roundRect(x, y, ww, hh, r) : p.rect(x, y, ww, hh))
    for (let i = 0; i < NB; i++) {
      const v = lvAt(0.02 + (i / (NB - 1)) * 0.86)
      const bh = Math.max(2 * d, v * base * 0.92)
      st.pk[i] = Math.max(bh, st.pk[i] - 1.2 * d)
      const x = i * slot + (slot - bw) / 2
      rr(up, x, base - bh, bw, bh, [bw / 2, bw / 2, d, d])
      rr(down, x, base + 3 * d, bw, bh * 0.4, [d, d, bw / 2, bw / 2])
      caps.rect(x, base - st.pk[i] - 4 * d, bw, 2 * d)
    }
    c.fillStyle = grad
    c.shadowColor = C.v2; c.shadowBlur = 14 * d
    c.fill(up)
    c.shadowBlur = 0
    c.globalAlpha = 0.2
    c.fill(down)
    c.globalAlpha = 0.9
    c.fillStyle = C.scrInk
    c.fill(caps)
    c.globalAlpha = 1
    c.fillStyle = hexA(C.scrInk, 0.14)
    c.fillRect(0, base + d, w, d)
  },
]

// Draws a visualizer into any canvas: the display, a mini player, the stage,
// or a gallery thumbnail. On the stage black is see-through (screen blend),
// and everything but the orbit sits in the lower band under the cover.
function drawViz(canvas, mode = S.viz, opt = {}) {
  const g = fit(canvas)
  if (!g) return
  const { c, w, d } = g
  let h = g.h
  c.save()
  c.shadowBlur = 0
  c.globalAlpha = 1
  const bg = opt.stage ? '#000' : C.scr
  c.fillStyle = mode === 3 ? (opt.stage ? 'rgba(0,0,0,.25)' : hexA(C.scr, 0.22)) : bg
  c.fillRect(0, 0, w, h)
  if (opt.stage && mode !== ORBIT) {
    const y0 = Math.round(h - Math.min(h * 0.44, w * 0.36))
    c.translate(0, y0)
    h -= y0
  }
  DRAW[mode](c, w, h, d, vstate(canvas), bg, opt)
  c.restore()
}

// EQ graph: x axis is warped so each band sits right above its fader
function warpFreq(x) {
  const p = Math.max(-0.5, Math.min(9.5, x * 10 - 0.5))
  const i = Math.max(0, Math.min(8, Math.floor(p))), t = p - i
  return Math.exp(Math.log(EQF[i]) + t * (Math.log(EQF[i + 1]) - Math.log(EQF[i])))
}
function response(freqs) {
  const out = new Float32Array(freqs.length).fill(S.eqOn ? S.eq[0] : 0)
  if (!N || !S.eqOn) return out
  const mag = new Float32Array(freqs.length), ph = new Float32Array(freqs.length)
  for (const f of N.filters) {
    f.getFrequencyResponse(freqs, mag, ph)
    for (let i = 0; i < freqs.length; i++) out[i] += 20 * Math.log10(Math.max(1e-4, mag[i]))
  }
  return out
}
function drawEq() {
  const g = fit($('#eq-canvas'))
  if (!g) return
  const { c, w, h, d } = g
  c.shadowBlur = 0
  c.setLineDash([])
  c.fillStyle = C.scr
  c.fillRect(0, 0, w, h)
  const span = h / 2 - 8 * d
  const yOf = (db) => h / 2 - (Math.max(-12, Math.min(12, db)) / 12) * span
  c.fillStyle = hexA(C.scrDim, 0.3)
  for (const db of [12, 6, 0, -6, -12]) { const y = Math.round(yOf(db)); for (let x = 30 * d; x < w; x += 4 * d) c.fillRect(x, y, d, d) }

  const n = Math.max(40, Math.round(w / (3 * d)))
  if (eqDirty || !eqCurve || eqW !== w) {
    const fr = new Float32Array(n)
    for (let i = 0; i < n; i++) fr[i] = warpFreq(i / (n - 1))
    eqCurve = response(fr)
    eqNodes = response(new Float32Array(EQF))
    eqDirty = false
    eqW = w
  }
  // live spectrum behind the curve
  c.beginPath()
  c.moveTo(0, h)
  for (let i = 0; i < n; i++) c.lineTo((i / (n - 1)) * w, h - lvAtFreq(warpFreq(i / (n - 1))) * h * 0.85)
  c.lineTo(w, h)
  c.closePath()
  c.fillStyle = hexA(C.v1, 0.2)
  c.fill()

  const curve = new Path2D()
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * w, y = yOf(eqCurve[i]); i ? curve.lineTo(x, y) : curve.moveTo(x, y) }
  const area = new Path2D(curve)
  area.lineTo(w, h / 2)
  area.lineTo(0, h / 2)
  area.closePath()
  c.fillStyle = hexA(C.trace, S.eqOn ? 0.14 : 0.05)
  c.fill(area)
  c.lineWidth = 2 * d
  if (S.eqOn) { c.strokeStyle = C.trace; c.shadowColor = C.trace; c.shadowBlur = 10 * d }
  else { c.strokeStyle = C.scrDim; c.setLineDash([4 * d, 4 * d]) }
  c.stroke(curve)
  c.shadowBlur = 0
  c.setLineDash([])
  for (let i = 0; i < 10; i++) {
    c.beginPath()
    c.arc(((i + 0.5) / 10) * w, yOf(eqNodes[i]), 3.5 * d, 0, 6.2832)
    c.fillStyle = C.scr
    c.fill()
    c.lineWidth = 1.6 * d
    c.strokeStyle = S.eqOn ? C.trace : C.scrDim
    c.stroke()
  }
}
function drawMeter() {
  const g = fit($('#meter-canvas'))
  if (!g) return
  const { c, w, h, d } = g
  c.fillStyle = C.scr
  c.fillRect(0, 0, w, h)
  const segs = 14, sh = (h - 10 * d) / segs, bw = 12 * d
  const lv = [0, 0]
  if (N) {
    N.aL.getFloatTimeDomainData(N.tL)
    N.aR.getFloatTimeDomainData(N.tR)
    ;[N.tL, N.tR].forEach((buf, ch) => {
      let s = 0
      for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]
      const db = 20 * Math.log10(Math.sqrt(s / buf.length) + 1e-6)
      lv[ch] = Math.max(0, Math.min(1, (db + 48) / 48))
    })
  }
  lv.forEach((v, ch) => {
    meterPeak[ch] = Math.max(v, meterPeak[ch] - 0.012)
    const x = w / 2 + (ch ? 3 * d : -3 * d - bw)
    for (let s = 0; s < segs; s++) {
      const y = h - 5 * d - (s + 1) * sh, fr = s / segs
      c.fillStyle = s < v * segs ? col(fr > 0.8 ? 0.9 : fr > 0.55 ? 0.6 : 0.2) : hexA(C.scrDim, 0.14)
      c.fillRect(x, y + d, bw, sh - 2 * d)
    }
    const ps = Math.floor(meterPeak[ch] * segs)
    if (ps > 0) { c.fillStyle = C.scrInk; c.fillRect(x, h - 5 * d - ps * sh + d, bw, 2 * d) }
  })
}
function overall() {
  let s = 0
  for (let i = 0; i < 40; i++) s += LV[i]
  return s / 40
}
function flowLines(canvas, t, speed, amp, idle) {
  const g = fit(canvas)
  if (!g) return
  const { c, w, h, d } = g
  c.clearRect(0, 0, w, h)
  ;[C.v1, C.v2, C.v3].forEach((k, n) => {
    c.strokeStyle = k
    c.globalAlpha = 0.9
    c.lineWidth = 2 * d
    c.shadowColor = k
    c.shadowBlur = 6 * d
    c.beginPath()
    for (let x = 0; x <= w; x += 2 * d) {
      const u = x / w
      const y = h / 2 + Math.sin(u * (7 + n * 2.5) + t * speed * (1.2 + n * 0.35) + n * 1.7) *
        (idle + amp) * h * 0.3 * (0.55 + 0.45 * Math.sin(t * 0.7 + n + u * 3))
      x ? c.lineTo(x, y) : c.moveTo(x, y)
    }
    c.stroke()
  })
  c.globalAlpha = 1
  c.shadowBlur = 0
}
let frameN = 0
function loop(now) {
  requestAnimationFrame(loop)
  frameN++
  if (document.hidden || (reduced && frameN % 12)) return
  const t = now / 1000
  updateLevels()
  if (!$('#login').classList.contains('hidden')) {
    flowLines($('#login-wave'), t, 0.8, 0, 0.55)
    return
  }
  const K = lyricNow()
  if (S.mini) {
    const KM = S.cfg.miniLyrics ? K : null
    if (S.cfg.mini === 'v') paintStage($('#stage-mini'), KM)
    else { drawViz($('#m-canvas')); paintMiniLine(KM) }
    tickTime()
    return
  }
  if ($('#player').classList.contains('hidden')) return
  drawViz($('#viz-canvas'))
  paintVizLyric(K)
  if (galleryOpen) $$('#gal-grid canvas').forEach((cv, i) => drawViz(cv, i))
  if (S.cfg.eq) { drawEq(); drawMeter() }
  if (S.cfg.side) {
    const speed = { all: 1, active: 1.7, fun: 1.3, calm: 0.55, sad: 0.4 }[S.mood] || 1
    flowLines($('#wave-canvas'), t, speed, overall() * 0.9, 0.25)
  }
  if (S.cfg.panel && S.tab === 'stage') paintStage($('#stage-main'), K)
  tickTime()
  paintLyrics(K)
}

function renderViz() {
  const v = VIZ[S.viz]
  $('#viz-pick b').textContent = v.k
  $('#viz-pick > span').textContent = v.ru
  $('#viz-pick').setAttribute('aria-label', `Визуализатор: ${v.ru}. Выбрать другой`)
  $('#viz-hit').setAttribute('aria-label', `Визуализатор «${v.ru}» — нажмите, чтобы сменить`)
  for (const b of $$('#gal-grid [data-viz]')) b.setAttribute('aria-checked', String(+b.dataset.viz === S.viz))
}
function setViz(i) {
  S.viz = (i + VIZ.length) % VIZ.length
  store.set('viz', S.viz)
  renderViz()
}
// Gallery: every visualizer as a live thumbnail
let galleryOpen = false
function openGallery() {
  const g = $('#viz-gallery'), b = $('#viz-pick')
  $('#gal-grid').innerHTML = VIZ.map((v, i) =>
    `<button class="viz-card" role="radio" data-viz="${i}" aria-checked="${S.viz === i}"><canvas aria-hidden="true"></canvas><span><b>${v.k}</b>${v.ru}</span></button>`).join('')
  g.classList.remove('hidden')
  galleryOpen = true
  b.setAttribute('aria-expanded', 'true')
  const r = b.getBoundingClientRect()
  g.style.left = Math.max(8, Math.min(r.right - g.offsetWidth, innerWidth - g.offsetWidth - 8)) + 'px'
  g.style.top = Math.max(8, Math.min(r.bottom + 6, innerHeight - g.offsetHeight - 8)) + 'px'
  $('[aria-checked="true"]', g)?.focus()
}
function closeGallery() {
  if (!galleryOpen) return
  galleryOpen = false
  $('#viz-gallery').classList.add('hidden')
  $('#viz-pick').setAttribute('aria-expanded', 'false')
}

// ---------- mini mode ----------
async function setMini(on) {
  S.mini = on
  closeMenu()
  closeGallery()
  closeSettings()
  const mode = on ? (S.cfg.mini === 'v' ? 'mini-v' : 'mini') : 'player'
  show(mode)
  await layout(mode)
  api.window.setPin(on ? S.cfg.miniPin || S.pin : S.pin)
  if (!on) requestAnimationFrame(buildSeekBars)
  syncVideo()
}

// ---------- system integration ----------
function mediaMeta(t) {
  if (!('mediaSession' in navigator)) return
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album || 'Яндекс Музыка',
      artwork: t.coverUri ? [{ src: cover(t.coverUri, 400), sizes: '400x400', type: 'image/jpeg' }] : [],
    })
  } catch {}
}
function initMediaKeys() {
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession
    ms.setActionHandler('play', togglePlay)
    ms.setActionHandler('pause', togglePlay)
    ms.setActionHandler('previoustrack', prev)
    ms.setActionHandler('nexttrack', skip)
    try { ms.setActionHandler('seekto', (e) => { audio.currentTime = e.seekTime }) } catch {}
  }
  api.media.onCmd((cmd) => {
    if (cmd === 'playpause') togglePlay()
    else if (cmd === 'next') skip()
    else if (cmd === 'prev') prev()
  })
}
async function checkUpdate() {
  const r = await api.app.checkUpdate()
  if (!r || !r.newer) return
  const b = $('#btn-update')
  b.classList.remove('hidden')
  b.title = `Доступна версия ${r.latest} — открыть страницу загрузки`
  b.onclick = () => api.app.openReleases(r.url)
}
let logoutArmed = null
async function logout() {
  const b = $('#btn-logout')
  if (!logoutArmed) {
    b.classList.add('armed')
    toast('Нажмите ещё раз, чтобы выйти и удалить сохранённый вход')
    logoutArmed = setTimeout(() => { logoutArmed = null; b.classList.remove('armed') }, 3000)
    return
  }
  clearTimeout(logoutArmed)
  logoutArmed = null
  b.classList.remove('armed')
  audio.pause()
  audio.removeAttribute('src')
  await api.yandex.logout()
  S.liked = new Set()
  S.mine = null
  S.stations = null
  toLogin('Вы вышли. Вход удалён с этого компьютера.')
}

// ---------- wiring ----------
function bind() {
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#menu, [data-a="more"], .pick, #np-artist, #mv-artist')) closeMenu()
    if (!e.target.closest('#viz-gallery, #viz-pick')) closeGallery()
    const act = e.target.closest('[data-act]')?.dataset.act
    if (act === 'tray') api.window.minimize()
    else if (act === 'quit') api.window.close()
    else if (act === 'mini') setMini(true)
    else if (act === 'full') setMini(false)
    else if (act === 'play') togglePlay()
    else if (act === 'prev') prev()
    else if (act === 'next') skip()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeMenu(); closeGallery(); closeSettings() }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !S.mini && !$('#player').classList.contains('hidden')) {
      e.preventDefault()
      $('#search').focus()
      $('#search').select()
    }
    const typing = e.target.matches('input:not([type=range]), select, textarea, button, summary')
    if (e.code === 'Space' && !typing && $('#login').classList.contains('hidden')) {
      e.preventDefault()
      togglePlay()
    }
  })
  window.addEventListener('blur', closeMenu)
  // Sliders keep keyboard focus, but a mouse drag shouldn't leave a focus frame behind
  document.addEventListener('pointerup', () => { const a = document.activeElement; if (a && a.classList.contains('hit')) a.blur() })

  // settings
  $('#btn-settings').addEventListener('click', openSettings)
  $('#settings').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return closeSettings()
    const f = e.target.closest('[data-f]')
    if (f) return applyFinish(f.dataset.f)
    const m = e.target.closest('[data-mini]')
    if (m) setCfg('mini', m.dataset.mini)
  })
  for (const b of $$('.ly-toggle')) b.addEventListener('click', () => setCfg('miniLyrics', !S.cfg.miniLyrics))
  $('#settings').addEventListener('change', (e) => { const k = e.target.dataset.cfg; if (k) setCfg(k, e.target.checked) })
  $('#btn-pin').addEventListener('click', () => {
    S.pin = !S.pin
    store.set('pin', S.pin)
    api.window.setPin(S.pin)
    renderTransport()
    toast(S.pin ? 'Окно поверх всех остальных' : 'Обычный режим окна')
  })
  $('#btn-logout').addEventListener('click', logout)
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault()
    const q = $('#search').value.trim()
    if (q) runSearch(q)
  })

  // sidebar
  $('#wave-start').addEventListener('click', startWave)
  $('#moods').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mood]')
    if (!b) return
    S.mood = b.dataset.mood
    store.set('mood', S.mood)
    renderSide()
  })
  $('#pick-div').addEventListener('click', (e) =>
    openPicker(e.currentTarget, DIVERSITY, S.div, (v) => { S.div = v; store.set('div', v); renderSide() }))
  $('#pick-lang').addEventListener('click', (e) =>
    openPicker(e.currentTarget, LANGS, S.lang, (v) => { S.lang = v; store.set('lang', v); renderSide() }))
  const sources = (e) => {
    if (e.target.closest('[data-retry]')) return loadLibrary()
    const p = e.target.closest('[data-panel]')
    if (p) return setTab(p.dataset.panel)
    const b = e.target.closest('[data-src]')
    if (b) openSource(b.dataset.src, b.dataset.label)
  }
  $('.side').addEventListener('click', sources)
  $('#st-body').addEventListener('click', sources)
  $('#st-filter').addEventListener('input', renderStations)
  for (const b of $$('[data-back]')) b.addEventListener('click', () => setTab(backTab))
  $('#hist-body').addEventListener('click', (e) => {
    const c = e.target.closest('[data-ctx]')
    if (c && S.historyCtx) openContext(S.historyCtx[+c.dataset.ctx])
  })

  // display & transport
  for (const b of [$('#np-artist'), $('#mv-artist')]) b.addEventListener('click', (e) => artistClick(e.currentTarget))
  for (const b of [$('#btn-like'), $('#m-like'), $('#mv-like')]) b.addEventListener('click', () => { const t = S.queue[S.cur]; if (t) toggleLike(t) })
  $('#btn-dislike').addEventListener('click', dislike)
  $('#led-clip').addEventListener('click', () => { ensurePanel(); setTab('stage') })
  $('#viz-hit').addEventListener('click', () => setViz(S.viz + 1))
  $('#viz-pick').addEventListener('click', () => (galleryOpen ? closeGallery() : openGallery()))
  $('#gal-grid').addEventListener('click', (e) => { const b = e.target.closest('[data-viz]'); if (b) { setViz(+b.dataset.viz); closeGallery() } })
  $('#btn-play').addEventListener('click', togglePlay)
  $('#btn-prev').addEventListener('click', prev)
  $('#btn-next').addEventListener('click', skip)
  $('#btn-stop').addEventListener('click', stop)
  $('#btn-shuffle').addEventListener('click', () => { S.shuffle = !S.shuffle; store.set('shuffle', S.shuffle); renderTransport() })
  $('#btn-repeat').addEventListener('click', () => { S.repeat = !S.repeat; store.set('repeat', S.repeat); renderTransport() })
  for (const seek of [$('#seek'), $('#mv-seek')]) {
    seek.addEventListener('input', (e) => { if (audio.src && isFinite(audio.duration)) audio.currentTime = parseFloat(e.target.value) })
  }
  for (const w of $$('.knob-wrap')) {
    $('input', w).addEventListener('input', (e) => setVol(+e.target.value))
    w.addEventListener('wheel', (e) => { e.preventDefault(); setVol(S.vol + (e.deltaY < 0 ? 2 : -2)) }, { passive: false })
  }
  $('#bal').addEventListener('input', (e) => {
    S.bal = Math.abs(+e.target.value) < 3 ? 0 : +e.target.value
    store.set('bal', S.bal)
    applyBal()
    renderBal()
  })
  new ResizeObserver(() => buildSeekBars()).observe($('#seek-bars'))

  // equalizer
  $('#eq-toggle').addEventListener('click', () => { S.eqOn = !S.eqOn; saveEq(); applyEq(); paintFaders() })
  $('#eq-presets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]')
    if (!b || b.dataset.preset === 'custom') return
    S.preset = b.dataset.preset
    S.eq = [S.eq[0], ...PRESETS[S.preset].g]
    saveEq()
    applyEq()
    paintFaders()
    renderPresets()
  })

  // side panel
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab) })
  bindRows($('#q-rows'))
  bindRows($('#s-rows'))
  bindRows($('#ar-body'))
  bindRows($('#hist-body'))
  bindDrag()
  $('#ar-body').addEventListener('click', async (e) => {
    const ar = e.target.closest('[data-ar]')
    if (ar && S.artist) {
      if (ar.dataset.ar === 'play' && S.artist.popular.length) playFromList(S.artist.popular, 0, `Исполнитель: ${S.artist.name}`)
      if (ar.dataset.ar === 'radio' && S.artist.popular.length) trackRadio(S.artist.popular[0])
      return
    }
    const al = e.target.closest('[data-album]')
    if (!al) return
    toast(`Загружаем альбом «${al.dataset.title}»`)
    const r = await api.yandex.getAlbumTracks(al.dataset.album)
    if (!r.success) return fail(r.error)
    if (!r.data.tracks.length) return toast('Альбом пуст')
    playFromList(r.data.tracks, 0, `Альбом: ${r.data.title}`)
  })
}

// ---------- boot ----------
async function boot() {
  applyFinish(S.finish)
  applyCfg()
  buildFaders()
  buildKnob($('#knob-wrap'), 88)
  buildKnob($('#m-knob'), 60)
  buildKnob($('#mv-knob'), 60)
  bind()
  initLogin()
  initMediaKeys()
  renderAll()
  requestAnimationFrame(loop)
  const r = await api.yandex.restoreSession()
  if (r.success) enterPlayer()
  else toLogin()
}
boot()
