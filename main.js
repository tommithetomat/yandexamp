const { app, BrowserWindow, ipcMain, session, safeStorage, shell, Tray, Menu } = require('electron')
const path = require('path')
const fs = require('fs')
const https = require('https')
const YandexMusicService = require('./src/yandex-music')

let mainWindow
let tray = null
const yandex = new YandexMusicService()

function toggleWindow() {
  if (!mainWindow) return
  if (mainWindow.isVisible()) mainWindow.hide()
  else { mainWindow.show(); mainWindow.focus() }
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'icon.ico'))
  tray.setToolTip('YandexAmp')
  const send = cmd => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('media:cmd', cmd) }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Показать / скрыть', click: () => toggleWindow() },
    { type: 'separator' },
    { label: 'Играть / пауза', click: () => send('playpause') },
    { label: 'Следующий трек', click: () => send('next') },
    { label: 'Предыдущий трек', click: () => send('prev') },
    { type: 'separator' },
    { label: 'Выход', click: () => app.quit() },
  ]))
  tray.on('click', () => toggleWindow())
}

// --- Persisted auth (encrypted with the OS keychain when available) ---

const authFile = () => path.join(app.getPath('userData'), 'auth.json')

function saveAuth() {
  try {
    if (!yandex.token) return
    const payload = JSON.stringify({ token: yandex.token, uid: yandex.uid })
    let data, enc = false
    if (safeStorage.isEncryptionAvailable()) {
      data = safeStorage.encryptString(payload).toString('base64')
      enc = true
    } else {
      data = Buffer.from(payload, 'utf8').toString('base64')
    }
    fs.writeFileSync(authFile(), JSON.stringify({ enc, data }))
  } catch (_) {}
}

function loadAuth() {
  try {
    const raw = JSON.parse(fs.readFileSync(authFile(), 'utf8'))
    const buf = Buffer.from(raw.data, 'base64')
    const payload = raw.enc ? safeStorage.decryptString(buf) : buf.toString('utf8')
    const { token, uid } = JSON.parse(payload)
    if (token) yandex.setToken(token, uid || null)
  } catch (_) {}
}

