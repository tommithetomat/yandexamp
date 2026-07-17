'use strict'

// ===== STATE =====
const state = {
  playlist: [],
  currentIndex: -1,
  isPlaying: false,
  isShuffle: false,
  isRepeat: false,
  isPlaylistVisible: true,
  isMyPlVisible: false,
  isEqVisible: false,
  volume: 0.8,
  seekDragging: false,
  audioContext: null,
  analyser: null,
  mediaSource: null,
  animFrameId: null,
  eqNodes: [],
  eqBands: [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000],
  vizMode: 'bars',      // 'bars' | 'scope' | 'star'
  userPlaylists: [],
  waveMode: false,      // "Моя волна" active — auto-extend playlist near the end
  likedIds: new Set(),  // liked track ids for the ♥ indicator
  // Canvas colors — updated by applyTheme()
  lcdBg: '#0b1a0b', lcdGreen: '#33ff66', lcdDim: '#0d3318', lcdMid: '#1aaa44',
}

// ===== THEMES =====
const THEME_CYCLE = ['classic', 'steel', 'amber', 'yandex', 'blood']
const THEME_LABELS = { classic: 'GRN', steel: 'BLU', amber: 'AMB', yandex: 'YDX', blood: 'RED' }
const THEME_COLORS = {
  classic: { lcdBg: '#0b1a0b', lcdGreen: '#33ff66', lcdDim: '#0d3318', lcdMid: '#1aaa44' },
  steel:   { lcdBg: '#001428', lcdGreen: '#55ccff', lcdDim: '#003360', lcdMid: '#1a5080' },
  amber:   { lcdBg: '#1a0d00', lcdGreen: '#ff9900', lcdDim: '#4a2200', lcdMid: '#804400' },
  yandex:  { lcdBg: '#1a1200', lcdGreen: '#ffdb4d', lcdDim: '#4a3800', lcdMid: '#806600' },
  blood:   { lcdBg: '#1a0005', lcdGreen: '#ff3355', lcdDim: '#4a0015', lcdMid: '#800020' },
}

function applyTheme(name) {
  document.body.dataset.theme = name
  const c = THEME_COLORS[name] || THEME_COLORS.classic
  state.lcdBg = c.lcdBg; state.lcdGreen = c.lcdGreen
  state.lcdDim = c.lcdDim; state.lcdMid = c.lcdMid
  localStorage.setItem('yamp-theme', name)
  const btn = $('btn-skin')
  if (btn) btn.textContent = THEME_LABELS[name] || 'SKN'
  if (state.audioContext) startSpectrumAnimation()
}

function initTheme() {
  applyTheme(localStorage.getItem('yamp-theme') || 'classic')
}

const EQ_PRESETS = {
  flat:      [0,  0,  0,  0,  0,  0,  0,  0,  0,  0],
  rock:      [4,  3,  2, -1, -2,  1,  3,  4,  5,  5],
  pop:       [-1,  2,  4,  4,  2, -1, -1, -1,  0,  0],
  classical: [4,  3,  2,  1,  0,  0,  0, -1, -2, -3],
  bass:      [6,  5,  4,  2,  0, -1, -1, -2, -2, -2],
}

// ===== DOM REFS =====
const $ = (id) => document.getElementById(id)
const audio = $('audio')

// Surface unexpected JS errors on the LCD instead of failing silently
window.addEventListener('error', (e) => {
  try { setTrackTitle('⚠ JS: ' + e.message) } catch (_) {}
})
window.addEventListener('unhandledrejection', (e) => {
  try { setTrackTitle('⚠ ' + (e.reason?.message || e.reason)) } catch (_) {}
})

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  audio.volume = state.volume
  initTheme()
  bindLoginUI()
  bindPlayerUI()
  bindPlaylistUI()
  bindSearchUI()
  bindEqUI()
  bindSeekbar()
  startSpectrumIdle()
})

// ===== LOGIN =====
function bindLoginUI() {
  // --- Primary: browser OAuth ---
  $('btn-login-browser').addEventListener('click', async () => {
    const btn = $('btn-login-browser')
    btn.disabled = true
    btn.textContent = 'Открываю браузер...'
    showLoginError('')

    const res = await window.api.yandex.loginBrowser()

    btn.disabled = false
    btn.innerHTML = '<span class="ya-icon">Я</span> Войти через Яндекс'

    if (res.success) {
      enterPlayer()
    } else {
      showLoginError(res.error || 'Вход отменён')
    }
  })

  // --- Fallback: username/password ---
  $('btn-login').addEventListener('click', async () => {
    const username = $('login-username').value.trim()
    const password = $('login-password').value.trim()
    if (!username || !password) { showLoginError('Введите логин и пароль'); return }
    setLoginLoading(true)
    const res = await window.api.yandex.login(username, password)
    setLoginLoading(false)
    if (res.success) {
      enterPlayer()
    } else {
      showLoginError('Ошибка: ' + res.error)
    }
  })

  // --- Fallback: raw token ---
  $('btn-login-token').addEventListener('click', async () => {
    const token = $('login-token').value.trim()
    if (!token) { showLoginError('Введите токен'); return }
    setLoginLoading(true)
    const res = await window.api.yandex.loginWithToken(token)
    setLoginLoading(false)
    if (res.success) {
      enterPlayer()
    } else {
      showLoginError('Ошибка: ' + res.error)
    }
  })

  ;[$('login-username'), $('login-password')].forEach(el =>
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-login').click() })
  )
  $('login-token').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-login-token').click()
  })

  // Adaptive window height — resize when <details> expand or error messages appear
  const loginScreen = $('login-screen')
  const syncLoginHeight = () => {
    if (loginScreen.classList.contains('hidden')) return
    const h = loginScreen.offsetHeight
    if (h > 0) window.api.window.setHeight(h)
  }
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(syncLoginHeight).observe(loginScreen)
  }
  loginScreen.querySelectorAll('details').forEach(d =>
    d.addEventListener('toggle', () => requestAnimationFrame(syncLoginHeight))
  )
}

