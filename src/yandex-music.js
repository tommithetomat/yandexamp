const crypto = require('crypto')
const https = require('https')

const MAGIC = 'XGRlBW9FXlekgbPrRHuSiA'

// Client IDs from the official Yandex Music mobile app (public, embedded in APK)
const OAUTH1 = { CLIENT_ID: '0618394846eb4d9589a602f80ce013d6', CLIENT_SECRET: 'c13b3de8d9f5492caf321467c3520358' }
const OAUTH2 = { CLIENT_ID: '23cabbbdc6cd418abb4b39c32c41195d', CLIENT_SECRET: '53bc75238f0c4d08a118e51fe9203300' }
const DEVICE  = { DEVICE_ID: '377c5ae26b09fccd72deae0a95425559', UUID: '3cfccdaf75dcf98b917a54afe50447ba' }

class YandexMusicService {
  constructor() {
    this.token = null
    this.uid   = null
  }

  // ===== AUTH =====

  async login(username, password) {
    // Step 1: password → access_token
    const step1 = await this._oauthPost('/1/token', {
      grant_type:    'password',
      username,
      password,
      client_id:     OAUTH1.CLIENT_ID,
      client_secret: OAUTH1.CLIENT_SECRET,
    })

    // Step 2: access_token → music OAuth token
    const step2 = await this._oauthPost(
      `/1/token?device_id=${DEVICE.DEVICE_ID}&uuid=${DEVICE.UUID}&package_name=ru.yandex.music`,
      {
        grant_type:    'x-token',
        access_token:  step1.access_token,
        client_id:     OAUTH2.CLIENT_ID,
        client_secret: OAUTH2.CLIENT_SECRET,
      }
    )

    this.token = step2.access_token
    this.uid   = step2.uid
    return step2
  }

  async loginWithCode(code) {
    // Step 1: exchange authorization code for basic Yandex token
    const step1 = await this._oauthPost('/1/token', {
      grant_type:    'authorization_code',
      code,
      client_id:     OAUTH1.CLIENT_ID,
      client_secret: OAUTH1.CLIENT_SECRET,
      redirect_uri:  'https://oauth.yandex.ru/verification_code',
    })

    // Step 2: exchange basic token for music-specific token
    return this.exchangeTokenForMusic(step1.access_token)
  }

  async exchangeTokenForMusic(basicToken) {
    const step2 = await this._oauthPost(
      `/1/token?device_id=${DEVICE.DEVICE_ID}&uuid=${DEVICE.UUID}&package_name=ru.yandex.music`,
      {
        grant_type:    'x-token',
        access_token:  basicToken,
        client_id:     OAUTH2.CLIENT_ID,
        client_secret: OAUTH2.CLIENT_SECRET,
      }
    )
    this.token = step2.access_token
    this.uid   = step2.uid
    return step2
  }

  async initSession() {
    try {
      const data = await this._apiGet('/account/status')
      const account = data?.result?.account
      if (account?.uid) this.uid = String(account.uid)
      return account
    } catch (_) { return null }
  }

  async getUserPlaylists() {
    if (!this.uid) await this.initSession()
    if (!this.uid) throw new Error('UID не удалось получить — попробуйте войти через логин/пароль')
    const data = await this._apiGet(`/users/${this.uid}/playlists/list`)
    return (data.result || []).map(p => ({
      kind:       p.kind,
      uid:        String(p.uid || this.uid),
      title:      p.title || 'Без названия',
      trackCount: p.trackCount || 0,
    }))
  }

  async getPlaylistTracks(uid, kind) {
    const data = await this._apiGet(`/users/${uid}/playlists/${kind}?rich-tracks=true`)
    const pl = data.result
    if (!pl) throw new Error('Плейлист не найден')
    const tracks = (pl.tracks || [])
      .filter(t => t.track && !t.track.error)
      .map(t => this._mapTrack(t.track))
    return { title: pl.title || 'Плейлист', tracks }
  }

