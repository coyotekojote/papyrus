pub mod bookmarks;
pub mod keychain;
pub mod settings;
pub mod sidecar;
pub mod translation;

/// Builds a friendly greeting for the given name.
///
/// Trimmed of surrounding whitespace; falls back to "World" when empty.
fn build_greeting(name: &str) -> String {
    let trimmed = name.trim();
    let subject = if trimmed.is_empty() { "World" } else { trimmed };
    format!("Hello, {subject}! You've been greeted from Rust!")
}

#[tauri::command]
fn greet(name: &str) -> String {
    build_greeting(name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            bookmarks::create_bookmark,
            bookmarks::resolve_bookmark,
            sidecar::load_annotations,
            sidecar::save_annotations,
            sidecar::load_notes,
            sidecar::save_notes,
            sidecar::save_clip,
            sidecar::load_clip,
            sidecar::sidecar_status,
            settings::load_settings,
            settings::save_settings,
            keychain::save_api_key,
            keychain::delete_api_key,
            keychain::api_key_status,
            translation::translate,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_greeting_uses_the_given_name() {
        assert_eq!(
            build_greeting("Papyrus"),
            "Hello, Papyrus! You've been greeted from Rust!"
        );
    }

    #[test]
    fn build_greeting_trims_surrounding_whitespace() {
        assert_eq!(
            build_greeting("  Ada  "),
            "Hello, Ada! You've been greeted from Rust!"
        );
    }

    #[test]
    fn build_greeting_falls_back_to_world_when_blank() {
        assert_eq!(
            build_greeting("   "),
            "Hello, World! You've been greeted from Rust!"
        );
        assert_eq!(
            build_greeting(""),
            "Hello, World! You've been greeted from Rust!"
        );
    }
}