function showLoginError(msg) {
  $('login-error').textContent = msg
}
function setLoginLoading(on) {
  $('btn-login').textContent = on ? 'ПОДОЖДИТЕ...' : 'ВОЙТИ'
  $('btn-login-token').textContent = on ? '...' : 'ВОЙТИ С ТОКЕНОМ'
}

function enterPlayer() {
  $('login-screen').classList.add('hidden')
  $('player-screen').classList.remove('hidden')
  // Wait one frame so the DOM becomes visible before measuring offsetHeight
  requestAnimationFrame(() => {
    updateWindowHeight()
  })
  setupAudio()
  loadLikedIds()
}

async function loadLikedIds() {
  const res = await window.api.yandex.getLikedIds()
  if (res.success) {
    state.likedIds = new Set(res.data)
    updateLikeUI()
    renderPlaylist()
  }
}

// ===== PLAYER UI =====
function bindPlayerUI() {
  $('btn-minimize').addEventListener('click', () => window.api.window.minimize())
  $('btn-close').addEventListener('click', () => window.api.window.close())

  $('btn-play').addEventListener('click', playPause)
  $('btn-pause').addEventListener('click', playPause)
  $('btn-stop').addEventListener('click', stopTrack)
  $('btn-prev').addEventListener('click', playPrev)
  $('btn-next').addEventListener('click', userSkip)
  $('btn-search').addEventListener('click', openSearch)

  // Skin cycling
  $('btn-skin').addEventListener('click', () => {
    const cur = document.body.dataset.theme || 'classic'
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(cur) + 1) % THEME_CYCLE.length]
    applyTheme(next)
  })

  // My playlists toggle
  $('btn-my').addEventListener('click', async () => {
    state.isMyPlVisible = !state.isMyPlVisible
    $('mypl-win').classList.toggle('hidden', !state.isMyPlVisible)
    $('btn-my').classList.toggle('active', state.isMyPlVisible)
    if (state.isMyPlVisible && !state.userPlaylists.length) await loadUserPlaylists()
    updateWindowHeight()
  })

  // Visualizer mode cycle on canvas click
  $('spectrum').addEventListener('click', () => {
    const modes = ['bars', 'scope', 'star', 'fire', 'ring']
    state.vizMode = modes[(modes.indexOf(state.vizMode) + 1) % modes.length]
    const labels = { bars: '◼ SPECTRUM', scope: '〜 SCOPE', star: '✦ STARFIELD', fire: '♨ FIRE', ring: '◎ PULSE' }
    flashMeta(labels[state.vizMode])
  })

  // Like / dislike
  $('btn-like').addEventListener('click', async () => {
    const t = state.playlist[state.currentIndex]
    if (!t) return
    if (state.likedIds.has(t.id)) {
      const res = await window.api.yandex.unlikeTrack(t.id)
      if (res.success) { state.likedIds.delete(t.id); flashMeta('♡ лайк снят') }
      else flashMeta('⚠ ' + (res.error || 'ошибка'))
    } else {
      const res = await window.api.yandex.likeTrack(t.id)
      if (res.success) { state.likedIds.add(t.id); flashMeta('♥ в «Мне нравится»') }
      else flashMeta('⚠ ' + (res.error || 'ошибка'))
    }
    updateLikeUI()
    renderPlaylist()
  })

  $('btn-dislike').addEventListener('click', async () => {
    const t = state.playlist[state.currentIndex]
    if (!t) return
    const res = await window.api.yandex.dislikeTrack(t.id)
    if (!res.success) { flashMeta('⚠ ' + (res.error || 'ошибка')); return }
    state.likedIds.delete(t.id)
    flashMeta('✖ больше не покажем')
    updateLikeUI()
    userSkip() // как в Яндекс Музыке: дизлайк = пропустить
  })

  $('btn-shuffle').addEventListener('click', () => {
    state.isShuffle = !state.isShuffle
    $('btn-shuffle').classList.toggle('active', state.isShuffle)
  })
  $('btn-repeat').addEventListener('click', () => {
    state.isRepeat = !state.isRepeat
    $('btn-repeat').classList.toggle('active', state.isRepeat)
  })

  $('btn-pl').addEventListener('click', () => {
    state.isPlaylistVisible = !state.isPlaylistVisible
    $('playlist-win').classList.toggle('hidden', !state.isPlaylistVisible)
    $('btn-pl').classList.toggle('active', state.isPlaylistVisible)
    updateWindowHeight()
  })

  $('btn-eq').addEventListener('click', () => {
    state.isEqVisible = !state.isEqVisible
    $('eq-win').classList.toggle('hidden', !state.isEqVisible)
    $('btn-eq').classList.toggle('active', state.isEqVisible)
    updateWindowHeight()
  })

  $('volume').addEventListener('input', (e) => {
    state.volume = e.target.value / 100
    audio.volume = state.volume
  })

  $('balance').addEventListener('input', (e) => {
    if (state.audioContext && state.analyser) {
      // balance: not directly supported in basic Web Audio; skip or use StereoPanner
    }
  })

  // Audio events
  audio.addEventListener('ended', () => {
    if (state.isRepeat) {
      audio.currentTime = 0
      audio.play()
    } else {
      const t = state.playlist[state.currentIndex]
      if (state.waveMode && t) window.api.yandex.waveFeedback('trackFinished', t.id, audio.duration || 0)
      playNext()
    }
  })

  audio.addEventListener('timeupdate', updateTimeDisplay)
  audio.addEventListener('loadedmetadata', () => {
    updateTimeDisplay()
  })
  audio.addEventListener('error', () => {
    const err = audio.error
    if (!err || err.code === MediaError.MEDIA_ERR_ABORTED) return // src switched — not a real error
    setTrackTitle(`⚠ Ошибка воспроизведения (код ${err.code})`)
    setPlayStatus('■')
  })

  // Dragging the title bar
  makeDraggable($('titlebar'))

  // Adaptive window height: any change in player content (panels toggled,
  // playlist grows/shrinks) resizes the OS window to match
  const playerScreen = $('player-screen')
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      if (playerScreen.classList.contains('hidden')) return
      const h = playerScreen.offsetHeight
      if (h > 0) window.api.window.setHeight(h)
    }).observe(playerScreen)
  }
}

