const COMMANDS: &[&str] = &[
    "greet",
    "create_bookmark",
    "resolve_bookmark",
    "load_annotations",
    "save_annotations",
    "load_notes",
    "save_notes",
    "save_clip",
    "load_clip",
    "sidecar_status",
    "load_settings",
    "save_settings",
    "save_api_key",
    "delete_api_key",
    "api_key_status",
    "translate",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
