const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    close: () => ipcRenderer.invoke('window:close'),
    setHeight: (h) => ipcRenderer.invoke('window:setHeight', h),
  },
  yandex: {
    login: (username, password) => ipcRenderer.invoke('yandex:login', { username, password }),
    loginWithToken: (token) => ipcRenderer.invoke('yandex:loginWithToken', { token }),
    loginBrowser: () => ipcRenderer.invoke('yandex:loginBrowser'),
    search: (query) => ipcRenderer.invoke('yandex:search', { query }),
    getTrackUrl: (trackId) => ipcRenderer.invoke('yandex:getTrackUrl', { trackId }),
    getPlaylists: () => ipcRenderer.invoke('yandex:getPlaylists'),
    getSmartPlaylists: () => ipcRenderer.invoke('yandex:getSmartPlaylists'),
    getLikedTracks: () => ipcRenderer.invoke('yandex:getLikedTracks'),
    getWaveTracks: (more = false) => ipcRenderer.invoke('yandex:getWaveTracks', { more }),
    getPlaylistTracks: (uid, kind) => ipcRenderer.invoke('yandex:getPlaylistTracks', { uid, kind }),
  },
})