// ===== SEEKBAR =====
function bindSeekbar() {
  const seekbar = $('seekbar')

  function seek(e) {
    if (!audio.duration) return
    const rect = seekbar.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    audio.currentTime = pct * audio.duration
    updateSeekbarUI(pct)
  }

  seekbar.addEventListener('mousedown', (e) => {
    state.seekDragging = true
    seek(e)
  })
  document.addEventListener('mousemove', (e) => {
    if (state.seekDragging) seek(e)
  })
  document.addEventListener('mouseup', () => {
    state.seekDragging = false
  })
}

function updateSeekbarUI(pct) {
  $('seekbar-fill').style.width = (pct * 100) + '%'
  $('seekbar-handle').style.left = (pct * 100) + '%'
}

// Flash a message in the track-meta area briefly.
// Uses a dedicated #meta-flash element — never rewrites innerHTML, so
// #track-bitrate / #track-freq are never destroyed (that used to kill playback).
let _flashTimer = null
function flashMeta(msg) {
  $('meta-flash').textContent = msg
  $('track-meta').classList.add('flashing')
  if (_flashTimer) clearTimeout(_flashTimer)
  _flashTimer = setTimeout(() => {
    $('track-meta').classList.remove('flashing')
    _flashTimer = null
  }, 1600)
}

// ===== PLAYLIST UI =====
function bindPlaylistUI() {
  $('pl-close').addEventListener('click', () => {
    state.isPlaylistVisible = false
    $('playlist-win').classList.add('hidden')
    $('btn-pl').classList.remove('active')
    updateWindowHeight()
  })
  $('pl-clear').addEventListener('click', clearPlaylist)

  $('mypl-close').addEventListener('click', () => {
    state.isMyPlVisible = false
    $('mypl-win').classList.add('hidden')
    $('btn-my').classList.remove('active')
    updateWindowHeight()
  })
}

// ===== MY PLAYLISTS =====
function getWaveSettings() {
  try {
    return { moodEnergy: 'all', diversity: 'default', language: 'any', ...JSON.parse(localStorage.getItem('yamp-wave') || '{}') }
  } catch (_) {
    return { moodEnergy: 'all', diversity: 'default', language: 'any' }
  }
}

