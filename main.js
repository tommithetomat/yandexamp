const { app, BrowserWindow, ipcMain, session } = require('electron')
const path = require('path')
const YandexMusicService = require('./src/yandex-music')

let mainWindow
const yandex = new YandexMusicService()

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
    height: 310,
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
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// --- IPC Handlers ---

ipcMain.handle('window:minimize', () => mainWindow.minimize())
ipcMain.handle('window:close', () => mainWindow.close())

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
  const [w] = mainWindow.getSize()
  mainWindow.setSize(w, height, true)
})

ipcMain.handle('yandex:login', async (_, { username, password }) => {
  try {
    await yandex.login(username, password)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message || String(err) }
  }
})

ipcMain.handle('yandex:loginWithToken', async (_, { token }) => {
  try {
    yandex.setToken(token)
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