function createWindow() {
  // Allow Yandex Music CDN audio in renderer (no CORS block)
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    if (details.url.includes('yandex.net') || details.url.includes('yandex.ru')) {
      headers['Origin'] = 'https://music.yandex.ru'
      headers['Referer'] = 'https://music.yandex.ru/'
    }
    callback({ requestHeaders: headers })
  })

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders }
    if (
      details.url.includes('yandex.net') ||
      details.url.includes('yandex.ru') ||
      details.url.includes('storage.mds')
    ) {
      headers['access-control-allow-origin']   = ['*']
      headers['access-control-allow-methods']  = ['GET, HEAD, OPTIONS']
      headers['access-control-allow-headers']  = ['*']
      headers['access-control-expose-headers'] = ['Content-Range, Accept-Ranges, Content-Length']
    }
    callback({ responseHeaders: headers })
  })

  mainWindow = new BrowserWindow({
    width: 550,
    height: 340,
    useContentSize: true,
    frame: false,
    resizable: false,
    transparent: false,
    backgroundColor: '#232323',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
}

app.whenReady().then(() => {
  loadAuth()
  createWindow()
  createTray()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// --- IPC Handlers ---

// Minimize goes to tray instead of the taskbar
ipcMain.handle('window:minimize', () => mainWindow.hide())
ipcMain.handle('window:close', () => mainWindow.close())
ipcMain.handle('window:setPin', (_, on) => {
  mainWindow.setAlwaysOnTop(Boolean(on), 'floating')
})
ipcMain.handle('window:setWidth', (_, width) => {
  const w = Math.round(width)
  const [cur, h] = mainWindow.getContentSize()
  if (cur === w) return
  mainWindow.setResizable(true)
  mainWindow.setContentSize(w, h, false)
  mainWindow.setResizable(false)
})

// --- Browser OAuth ---

// Music client ID supports response_type=token without needing a registered redirect URI
const OAUTH_CLIENT_ID = '23cabbbdc6cd418abb4b39c32c41195d'
const OAUTH_URL = `https://oauth.yandex.ru/authorize?response_type=token&client_id=${OAUTH_CLIENT_ID}&force_confirm=0`

ipcMain.handle('yandex:loginBrowser', () => {
  return new Promise((resolve) => {
    let settled = false
    let pollTimer = null

    const done = (result) => {
      if (settled) return
      settled = true
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
      resolve(result)
    }

    const closeWin = () => { try { if (!authWin.isDestroyed()) authWin.destroy() } catch (_) {} }

    const authWin = new BrowserWindow({
      width: 520,
      height: 660,
      title: 'Войти в Яндекс',
      parent: mainWindow,
      modal: true,
      webPreferences: { nodeIntegration: false, contextIsolation: false },
    })

    authWin.setMenuBarVisibility(false)
    authWin.loadURL(OAUTH_URL)

    // Use the token directly (music client returns a music-ready token)
    async function handleToken(token, uid) {
      if (settled) return
      try {
        // Try to exchange for a fresh music token; fall back to direct use
        await yandex.exchangeTokenForMusic(token)
      } catch (_) {
        yandex.setToken(token, uid)
      }
      saveAuth()
      done({ success: true })   // done() BEFORE closeWin() so exceptions in destroy() can't swallow it
      closeWin()
    }

    // Check a URL string for the access_token hash fragment
    function tryExtractFromUrl(url) {
      if (settled || !url) return false
      const hashIdx = url.indexOf('#')
      if (hashIdx === -1) return false
      const hash = url.slice(hashIdx + 1)
      if (!hash.includes('access_token=')) return false
      const params = new URLSearchParams(hash)
      const token = params.get('access_token')
      if (!token) return false
      handleToken(token, params.get('uid') || null)
      return true
    }

    // Read location.href via JS and scan DOM for token — covers JS-driven navigations
    async function checkPageContent() {
      if (settled || authWin.isDestroyed()) return
      try {
        const href = await authWin.webContents.executeJavaScript('location.href')
        if (tryExtractFromUrl(href) || settled) return

        // The verification_code page may show the token as text or in an input
        if (href.includes('verification_code') || href.includes('oauth.yandex.ru')) {
          const found = await authWin.webContents.executeJavaScript(`
            (function() {
              var inputs = document.querySelectorAll('input')
              for (var i = 0; i < inputs.length; i++) {
                var v = inputs[i].value
                if (v && v.length > 30 && !/[\\s]/.test(v)) return v
              }
              var text = document.body ? document.body.innerText : ''
              var m = text.match(/y0_[A-Za-z0-9._-]{30,}/) || text.match(/AQ[A-Za-z0-9_-]{40,}/)
              return m ? m[0] : null
            })()
          `)
          if (found && !settled) handleToken(found, null)
        }
      } catch (_) {}
    }

    // Inject a "please wait" banner so the user doesn't close the window prematurely
    authWin.webContents.on('did-finish-load', async () => {
      if (settled || authWin.isDestroyed()) return
      try {
        await authWin.webContents.executeJavaScript(`
          (function() {
            var b = document.getElementById('_yamp_banner')
            if (b) return
            var s = document.createElement('style')
            s.textContent = '#_yamp_banner{position:fixed;bottom:0;left:0;right:0;background:#ffdb4d;color:#000;font:13px/1.4 sans-serif;padding:8px 12px;text-align:center;z-index:2147483647}'
            document.head.appendChild(s)
            var d = document.createElement('div')
            d.id = '_yamp_banner'
            d.textContent = 'YandexAmp: авторизуемся... не закрывайте окно'
            document.body.appendChild(d)
          })()
        `)
      } catch (_) {}
      checkPageContent()
    })

    // Navigation events: cover HTTP redirects (will-redirect) and JS navigations (will-navigate)
    authWin.webContents.on('will-navigate',       (_, url) => tryExtractFromUrl(url))
    authWin.webContents.on('will-redirect',        (_, url) => tryExtractFromUrl(url))
    authWin.webContents.on('did-navigate',         (_, url) => { tryExtractFromUrl(url); checkPageContent() })
    authWin.webContents.on('did-navigate-in-page', (_, url) => { tryExtractFromUrl(url); checkPageContent() })
    authWin.webContents.on('dom-ready',            () => checkPageContent())

    // Aggressive poll: 100ms catches tokens set by page JS after initial load
    pollTimer = setInterval(checkPageContent, 100)

    authWin.on('closed', () => done({ success: false, error: 'Окно авторизации закрыто' }))
  })
})

ipcMain.handle('window:setHeight', (_, height) => {
  const h = Math.round(height)
  const [w, cur] = mainWindow.getContentSize()
  if (cur === h) return
  // On Windows setSize can be ignored while resizable=false — toggle around it
  mainWindow.setResizable(true)
  mainWindow.setContentSize(w, h, false)
  mainWindow.setResizable(false)
})

// --- Update check against GitHub Releases ---

const REPO = 'tommithetomat/yandexamp'

function isNewerVersion(latest, current) {
  const a = latest.split('.').map(Number)
  const b = current.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true
    if ((a[i] || 0) < (b[i] || 0)) return false
  }
  return false
}

ipcMain.handle('app:checkUpdate', () => {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'api.github.com',
      path: `/repos/${REPO}/releases/latest`,
      headers: { 'User-Agent': 'YandexAmp', Accept: 'application/vnd.github+json' },
    }, res => {
      let data = ''
      res.on('data', c => (data += c))
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          const latest = String(json.tag_name || '').replace(/^v/, '')
          if (!latest) { resolve({ newer: false }); return }
          resolve({
            newer: isNewerVersion(latest, app.getVersion()),
            latest,
            url: json.html_url || `https://github.com/${REPO}/releases`,
          })
        } catch (_) { resolve({ newer: false }) }
      })
    })
    req.on('error', () => resolve({ newer: false }))
    req.setTimeout(10000, () => { req.destroy(); resolve({ newer: false }) })
  })
})