async function loadUserPlaylists() {
  $('mypl-list').innerHTML = '<div class="mypl-msg">Загружаем плейлисты...</div>'

  const [ownRes, smartRes] = await Promise.all([
    window.api.yandex.getPlaylists(),
    window.api.yandex.getSmartPlaylists(),
  ])

  if (!ownRes.success && !smartRes.success) {
    $('mypl-list').innerHTML = `<div class="mypl-msg" style="color:#ff5555">Ошибка: ${esc(ownRes.error)}</div>`
    return
  }

  const own   = ownRes.success   ? ownRes.data   : []
  const smart = smartRes.success ? smartRes.data : []
  state.userPlaylists = own

  const item = (name, count, attrs) => `
    <div class="mypl-item">
      <span class="mypl-name">${esc(name)}</span>
      <span class="mypl-count">${count}</span>
      <button class="mypl-load-btn" ${attrs}>▶ ЗАГРУЗИТЬ</button>
    </div>`

  const ws = getWaveSettings()
  const opt = (v, label, cur) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`

  let html = '<div class="mypl-header">ЯНДЕКС ДЛЯ ВАС</div>'
  html += item('⚡ Моя волна', '∞', 'data-type="wave"')
  html += `
    <div id="wave-settings">
      <select class="wave-select" id="wave-mood" title="Характер">
        ${opt('all', 'Любой характер', ws.moodEnergy)}
        ${opt('active', 'Бодрое', ws.moodEnergy)}
        ${opt('fun', 'Весёлое', ws.moodEnergy)}
        ${opt('calm', 'Спокойное', ws.moodEnergy)}
        ${opt('sad', 'Грустное', ws.moodEnergy)}
      </select>
      <select class="wave-select" id="wave-div" title="Что играть">
        ${opt('default', 'Всё подряд', ws.diversity)}
        ${opt('favorite', 'Любимое', ws.diversity)}
        ${opt('discover', 'Незнакомое', ws.diversity)}
        ${opt('popular', 'Популярное', ws.diversity)}
      </select>
      <select class="wave-select" id="wave-lang" title="Язык">
        ${opt('any', 'Любой язык', ws.language)}
        ${opt('russian', 'Русский', ws.language)}
        ${opt('not-russian', 'Иностранный', ws.language)}
      </select>
    </div>`
  html += item('❤ Мне нравится', 'лайки', 'data-type="liked"')
  html += smart.map(pl =>
    item(pl.title, pl.trackCount ? pl.trackCount + ' тр.' : '', `data-type="pl" data-uid="${esc(pl.uid)}" data-kind="${pl.kind}"`)
  ).join('')

  if (own.length) {
    html += '<div class="mypl-header">МОИ ПЛЕЙЛИСТЫ</div>'
    html += own.map(pl =>
      item(pl.title, pl.trackCount + ' тр.', `data-type="pl" data-uid="${esc(pl.uid)}" data-kind="${pl.kind}"`)
    ).join('')
  }

  $('mypl-list').innerHTML = html

  $('mypl-list').querySelectorAll('.mypl-load-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.textContent = '...'
      btn.disabled = true
      const isWave = btn.dataset.type === 'wave'
      let res2
      if (isWave) {
        // Apply mood/diversity/language settings before starting the wave
        const settings = {
          moodEnergy: $('wave-mood').value,
          diversity:  $('wave-div').value,
          language:   $('wave-lang').value,
        }
        localStorage.setItem('yamp-wave', JSON.stringify(settings))
        await window.api.yandex.setWaveSettings(settings)
        res2 = await window.api.yandex.getWaveTracks()
      }
      else if (btn.dataset.type === 'liked') res2 = await window.api.yandex.getLikedTracks()
      else res2 = await window.api.yandex.getPlaylistTracks(btn.dataset.uid, Number(btn.dataset.kind))
      btn.textContent = '▶ ЗАГРУЗИТЬ'
      btn.disabled = false
      if (!res2.success) { flashMeta('⚠ ' + (res2.error || 'Ошибка загрузки')); return }
      if (!res2.data.tracks.length) { flashMeta('⚠ Плейлист пуст'); return }
      state.waveMode = isWave
      const startIdx = state.playlist.length
      res2.data.tracks.forEach(t => addTrackToPlaylist(t))
      flashMeta(`✓ ${res2.data.title}`)
      if (startIdx < state.playlist.length) playTrackByIndex(startIdx)
      state.isMyPlVisible = false
      $('mypl-win').classList.add('hidden')
      $('btn-my').classList.remove('active')
      updateWindowHeight()
    })
  })
}

// ===== SEARCH UI =====
function bindSearchUI() {
  $('search-close').addEventListener('click', closeSearch)
  $('search-go').addEventListener('click', doSearch)
  $('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch()
    if (e.key === 'Escape') closeSearch()
  })
  $('search-panel').addEventListener('click', (e) => {
    if (e.target === $('search-panel')) closeSearch()
  })
}

function openSearch() {
  $('search-panel').classList.remove('hidden')
  setTimeout(() => $('search-input').focus(), 50)
}
function closeSearch() {
  $('search-panel').classList.add('hidden')
}

async function doSearch() {
  const q = $('search-input').value.trim()
  if (!q) return
  $('search-results').innerHTML = '<div class="search-loading">Поиск...</div>'
  const res = await window.api.yandex.search(q)
  if (!res.success) {
    $('search-results').innerHTML = `<div class="search-error">Ошибка: ${res.error}</div>`
    return
  }
  if (!res.data.length) {
    $('search-results').innerHTML = '<div class="search-empty">Ничего не найдено</div>'
    return
  }
  renderSearchResults(res.data)
}

function renderSearchResults(tracks) {
  const html = tracks.map(t => {
    const dur = formatDuration(t.duration)
    const cover = t.coverUri
      ? `<img class="search-cover" src="https://${t.coverUri.replace('%%', '50x50')}" alt="">`
      : '<div class="search-cover"></div>'
    return `
      <div class="search-track" data-id="${t.id}" data-title="${esc(t.title)}"
           data-artist="${esc(t.artist)}" data-album="${esc(t.album)}"
           data-dur="${t.duration}" data-cover="${esc(t.coverUri || '')}">
        ${cover}
        <div class="search-info">
          <div class="search-title">${esc(t.title)}</div>
          <div class="search-artist">${esc(t.artist)}</div>
          <div class="search-album">${esc(t.album)}</div>
        </div>
        <span class="search-dur">${dur}</span>
        <button class="search-add-btn" title="Добавить в плейлист">+PL</button>
      </div>`
  }).join('')
  $('search-results').innerHTML = html

  $('search-results').querySelectorAll('.search-track').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('search-add-btn')) {
        addTrackToPlaylist({
          id: el.dataset.id,
          title: el.dataset.title,
          artist: el.dataset.artist,
          album: el.dataset.album,
          duration: Number(el.dataset.dur),
          coverUri: el.dataset.cover,
        })
      } else {
        const track = {
          id: el.dataset.id,
          title: el.dataset.title,
          artist: el.dataset.artist,
          album: el.dataset.album,
          duration: Number(el.dataset.dur),
          coverUri: el.dataset.cover,
        }
        addTrackToPlaylist(track)
        playTrackByIndex(state.playlist.length - 1)
        closeSearch()
      }
    })
  })
}

// ===== EQUALIZER UI =====
function bindEqUI() {
  $('eq-close').addEventListener('click', () => {
    state.isEqVisible = false
    $('eq-win').classList.add('hidden')
    $('btn-eq').classList.remove('active')
    updateWindowHeight()
  })

  document.querySelectorAll('.eq-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = EQ_PRESETS[btn.dataset.preset]
      if (!preset) return
      const sliders = document.querySelectorAll('#eq-bands .eq-band:not(:first-child):not(.eq-divider) .eq-slider')
      sliders.forEach((sl, i) => {
        sl.value = preset[i] || 0
        applyEqBand(i, preset[i] || 0)
      })
    })
  })

  document.querySelectorAll('#eq-bands .eq-band').forEach((band, i) => {
    const sl = band.querySelector('.eq-slider')
    if (!sl) return
    const hz = band.dataset.hz
    sl.addEventListener('input', () => {
      if (hz) applyEqBand(i - 2, Number(sl.value)) // offset for PRE + divider
    })
  })

  $('eq-preamp').addEventListener('input', (e) => {
    if (state.audioContext) {
      const gainNode = state.audioContext.createGain()
      gainNode.gain.value = Math.pow(10, Number(e.target.value) / 20)
    }
  })
}

function applyEqBand(index, gainDb) {
  if (state.eqNodes[index]) {
    state.eqNodes[index].gain.value = gainDb
  }
}

// ===== AUDIO ENGINE =====
function setupAudio() {
  if (state.audioContext) return
  try {
    state.audioContext = new AudioContext()
    state.analyser = state.audioContext.createAnalyser()
    state.analyser.fftSize = 512
    state.analyser.smoothingTimeConstant = 0.75

    // Build EQ chain
    let lastNode = state.analyser
    state.eqBands.forEach((freq, i) => {
      const filter = state.audioContext.createBiquadFilter()
      filter.type = i === 0 ? 'lowshelf' : i === state.eqBands.length - 1 ? 'highshelf' : 'peaking'
      filter.frequency.value = freq
      filter.gain.value = 0
      lastNode.connect(filter)
      lastNode = filter
      state.eqNodes.push(filter)
    })
    lastNode.connect(state.audioContext.destination)

    state.mediaSource = state.audioContext.createMediaElementSource(audio)
    state.mediaSource.connect(state.analyser)

    startSpectrumAnimation()
  } catch (e) {
    console.warn('Web Audio setup failed:', e)
  }
}

function resumeAudioContext() {
  if (state.audioContext?.state === 'suspended') {
    state.audioContext.resume()
  }
}

// ===== PLAYBACK =====
let _playSeq = 0 // guards against races when tracks are switched quickly
async function playTrackByIndex(index) {
  if (index < 0 || index >= state.playlist.length) return
  const seq = ++_playSeq
  state.currentIndex = index
  const track = state.playlist[index]

  setTrackTitle(`${track.artist} — ${track.title}`)
  setPlayStatus('...')
  $('track-bitrate').textContent = '...'

  highlightPlaylistItem(index)
  updateLikeUI()

  const res = await window.api.yandex.getTrackUrl(track.id)
  if (seq !== _playSeq) return // another track was requested meanwhile
  if (!res.success) {
    setTrackTitle('⚠ ' + (res.error || 'Нет доступа к треку'))
    setPlayStatus('■')
    return
  }

  audio.pause()
  audio.src = res.url
  audio.load()
  resumeAudioContext()
  try {
    await audio.play()
    if (seq !== _playSeq) return
    state.isPlaying = true
    setPlayStatus('▶')
    $('track-bitrate').textContent = '320'
    startScrollingTitle()
    if (state.waveMode) window.api.yandex.waveFeedback('trackStarted', track.id)
    maybeExtendWave(index)
  } catch (err) {
    if (seq !== _playSeq || err.name === 'AbortError') return
    setPlayStatus('■')
    setTrackTitle(`⚠ ${err.name}: ${track.title}`)
    console.warn('Play error:', err)
  }
}

// "Моя волна": when close to the playlist end, silently fetch the next rotor batch
let _waveLoading = false
async function maybeExtendWave(index) {
  if (!state.waveMode || _waveLoading) return
  if (index < state.playlist.length - 3) return
  _waveLoading = true
  try {
    const res = await window.api.yandex.getWaveTracks(true)
    if (res.success && res.data.tracks.length && state.waveMode) {
      const before = state.playlist.length
      res.data.tracks.forEach(t => addTrackToPlaylist(t))
      const added = state.playlist.length - before
      if (added > 0) flashMeta(`⚡ волна: +${added}`)
    }
  } finally {
    _waveLoading = false
  }
}

function playPause() {
  if (!state.audioContext) setupAudio()
  resumeAudioContext()

  if (state.playlist.length === 0) {
    openSearch()
    return
  }

  if (state.currentIndex === -1) {
    playTrackByIndex(0)
    return
  }

  if (audio.paused) {
    audio.play()
    state.isPlaying = true
    setPlayStatus('▶')
    startScrollingTitle()
  } else {
    audio.pause()
    state.isPlaying = false
    setPlayStatus('⏸')
    stopScrollingTitle()
  }
}

function stopTrack() {
  audio.pause()
  audio.currentTime = 0
  state.isPlaying = false
  setPlayStatus('■')
  stopScrollingTitle()
  updateSeekbarUI(0)
  $('time-m').textContent = '00'
  $('time-s').textContent = '00'
}

// Manual skip: tell the rotor so the wave adapts, then advance
function userSkip() {
  const t = state.playlist[state.currentIndex]
  if (state.waveMode && t) window.api.yandex.waveFeedback('skip', t.id, audio.currentTime || 0)
  playNext()
}

function playNext() {
  if (state.playlist.length === 0) return
  let next
  if (state.isShuffle) {
    next = Math.floor(Math.random() * state.playlist.length)
  } else {
    next = state.currentIndex + 1
    if (next >= state.playlist.length) next = 0
  }
  playTrackByIndex(next)
}

function playPrev() {
  if (state.playlist.length === 0) return
  if (audio.currentTime > 3) {
    audio.currentTime = 0
    return
  }
  let prev = state.currentIndex - 1
  if (prev < 0) prev = state.playlist.length - 1
  playTrackByIndex(prev)
}

// ===== PLAYLIST MANAGEMENT =====
function addTrackToPlaylist(track) {
  if (state.playlist.find(t => t.id === track.id)) return // no duplicates
  state.playlist.push(track)
  renderPlaylist()
  updatePlCount()
}

function clearPlaylist() {
  stopTrack()
  state.playlist = []
  state.currentIndex = -1
  state.waveMode = false
  renderPlaylist()
  updatePlCount()
  setTrackTitle('YandexAmp — плейлист очищен')
}

function renderPlaylist() {
  const container = $('playlist-tracks')
  if (state.playlist.length === 0) {
    container.innerHTML = '<div style="padding:8px;color:#555;text-align:center">Плейлист пуст — нажмите ⏏ для поиска</div>'
    return
  }
  container.innerHTML = state.playlist.map((t, i) => `
    <div class="pl-track ${i === state.currentIndex ? 'active' : ''}" data-index="${i}">
      <span class="pl-num">${i + 1}.</span>
      <span class="pl-title">${state.likedIds.has(t.id) ? '<span class="pl-liked-mark">♥</span>' : ''}${esc(t.title)}</span>
      <span class="pl-artist">${esc(t.artist)}</span>
      <span class="pl-dur">${formatDuration(t.duration)}</span>
    </div>`).join('')

  container.querySelectorAll('.pl-track').forEach(el => {
    // Single click starts the track (Winamp-style dblclick confused users)
    el.addEventListener('click', () => {
      const i = Number(el.dataset.index)
      if (i === state.currentIndex && !audio.paused) return // already playing this one
      playTrackByIndex(i)
    })
  })
}

function highlightPlaylistItem(index, scroll = true) {
  document.querySelectorAll('.pl-track').forEach((el, i) => {
    el.classList.toggle('active', i === index)
  })
  if (scroll) {
    const active = $('playlist-tracks').querySelector('.pl-track.active')
    if (active) active.scrollIntoView({ block: 'nearest' })
  }
}

function updatePlCount() {
  $('pl-count').textContent = state.playlist.length + ' треков'
}

// ===== DISPLAY HELPERS =====
function updateLikeUI() {
  const t = state.playlist[state.currentIndex]
  $('btn-like').classList.toggle('liked', Boolean(t && state.likedIds.has(t.id)))
}

function setTrackTitle(text) {
  $('track-title-text').textContent = text
}

function setPlayStatus(icon) {
  $('play-indicator').textContent = icon
}

function startScrollingTitle() {
  $('track-title-text').classList.add('scrolling')
}

function stopScrollingTitle() {
  $('track-title-text').classList.remove('scrolling')
}

function updateTimeDisplay() {
  if (!audio.duration) return
  const cur = audio.currentTime || 0
  const m = Math.floor(cur / 60)
  const s = Math.floor(cur % 60)
  $('time-m').textContent = String(m).padStart(2, '0')
  $('time-s').textContent = String(s).padStart(2, '0')

  if (!state.seekDragging) {
    updateSeekbarUI(cur / audio.duration)
  }
}

// ===== SPECTRUM / VISUALIZER =====
function startSpectrumIdle() {
  if (state.animFrameId) cancelAnimationFrame(state.animFrameId)
  const canvas = $('spectrum')
  const ctx = canvas.getContext('2d')
  const W = canvas.width, H = canvas.height
  const BARS = 22
  let phase = 0
  function drawIdle() {
    ctx.fillStyle = state.lcdBg
    ctx.fillRect(0, 0, W, H)
    const bw = Math.floor(W / BARS) - 1
    for (let i = 0; i < BARS; i++) {
      const h = (Math.sin(phase + i * 0.45) * 0.18 + 0.22) * H
      const g = ctx.createLinearGradient(0, H - h, 0, H)
      g.addColorStop(0, state.lcdMid); g.addColorStop(1, state.lcdDim)
      ctx.fillStyle = g
      ctx.fillRect(i * (bw + 1), H - h, bw, h)
    }
    phase += 0.04
    state.animFrameId = requestAnimationFrame(drawIdle)
  }
  drawIdle()
}

function startSpectrumAnimation() {
  if (state.animFrameId) cancelAnimationFrame(state.animFrameId)
  const canvas = $('spectrum')
  const ctx = canvas.getContext('2d')
  const W = canvas.width, H = canvas.height
  const BARS = 22
  const bufLen = state.analyser.frequencyBinCount
  const freqData = new Uint8Array(bufLen)
  const timeData = new Uint8Array(state.analyser.fftSize)
  const peaks = new Array(BARS).fill(0)
  const peakVel = new Array(BARS).fill(0)

  // Stars for starfield mode — initialized once
  const stars = Array.from({ length: 120 }, () => ({
    x: Math.random() * W,
    y: Math.floor(Math.random() * H),
    spd: 0.4 + Math.random() * 1.4,
    sz: Math.random() < 0.2 ? 2 : 1,
  }))

  // Fire buffer — classic demoscene flame seeded by the spectrum
  const FW = 84, FH = 14
  const heat = new Float32Array(FW * (FH + 2))
  const cellW = W / FW, cellH = H / FH

  let ringRot = 0

  function draw() {
    state.animFrameId = requestAnimationFrame(draw)
    if (state.vizMode === 'scope') drawScope()
    else if (state.vizMode === 'star') drawStars()
    else if (state.vizMode === 'fire') drawFire()
    else if (state.vizMode === 'ring') drawRing()
    else drawBars()
  }

  function drawBars() {
    state.analyser.getByteFrequencyData(freqData)
    ctx.fillStyle = state.lcdBg
    ctx.fillRect(0, 0, W, H)
    const bw = Math.floor(W / BARS) - 1
    for (let i = 0; i < BARS; i++) {
      const bs = Math.floor(i * bufLen / BARS)
      const be = Math.floor((i + 1) * bufLen / BARS)
      let sum = 0
      for (let j = bs; j < be; j++) sum += freqData[j]
      const avg = sum / (be - bs)
      const barH = (avg / 255) * H
      if (barH > peaks[i]) { peaks[i] = barH; peakVel[i] = 0 }
      else { peakVel[i] += 0.3; peaks[i] = Math.max(0, peaks[i] - peakVel[i]) }
      const x = i * (bw + 1)
      const t = avg / 255
      const topColor = t > 0.7 ? '#ff4444' : t > 0.4 ? '#ffdd00' : state.lcdGreen
      const g = ctx.createLinearGradient(0, H - barH, 0, H)
      g.addColorStop(0, topColor); g.addColorStop(0.5, state.lcdMid); g.addColorStop(1, state.lcdDim)
      ctx.fillStyle = g
      ctx.fillRect(x, H - barH, bw, barH)
      if (peaks[i] > 2) {
        ctx.fillStyle = t > 0.7 ? '#ff4444' : '#ffdd00'
        ctx.fillRect(x, H - peaks[i] - 1, bw, 2)
      }
    }
  }

  function drawScope() {
    state.analyser.getByteTimeDomainData(timeData)
    ctx.fillStyle = state.lcdBg
    ctx.fillRect(0, 0, W, H)
    ctx.strokeStyle = state.lcdGreen
    ctx.lineWidth = 1.5
    ctx.shadowColor = state.lcdGreen
    ctx.shadowBlur = 5
    ctx.beginPath()
    const sw = W / timeData.length
    for (let i = 0; i < timeData.length; i++) {
      const y = ((timeData[i] / 128) - 1) * 0.88 * H / 2 + H / 2
      i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * sw, y)
    }
    ctx.stroke()
    ctx.shadowBlur = 0
  }

  function drawStars() {
    state.analyser.getByteFrequencyData(freqData)
    const bass = freqData.slice(0, 6).reduce((a, b) => a + b, 0) / 6 / 255
    const spd = 1 + bass * 5
    // Fading trail
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = state.lcdGreen
    for (const s of stars) {
      s.x -= s.spd * spd
      if (s.x < 0) { s.x = W + 1; s.y = Math.floor(Math.random() * H) }
      ctx.fillRect(Math.floor(s.x), s.y, s.sz, s.sz)
    }
  }

  function drawFire() {
    state.analyser.getByteFrequencyData(freqData)
    // Seed the two bottom rows from the lower half of the spectrum
    for (let x = 0; x < FW; x++) {
      const bi = Math.floor(x * (bufLen / 2) / FW)
      const v = freqData[bi] / 255
      const seed = v * (0.7 + Math.random() * 0.8)
      heat[FH * FW + x] = seed
      heat[(FH + 1) * FW + x] = seed
    }
    // One propagation step upwards per frame (rows read values from the
    // previous frame because we iterate top-down through memory)
    for (let y = 0; y < FH; y++) {
      for (let x = 0; x < FW; x++) {
        const below = (y + 1) * FW
        const l = heat[below + Math.max(0, x - 1)]
        const c = heat[below + x]
        const r = heat[below + Math.min(FW - 1, x + 1)]
        const b2 = heat[(y + 2) * FW + x]
        heat[y * FW + x] = (l + c + r + b2) / 4.1
      }
    }
    ctx.fillStyle = state.lcdBg
    ctx.fillRect(0, 0, W, H)
    for (let y = 0; y < FH; y++) {
      for (let x = 0; x < FW; x++) {
        const t = Math.min(1, heat[y * FW + x] * 1.6)
        if (t < 0.04) continue
        const rr = Math.min(255, Math.floor(t * 3 * 255))
        const gg = Math.max(0, Math.min(255, Math.floor((t * 3 - 1) * 255)))
        const bb = Math.max(0, Math.min(255, Math.floor((t * 3 - 2) * 255)))
        ctx.fillStyle = `rgb(${rr},${gg},${bb})`
        ctx.fillRect(x * cellW, y * cellH, cellW + 1, cellH + 1)
      }
    }
  }

  function drawRing() {
    state.analyser.getByteFrequencyData(freqData)
    const bass = freqData.slice(0, 6).reduce((a, b) => a + b, 0) / 6 / 255
    ringRot += 0.008 + bass * 0.05
    ctx.fillStyle = state.lcdBg
    ctx.fillRect(0, 0, W, H)
    const cx = W / 2, cy = H / 2
    const N = 72
    const rx = W * 0.16 + bass * W * 0.04
    const ry = H * 0.22 + bass * H * 0.10
    ctx.lineWidth = 2
    for (let i = 0; i < N; i++) {
      const bi = Math.floor(i * (bufLen * 0.7) / N)
      const v = freqData[bi] / 255
      const ang = ringRot + (i / N) * Math.PI * 2
      const cos = Math.cos(ang), sin = Math.sin(ang)
      const x1 = cx + cos * rx, y1 = cy + sin * ry
      const len = v * v * 1.15
      const x2 = cx + cos * (rx + len * W * 0.32)
      const y2 = cy + sin * (ry + len * H * 0.55)
      ctx.strokeStyle = v > 0.75 ? '#ff4444' : v > 0.5 ? '#ffdd00' : state.lcdGreen
      ctx.globalAlpha = 0.35 + v * 0.65
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    // Pulsing core
    ctx.fillStyle = state.lcdGreen
    ctx.shadowColor = state.lcdGreen
    ctx.shadowBlur = 8 + bass * 14
    ctx.beginPath()
    ctx.ellipse(cx, cy, 2 + bass * 5, 1.5 + bass * 3.5, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur = 0
  }

  draw()
}

// ===== WINDOW HEIGHT =====
function updateWindowHeight() {
  const h = $('player-screen').offsetHeight
  if (h > 0) window.api.window.setHeight(h)
}

// ===== DRAGGABLE WINDOW =====
function makeDraggable(el) {
  // Handled by CSS -webkit-app-region: drag
}

// ===== UTILS =====
function formatDuration(ms) {
  if (!ms) return '--:--'
  const s = Math.floor(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
