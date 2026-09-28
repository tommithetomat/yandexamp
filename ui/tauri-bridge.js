// Tauri bridge: exposes the same window.api as the Electron preload, so the
// renderer runs unchanged on both engines. The Yandex token never reaches this
// side — every call goes to the Rust backend, which alone holds it.
(function () {
  'use strict'
  if (window.api || !window.__TAURI__) return // Electron preload or plain browser

  const { invoke } = window.__TAURI__.core
  const { listen } = window.__TAURI__.event
  const message = (e) => (typeof e === 'string' ? e : (e && e.message) || String(e))
  const data = (cmd, args) =>
    invoke(cmd, args).then((d) => ({ success: true, data: d }), (e) => ({ success: false, error: message(e) }))
  const ok = (cmd, args) =>
    invoke(cmd, args).then(() => ({ success: true }), (e) => ({ success: false, error: message(e) }))
  const id = (v) => String(v)

  window.api = {
    window: {
      minimize: () => invoke('win_hide'),
      close: () => invoke('win_close'),
      setHeight: (height) => invoke('win_set_height', { height }),
      setWidth: (width) => invoke('win_set_width', { width }),
      setPin: (on) => invoke('win_set_pin', { on: !!on }),
      layout: (mode) => invoke('win_layout', { mode }),
    },
    media: {
      onCmd: (cb) => { listen('media-cmd', (e) => cb(e.payload)) },
    },
    app: {
      checkUpdate: () => invoke('check_update').catch(() => ({ newer: false })),
      openReleases: (url) => invoke('open_releases', { url: String(url || '') }),
    },
    yandex: {
      restoreSession: () => invoke('restore_session').then((s) => ({ success: !!s }), () => ({ success: false })),
      login: (username, password) => ok('login_password', { username, password }),
      loginWithToken: (token) => ok('login_token', { token }),
      loginBrowser: () => ok('login_browser'),
      logout: () => ok('logout'),
      search: (query) => data('search', { query }),
      getTrackUrl: (trackId) =>
        invoke('track_stream_url', { trackId: id(trackId) })
          .then((url) => ({ success: true, url }), (e) => ({ success: false, error: message(e) })),
      prefetch: (trackId) => ok('prefetch_track', { trackId: id(trackId) }),
      refreshTracks: (ids) => data('refresh_tracks', { ids: ids.map(id) }),
      getPlaylists: () => data('get_playlists'),
      getSmartPlaylists: () => data('get_smart_playlists'),
      getLikedTracks: () => data('get_liked_tracks'),
      getWaveTracks: (more = false) => data('get_wave_tracks', { more: !!more }),
      getLikedIds: () => data('get_liked_ids'),
      likeTrack: (trackId) => ok('like_track', { trackId: id(trackId) }),
      unlikeTrack: (trackId) => ok('unlike_track', { trackId: id(trackId) }),
      dislikeTrack: (trackId) => ok('dislike_track', { trackId: id(trackId) }),
      setWaveSettings: (s = {}) => ok('set_wave_settings', {
        moodEnergy: s.moodEnergy || 'all',
        diversity: s.diversity || 'default',
        language: s.language || 'any',
      }),
      waveFeedback: (type, trackId, playedSeconds) => ok('wave_feedback', {
        kind: type,
        trackId: trackId == null ? null : id(trackId),
        playedSeconds: playedSeconds == null ? null : Number(playedSeconds),
      }),
      getPlaylistTracks: (uid, kind) => data('get_playlist_tracks', { uid: id(uid), kind: Number(kind) }),
      getLyrics: (trackId) => data('get_lyrics', { trackId: id(trackId) }),
      getStationsList: () => data('get_stations_list'),
      getStationTracks: (stationId) => data('get_station_tracks', { stationId: id(stationId) }),
      getTrackRadio: (trackId) => data('get_track_radio', { trackId: id(trackId) }),
      getChart: () => data('get_chart'),
      getNewReleases: () => data('get_new_releases'),
      getPlayHistory: () => data('get_play_history'),
      getArtist: (artistId) => data('get_artist', { artistId: id(artistId) }),
      getAlbumTracks: (albumId) => data('get_album_tracks', { albumId: id(albumId) }),
    },
  }

  // Frameless window: drag it by the titlebar (Electron used -webkit-app-region)
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !e.target.closest('.drag')) return
    if (e.target.closest('button, input, select, a, label, form')) return
    window.__TAURI__.window.getCurrentWindow().startDragging()
  })
})()