  // Yandex-generated playlists: Плейлист дня, Премьера, Дежавю и т.д.
  async getSmartPlaylists() {
    const data = await this._apiGet('/landing3?blocks=personalplaylists')
    const out = []
    for (const block of (data.result?.blocks || [])) {
      for (const e of (block.entities || [])) {
        const p = e.data?.data || e.data
        if (p && p.kind != null && (p.uid != null || p.owner?.uid != null)) {
          out.push({
            kind:       p.kind,
            uid:        String(p.uid ?? p.owner.uid),
            title:      p.title || 'Плейлист',
            trackCount: p.trackCount || 0,
          })
        }
      }
    }
    return out
  }

  // Liked tracks ("Мне нравится")
  async getLikedTracks() {
    if (!this.uid) await this.initSession()
    if (!this.uid) throw new Error('UID не удалось получить')
    const data = await this._apiGet(`/users/${this.uid}/likes/tracks`)
    const refs = data.result?.library?.tracks || []
    if (!refs.length) return { title: 'Мне нравится', tracks: [] }
    const ids = refs.map(r => (r.albumId ? `${r.id}:${r.albumId}` : String(r.id)))
    // Fetch full track info in chunks — the /tracks endpoint chokes on huge lists
    const tracks = []
    for (let i = 0; i < ids.length; i += 250) {
      const chunk = ids.slice(i, i + 250)
      const full = await this._apiPost('/tracks', { 'track-ids': chunk.join(',') })
      for (const t of (full.result || [])) {
        if (t && !t.error) tracks.push(this._mapTrack(t))
      }
    }
    return { title: 'Мне нравится', tracks }
  }

  // Lyrics. The modern endpoint needs an HMAC-SHA256 signature of
  // "<trackId><timestamp>" (key from the official client); it returns a
  // downloadUrl with the plain text. Old /supplement kept as fallback.
  // Lyrics require an HMAC-SHA256 signature of "<trackId><timestamp>" and the
  // Android client header — the server validates the sign against that client.
  async getLyrics(trackId) {
    const ts = Math.floor(Date.now() / 1000)
    const sign = crypto
      .createHmac('sha256', 'p93jhgh689SBReK6ghtw62')
      .update(`${trackId}${ts}`)
      .digest('base64')
    const raw = await this._apiGetRaw(
      `/tracks/${trackId}/lyrics?format=TEXT&timeStamp=${ts}&sign=${encodeURIComponent(sign)}`,
      'YandexMusicAndroid/24023621'
    )
    if (raw.status !== 200) return { text: '' }
    let data = {}
    try { data = JSON.parse(raw.body) } catch (_) {}
    const url = data.result?.downloadUrl
    if (!url) return { text: '' }
    const text = await this._fetchText(url)
    return { text: (text || '').trim() }
  }

