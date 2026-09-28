// Declaring the app's commands makes each one a permission: nothing is callable
// unless capabilities/ grants it to a specific window.
const COMMANDS: &[&str] = &[
    "restore_session",
    "login_password",
    "login_token",
    "login_browser",
    "logout",
    "search",
    "track_stream_url",
    "prefetch_track",
    "refresh_tracks",
    "get_playlists",
    "get_smart_playlists",
    "get_liked_tracks",
    "get_liked_ids",
    "like_track",
    "unlike_track",
    "dislike_track",
    "set_wave_settings",
    "get_wave_tracks",
    "wave_feedback",
    "get_playlist_tracks",
    "get_lyrics",
    "get_stations_list",
    "get_station_tracks",
    "get_track_radio",
    "get_chart",
    "get_new_releases",
    "get_play_history",
    "get_artist",
    "get_album_tracks",
    "check_update",
    "open_releases",
    "win_set_height",
    "win_set_width",
    "win_layout",
    "win_set_pin",
    "win_hide",
    "win_close",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