ipcMain.handle('app:openReleases', (_, url) => {
  // Only allow opening our own releases page
  const safe = typeof url === 'string' && url.startsWith(`https://github.com/${REPO}/`)
  shell.openExternal(safe ? url : `https://github.com/${REPO}/releases`)
})

// Silent session restore from the saved token; validates it against the API
ipcMain.handle('yandex:restoreSession', async () => {
  if (!yandex.token) return { success: false }
  const account = await yandex.initSession()
  if (!account) return { success: false }
  return { success: true }
})

ipcMain.handle('yandex:login', async (_, { username, password }) => {
  try {
    await yandex.login(username, password)
    saveAuth()
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message || String(err) }
  }
})

ipcMain.handle('yandex:loginWithToken', async (_, { token }) => {
  try {
    yandex.setToken(token)
    saveAuth()
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message || String(err) }
  }
})

ipcMain.handle('yandex:getPlaylists', async () => {
  try {
    const data = await yandex.getUserPlaylists()
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err.message || String(err) }
  }
})

ipcMain.handle('yandex:getSmartPlaylists', async () => {
  try {
    const data = await yandex.getSmartPlaylists()
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err.message || String(err) }
  }
})

ipcMain.handle('yandex:getLikedTracks', async () => {
  try {
    const data = await yandex.getLikedTracks()
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err.message || String(err) }
  }
})

ipcMain.handle('yandex:getLikedIds', async () => {
  try {
    const data = await yandex.getLikedIds()
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err.message || String(err) }
  }
})

ipcMain.handle('yandex:likeTrack', async (_, { trackId }) => {
  try {
    await yandex.likeTrack(trackId)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message || String(err) }
  }
})

ipcMain.handle('yandex:unlikeTrack', async (_, { trackId }) => {
  try {
    await yandex.unlikeTrack(trackId)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message || String(err) }
  }
})

ipcMain.handle('yandex:dislikeTrack', async (_, { trackId }) => {
  try {
    await yandex.dislikeTrack(trackId)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message || String(err) }
  }
})

ipcMain.handle('yandex:waveFeedback', async (_, { type, trackId, playedSeconds }) => {
  try {
    await yandex.sendWaveFeedback(type, trackId, playedSeconds)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message || String(err) }
  }
})

ipcMain.handle('yandex:setWaveSettings', async (_, settings) => {
  try {
    await yandex.setWaveSettings(settings)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message || String(err) }
  }
})

ipcMain.handle('yandex:getWaveTracks', async (_, args) => {
  try {
    const data = await yandex.getWaveTracks(Boolean(args?.more))
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err.message || String(err) }
  }
})

ipcMain.handle('yandex:getPlaylistTracks', async (_, { uid, kind }) => {
  try {
    const data = await yandex.getPlaylistTracks(uid, kind)
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err.message || String(err) }
  }
})

// Generic helper: wrap a service call as { success, data }
function handleData(channel, fn) {
  ipcMain.handle(channel, async (_, arg) => {
    try { return { success: true, data: await fn(arg) } }
    catch (err) { return { success: false, error: err.message || String(err) } }
  })
}

handleData('yandex:getStationsList', () => yandex.getStationsList())
handleData('yandex:getStationTracks', ({ stationId }) => yandex.getStationTracks(stationId))
handleData('yandex:getTrackRadio', ({ trackId }) => yandex.getTrackRadio(trackId))
handleData('yandex:getChart', () => yandex.getChart())
handleData('yandex:getNewReleases', () => yandex.getNewReleases())
handleData('yandex:getPlayHistory', () => yandex.getPlayHistory())
handleData('yandex:getArtist', ({ artistId }) => yandex.getArtist(artistId))
handleData('yandex:getAlbumTracks', ({ albumId }) => yandex.getAlbumTracks(albumId))

ipcMain.handle('yandex:getLyrics', async (_, { trackId }) => {
  try {
    const data = await yandex.getLyrics(trackId)
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err.message || String(err) }
  }
})

ipcMain.handle('yandex:search', async (_, { query }) => {
  try {
    const data = await yandex.search(query)
    return { success: true, data }
  } catch (err) {
    return { success: false, error: err.message || String(err) }
  }
})

ipcMain.handle('yandex:getTrackUrl', async (_, { trackId }) => {
  try {
    const url = await yandex.getTrackUrl(trackId)
    return { success: true, url }
  } catch (err) {
    return { success: false, error: err.message || String(err) }
  }
})