  // Like _apiGet but returns { status, body } without throwing on bad JSON
  _apiGetRaw(apiPath, client = 'WindowsPhone/3.17') {
    return new Promise((resolve, reject) => {
      if (!this.token) { reject(new Error('Not authenticated')); return }
      const req = https.get({
        hostname: 'api.music.yandex.net',
        path: apiPath,
        headers: {
          Authorization:           `OAuth ${this.token}`,
          'X-Yandex-Music-Client': client,
          'User-Agent':            'YandexAmp/1.0',
        },
      }, res => {
        let data = ''
        res.on('data', c => (data += c))
        res.on('end', () => resolve({ status: res.statusCode, body: data }))
      })
      req.on('error', reject)
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('API timeout')) })
    })
  }

  // ===== LIKES / DISLIKES =====

  async getLikedIds() {
    if (!this.uid) await this.initSession()
    if (!this.uid) throw new Error('UID не удалось получить')
    const data = await this._apiGet(`/users/${this.uid}/likes/tracks`)
    return (data.result?.library?.tracks || []).map(r => String(r.id))
  }

  async likeTrack(trackId) {
    if (!this.uid) await this.initSession()
    return this._apiPost(`/users/${this.uid}/likes/tracks/add-multiple`, { 'track-ids': String(trackId) })
  }

  async unlikeTrack(trackId) {
    if (!this.uid) await this.initSession()
    return this._apiPost(`/users/${this.uid}/likes/tracks/remove`, { 'track-ids': String(trackId) })
  }

  async dislikeTrack(trackId) {
    if (!this.uid) await this.initSession()
    return this._apiPost(`/users/${this.uid}/dislikes/tracks/add-multiple`, { 'track-ids': String(trackId) })
  }

  // Wave (rotor) settings: moodEnergy: fun|active|calm|sad|all,
  // diversity: favorite|popular|discover|default, language: russian|not-russian|any
  async setWaveSettings({ moodEnergy = 'all', diversity = 'default', language = 'any' } = {}) {
    // The rotor settings endpoint expects a JSON body (form-encoded is ignored)
    const body = { moodEnergy, diversity, language, type: 'rotor' }
    try {
      return await this._apiPostJson('/rotor/station/user:onyourwave/settings3', body)
    } catch (_) {
      return await this._apiPostJson('/rotor/station/user:onyourwave/settings2', body)
    }
  }

  // "Моя волна" — personal radio; pull a few batches from the rotor.
  // Pass more=true to continue the stream from where the last call stopped.
  // Without station feedback the rotor keeps serving the same head of the
  // queue, so we also report radioStarted here and track events via
  // sendWaveFeedback() — that is what makes the stream personalised/endless.
  async getWaveTracks(more = false) {
    const tracks = []
    let queue = more ? (this._waveQueue || '') : ''
    for (let i = 0; i < 4; i++) {
      const q = queue ? `&queue=${queue}` : ''
      const data = await this._apiGet(`/rotor/station/user:onyourwave/tracks?settings2=true${q}`)
      const seq = data.result?.sequence || []
      if (data.result?.batchId) this._waveBatchId = data.result.batchId
      if (!seq.length) break
      for (const s of seq) {
        if (s.track) tracks.push(this._mapTrack(s.track))
      }
      queue = seq[seq.length - 1]?.track?.id || ''
      if (!queue) break
      if (i === 0 && !more) {
        // Fresh wave start — tell the rotor the station is playing
        await this.sendWaveFeedback('radioStarted').catch(() => {})
      }
    }
    this._waveQueue = queue
    // Rotor batches can repeat tracks — dedupe by id
    const seen = new Set()
    const unique = tracks.filter(t => !seen.has(t.id) && seen.add(t.id))
    return { title: 'Моя волна', tracks: unique }
  }

  // Rotor feedback: type = radioStarted | trackStarted | trackFinished | skip
  async sendWaveFeedback(type, trackId = null, playedSeconds = null) {
    const body = { type, timestamp: new Date().toISOString(), from: 'desktop_win-radio-user-onyourwave' }
    if (trackId) body.trackId = String(trackId)
    if (playedSeconds != null) body.totalPlayedSeconds = Math.round(playedSeconds)
    const batch = this._waveBatchId ? `?batch-id=${encodeURIComponent(this._waveBatchId)}` : ''
    return this._apiPostJson(`/rotor/station/user:onyourwave/feedback${batch}`, body)
  }

  setToken(token, uid = null) {
    this.token = token
    if (uid) this.uid = uid
  }

  // ===== SEARCH =====

  async search(query) {
    const data = await this._apiGet(
      `/search?type=track&text=${encodeURIComponent(query)}&page=0&nococrrect=false`
    )
    const results = data.result?.tracks?.results || []
    return results.map(t => this._mapTrack(t))
  }

  // ===== STREAM URL =====

  async getTrackUrl(trackId) {
    const infos = await this._apiGet(`/tracks/${trackId}/download-info`)
    const list  = infos?.result
    if (!list?.length) throw new Error('No download info returned')

    const mp3 = list
      .filter(i => i.codec === 'mp3' && !i.preview)
      .sort((a, b) => b.bitrateInKbps - a.bitrateInKbps)

    if (!mp3.length) throw new Error('No MP3 stream available for this track')

    const xml  = await this._fetchText(mp3[0].downloadInfoUrl)
    const info = this._parseXml(xml)

    const sign = crypto
      .createHash('md5')
      .update(MAGIC + info.path.slice(1) + info.s)
      .digest('hex')

    return `https://${info.host}/get-mp3/${sign}/${info.ts}${info.path}`
  }

  // ===== PRIVATE =====

  _mapTrack(tr) {
    return {
      id:       String(tr.id),
      title:    tr.title || 'Unknown',
      artist:   (tr.artists || []).map(a => a.name).join(', ') || 'Unknown',
      album:    tr.albums?.[0]?.title || '',
      duration: tr.durationMs || 0,
      coverUri: tr.coverUri || null,
    }
  }

  _parseXml(xml) {
    const get = tag => {
      const m = xml.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>'))
      return m ? m[1].trim() : ''
    }
    return { host: get('host'), path: get('path'), ts: get('ts'), s: get('s') }
  }

  _oauthPost(path, body) {
    return new Promise((resolve, reject) => {
      const bodyStr = new URLSearchParams(body).toString()
      const opts = {
        hostname: 'oauth.yandex.ru',
        path,
        method:   'POST',
        headers: {
          'Content-Type':   'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      }
      const req = https.request(opts, res => {
        let data = ''
        res.on('data', c => (data += c))
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            if (json.error) reject(new Error(json.error_description || json.error))
            else resolve(json)
          } catch {
            reject(new Error('Invalid OAuth response: ' + data.slice(0, 200)))
          }
        })
      })
      req.on('error', reject)
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Auth timeout')) })
      req.write(bodyStr)
      req.end()
    })
  }

  _apiGet(apiPath) {
    return new Promise((resolve, reject) => {
      if (!this.token) { reject(new Error('Not authenticated')); return }
      const opts = {
        hostname: 'api.music.yandex.net',
        path:     apiPath,
        headers: {
          Authorization:          `OAuth ${this.token}`,
          'X-Yandex-Music-Client': 'WindowsPhone/3.17',
          'User-Agent':            'YandexAmp/1.0',
        },
      }
      const req = https.get(opts, res => {
        let data = ''
        res.on('data', c => (data += c))
        res.on('end', () => {
          try { resolve(JSON.parse(data)) }
          catch { reject(new Error('Invalid API JSON, status ' + res.statusCode)) }
        })
      })
      req.on('error', reject)
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('API timeout')) })
    })
  }

  _apiPost(apiPath, form) {
    return new Promise((resolve, reject) => {
      if (!this.token) { reject(new Error('Not authenticated')); return }
      const bodyStr = new URLSearchParams(form).toString()
      const opts = {
        hostname: 'api.music.yandex.net',
        path:     apiPath,
        method:   'POST',
        headers: {
          Authorization:           `OAuth ${this.token}`,
          'X-Yandex-Music-Client': 'WindowsPhone/3.17',
          'User-Agent':            'YandexAmp/1.0',
          'Content-Type':          'application/x-www-form-urlencoded',
          'Content-Length':        Buffer.byteLength(bodyStr),
        },
      }
      const req = https.request(opts, res => {
        let data = ''
        res.on('data', c => (data += c))
        res.on('end', () => {
          try { resolve(JSON.parse(data)) }
          catch { reject(new Error('Invalid API JSON, status ' + res.statusCode)) }
        })
      })
      req.on('error', reject)
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('API timeout')) })
      req.write(bodyStr)
      req.end()
    })
  }

  _apiPostJson(apiPath, obj) {
    return new Promise((resolve, reject) => {
      if (!this.token) { reject(new Error('Not authenticated')); return }
      const bodyStr = JSON.stringify(obj)
      const opts = {
        hostname: 'api.music.yandex.net',
        path:     apiPath,
        method:   'POST',
        headers: {
          Authorization:           `OAuth ${this.token}`,
          'X-Yandex-Music-Client': 'WindowsPhone/3.17',
          'User-Agent':            'YandexAmp/1.0',
          'Content-Type':          'application/json',
          'Content-Length':        Buffer.byteLength(bodyStr),
        },
      }
      const req = https.request(opts, res => {
        let data = ''
        res.on('data', c => (data += c))
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data)
          else reject(new Error('Feedback HTTP ' + res.statusCode))
        })
      })
      req.on('error', reject)
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('API timeout')) })
      req.write(bodyStr)
      req.end()
    })
  }

  _fetchText(url, redirects = 0) {
    return new Promise((resolve, reject) => {
      const { hostname, pathname, search } = new URL(url)
      const req = https.get({ hostname, path: pathname + search }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
          res.resume()
          resolve(this._fetchText(new URL(res.headers.location, url).href, redirects + 1))
          return
        }
        let data = ''
        res.on('data', c => (data += c))
        res.on('end', () => resolve(data))
      })
      req.on('error', reject)
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Fetch timeout')) })
    })
  }
}

module.exports = YandexMusicService
