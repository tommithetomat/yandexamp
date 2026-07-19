const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    close: () => ipcRenderer.invoke('window:close'),
    setHeight: (h) => ipcRenderer.invoke('window:setHeight', h),
    setWidth: (w) => ipcRenderer.invoke('window:setWidth', w),
    setPin: (on) => ipcRenderer.invoke('window:setPin', on),
  },
  media: {
    onCmd: (cb) => ipcRenderer.on('media:cmd', (_, cmd) => cb(cmd)),
  },
  app: {
    checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
    openReleases: (url) => ipcRenderer.invoke('app:openReleases', url),
  },
  yandex: {
    restoreSession: () => ipcRenderer.invoke('yandex:restoreSession'),
    login: (username, password) => ipcRenderer.invoke('yandex:login', { username, password }),
    loginWithToken: (token) => ipcRenderer.invoke('yandex:loginWithToken', { token }),
    loginBrowser: () => ipcRenderer.invoke('yandex:loginBrowser'),
    search: (query) => ipcRenderer.invoke('yandex:search', { query }),
    getTrackUrl: (trackId) => ipcRenderer.invoke('yandex:getTrackUrl', { trackId }),
    getPlaylists: () => ipcRenderer.invoke('yandex:getPlaylists'),
    getSmartPlaylists: () => ipcRenderer.invoke('yandex:getSmartPlaylists'),
    getLikedTracks: () => ipcRenderer.invoke('yandex:getLikedTracks'),
    getWaveTracks: (more = false) => ipcRenderer.invoke('yandex:getWaveTracks', { more }),
    getLikedIds: () => ipcRenderer.invoke('yandex:getLikedIds'),
    likeTrack: (trackId) => ipcRenderer.invoke('yandex:likeTrack', { trackId }),
    unlikeTrack: (trackId) => ipcRenderer.invoke('yandex:unlikeTrack', { trackId }),
    dislikeTrack: (trackId) => ipcRenderer.invoke('yandex:dislikeTrack', { trackId }),
    setWaveSettings: (settings) => ipcRenderer.invoke('yandex:setWaveSettings', settings),
    waveFeedback: (type, trackId, playedSeconds) => ipcRenderer.invoke('yandex:waveFeedback', { type, trackId, playedSeconds }),
    getPlaylistTracks: (uid, kind) => ipcRenderer.invoke('yandex:getPlaylistTracks', { uid, kind }),
    getLyrics: (trackId) => ipcRenderer.invoke('yandex:getLyrics', { trackId }),
  },
})
