//! App-wide settings (issue #9).
//!
//! These are the preferences that belong to the app rather than to one PDF:
//! the binding direction and view mode a document opens with, and which
//! translation provider to ask (issue #10). They live in a single JSON file in
//! the OS config directory, written atomically like the sidecar files.
//!
//! API keys are deliberately *not* here — a settings file is plain text on
//! disk. They go in the OS keychain instead; see `keychain.rs`.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The schema version written to `settings.json`.
pub const SETTINGS_VERSION: u32 = 1;

const SETTINGS_FILE: &str = "settings.json";

/// Longest language tag accepted, which is what BCP-47 allows for one.
const MAX_LANGUAGE_TAG_LEN: usize = 35;

/// Longest model id accepted. Real ones are far shorter; this only keeps a
/// pasted paragraph out of the file.
const MAX_MODEL_ID_LEN: usize = 100;

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SettingsError {
    /// The platform gave no config directory to keep settings in.
    ConfigDirUnavailable {
        message: String,
    },
    Serialize {
        message: String,
    },
    Io {
        message: String,
    },
}

impl From<std::io::Error> for SettingsError {
    fn from(err: std::io::Error) -> Self {
        SettingsError::Io {
            message: err.to_string(),
        }
    }
}

type Result<T> = std::result::Result<T, SettingsError>;

// --- schema ---

/// Which edge a document is bound on. Right-bound books (most Japanese ones)
/// read back to front, so spreads and page turns are mirrored.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Binding {
    #[default]
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ViewMode {
    #[default]
    Single,
    Spread,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TranslationProvider {
    #[default]
    Claude,
    Openai,
    Deepl,
}

/// Every provider this build knows, in the order the settings screen lists
/// them. The keychain (`keychain.rs`) matches API keys against this same list.
pub const PROVIDERS: [TranslationProvider; 3] = [
    TranslationProvider::Claude,
    TranslationProvider::Openai,
    TranslationProvider::Deepl,
];

impl TranslationProvider {
    /// The id this provider is known by in the keychain and over the IPC
    /// boundary — the same string serde reads and writes.
    pub fn id(self) -> &'static str {
        match self {
            TranslationProvider::Claude => "claude",
            TranslationProvider::Openai => "openai",
            TranslationProvider::Deepl => "deepl",
        }
    }

    /// The provider an id names, or None. Ids arrive from the frontend and
    /// from a hand-edited settings file, so they are matched rather than
    /// trusted.
    pub fn from_id(id: &str) -> Option<Self> {
        PROVIDERS.into_iter().find(|provider| provider.id() == id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationSettings {
    pub provider: TranslationProvider,
    /// BCP-47 tag the reader wants translations in, e.g. `ja`.
    pub target_language: String,
    /// Model id per provider, e.g. `{"claude": "claude-opus-5"}`. Kept per
    /// provider rather than as one field so switching provider and back does
    /// not lose the choice. A provider with no entry uses whatever default the
    /// translation layer (issue #10) picks for it.
    #[serde(default)]
    pub models: BTreeMap<String, String>,
}

impl Default for TranslationSettings {
    fn default() -> Self {
        TranslationSettings {
            provider: TranslationProvider::default(),
            target_language: "ja".to_string(),
            models: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub version: u32,
    /// Binding a newly opened document starts on; it stays switchable per view.
    pub default_binding: Binding,
    pub default_view_mode: ViewMode,
    pub translation: TranslationSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            version: SETTINGS_VERSION,
            default_binding: Binding::default(),
            default_view_mode: ViewMode::default(),
            translation: TranslationSettings::default(),
        }
    }
}

// --- parsing ---

fn value_at<'a>(object: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    object?.as_object()?.get(key)
}

fn parsed<T: DeserializeOwned>(value: Option<&Value>) -> Option<T> {
    serde_json::from_value(value?.clone()).ok()
}

/// A language tag we are willing to hand to a provider: trimmed, non-empty and
/// no longer than BCP-47 allows. None for anything else, so the caller can fall
/// back to the default.
fn language_tag(raw: &str) -> Option<String> {
    let tag = raw.trim();
    if tag.is_empty() || tag.len() > MAX_LANGUAGE_TAG_LEN {
        return None;
    }
    Some(tag.to_string())
}

/// A model id worth storing: trimmed, non-empty, not absurdly long, and free
/// of inner whitespace. No model id has a space in it, so one that does is a
/// mis-paste — and it would fail at request time, far from where it was typed.
fn model_id(raw: &str) -> Option<String> {
    let id = raw.trim();
    if id.is_empty() || id.len() > MAX_MODEL_ID_LEN || id.contains(char::is_whitespace) {
        return None;
    }
    Some(id.to_string())
}

/// Keeps the entries that name a provider this build knows and carry a usable
/// model id; drops the rest. Also what an absent entry means: no model chosen.
fn models(entries: impl IntoIterator<Item = (String, String)>) -> BTreeMap<String, String> {
    entries
        .into_iter()
        .filter_map(|(provider, id)| {
            let provider = TranslationProvider::from_id(&provider)?;
            Some((provider.id().to_string(), model_id(&id)?))
        })
        .collect()
}

/// Reads `settings.json`, falling back per field rather than as a whole.
///
/// The file is hand-editable and outlives app upgrades, so a single bad value
/// — a typo, a setting an older build never knew — must not throw away every
/// other preference with it. Unknown keys are dropped on the next write.
pub fn parse_settings(raw: &str) -> Settings {
    let root = serde_json::from_str::<Value>(raw).ok();
    let translation = value_at(root.as_ref(), "translation");
    let defaults = Settings::default();

    Settings {
        // Always ours: what is written back is written by this build.
        version: SETTINGS_VERSION,
        default_binding: parsed(value_at(root.as_ref(), "defaultBinding"))
            .unwrap_or(defaults.default_binding),
        default_view_mode: parsed(value_at(root.as_ref(), "defaultViewMode"))
            .unwrap_or(defaults.default_view_mode),
        translation: TranslationSettings {
            provider: parsed(value_at(translation, "provider"))
                .unwrap_or(defaults.translation.provider),
            target_language: parsed::<String>(value_at(translation, "targetLanguage"))
                .as_deref()
                .and_then(language_tag)
                .unwrap_or(defaults.translation.target_language),
            models: models(
                parsed::<BTreeMap<String, String>>(value_at(translation, "models"))
                    .unwrap_or_default(),
            ),
        },
    }
}

/// The settings as this build would store them: the fields it knows, at its own
/// version, with the language tag tidied up. What `save_settings` writes and
/// hands back, so the file and the UI agree on what was actually kept.
pub fn normalize(settings: &Settings) -> Settings {
    let defaults = Settings::default();
    Settings {
        version: SETTINGS_VERSION,
        default_binding: settings.default_binding,
        default_view_mode: settings.default_view_mode,
        translation: TranslationSettings {
            provider: settings.translation.provider,
            target_language: language_tag(&settings.translation.target_language)
                .unwrap_or(defaults.translation.target_language),
            models: models(settings.translation.models.clone()),
        },
    }
}

pub fn serialize_settings(settings: &Settings) -> Result<Vec<u8>> {
    let mut json = serde_json::to_vec_pretty(settings).map_err(|err| SettingsError::Serialize {
        message: err.to_string(),
    })?;
    json.push(b'\n');
    Ok(json)
}

// --- storage ---

/// Writes via a same-directory tmp file + atomic replace, so a crash never
/// leaves a half-written settings file behind (same approach as `sidecar.rs`).
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path.parent().ok_or_else(|| SettingsError::Io {
        message: format!("no parent directory for {}", path.display()),
    })?;
    fs::create_dir_all(dir)?;
    let mut tmp = tempfile::Builder::new()
        .prefix(".papyrus-tmp-")
        .tempfile_in(dir)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|err| SettingsError::Io {
        message: err.error.to_string(),
    })?;
    Ok(())
}

pub fn load_settings_from(path: &Path) -> Result<Settings> {
    match fs::read_to_string(path) {
        Ok(raw) => Ok(parse_settings(&raw)),
        // No file yet simply means nothing has been changed from the defaults.
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(err) => Err(err.into()),
    }
}

pub fn save_settings_to(path: &Path, settings: &Settings) -> Result<Settings> {
    // Normalized before it is stored: a value this build would refuse to read
    // back is not worth writing in the first place.
    let normalized = normalize(settings);
    atomic_write(path, &serialize_settings(&normalized)?)?;
    Ok(normalized)
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    use tauri::Manager as _;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| SettingsError::ConfigDirUnavailable {
            message: err.to_string(),
        })?;
    Ok(dir.join(SETTINGS_FILE))
}

// --- Tauri commands ---

#[tauri::command]
pub fn load_settings(app: tauri::AppHandle) -> Result<Settings> {
    load_settings_from(&settings_path(&app)?)
}

/// Returns the settings as they were stored, which is what the UI should show:
/// a value the backend normalized away would otherwise linger on screen until
/// the next launch.
#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<Settings> {
    save_settings_to(&settings_path(&app)?, &settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Settings {
        Settings {
            version: SETTINGS_VERSION,
            default_binding: Binding::Right,
            default_view_mode: ViewMode::Spread,
            translation: TranslationSettings {
                provider: TranslationProvider::Deepl,
                target_language: "en-US".to_string(),
                models: BTreeMap::from([("claude".to_string(), "claude-opus-5".to_string())]),
            },
        }
    }

    #[test]
    fn defaults_are_left_bound_single_page_japanese_claude() {
        let settings = Settings::default();
        assert_eq!(settings.version, SETTINGS_VERSION);
        assert_eq!(settings.default_binding, Binding::Left);
        assert_eq!(settings.default_view_mode, ViewMode::Single);
        assert_eq!(settings.translation.provider, TranslationProvider::Claude);
        assert_eq!(settings.translation.target_language, "ja");
        // No model chosen: the translation layer picks the provider's own.
        assert!(settings.translation.models.is_empty());
    }

    #[test]
    fn parse_keeps_a_model_per_provider() {
        let settings = parse_settings(
            r#"{
                "translation": {
                    "models": {
                        "claude": "  claude-opus-5  ",
                        "openai": "some-model"
                    }
                }
            }"#,
        );

        assert_eq!(
            settings.translation.models,
            BTreeMap::from([
                ("claude".to_string(), "claude-opus-5".to_string()),
                ("openai".to_string(), "some-model".to_string()),
            ]),
        );
    }

    #[test]
    fn parse_drops_unusable_model_entries_and_keeps_the_rest() {
        let too_long = "m".repeat(MAX_MODEL_ID_LEN + 1);
        let settings = parse_settings(&format!(
            r#"{{
                "translation": {{
                    "models": {{
                        "claude": "claude-sonnet-5",
                        "gemini": "gemini-pro",
                        "openai": "   ",
                        "deepl": "{too_long}"
                    }}
                }}
            }}"#,
        ));

        assert_eq!(
            settings.translation.models,
            BTreeMap::from([("claude".to_string(), "claude-sonnet-5".to_string())]),
            "unknown provider, blank and over-long ids are all dropped",
        );
    }

    #[test]
    fn parse_drops_a_model_id_with_inner_whitespace() {
        // A mis-paste that would only fail later, at request time.
        let settings =
            parse_settings(r#"{ "translation": { "models": { "claude": "claude opus 5" } } }"#);

        assert!(settings.translation.models.is_empty());
    }

    #[test]
    fn parse_survives_a_models_field_that_is_not_an_object() {
        for raw in [
            r#"{ "translation": { "models": "claude-opus-5" } }"#,
            r#"{ "translation": { "models": ["claude-opus-5"] } }"#,
            r#"{ "translation": { "models": { "claude": 5 } } }"#,
        ] {
            let settings = parse_settings(raw);
            assert!(settings.translation.models.is_empty(), "raw: {raw}");
            assert_eq!(settings.translation.target_language, "ja");
        }
    }

    #[test]
    fn parse_round_trips_serialized_settings() {
        let json = String::from_utf8(serialize_settings(&sample()).unwrap()).unwrap();
        assert_eq!(parse_settings(&json), sample());
    }

    #[test]
    fn parse_falls_back_to_defaults_for_broken_json() {
        for raw in ["", "not json", "[]", "null", "42"] {
            assert_eq!(parse_settings(raw), Settings::default(), "raw: {raw:?}");
        }
    }

    #[test]
    fn parse_keeps_the_valid_fields_around_a_bad_one() {
        let settings = parse_settings(
            r#"{
                "version": 1,
                "defaultBinding": "sideways",
                "defaultViewMode": "spread",
                "translation": { "provider": 7, "targetLanguage": "en" }
            }"#,
        );
        assert_eq!(settings.default_binding, Binding::Left);
        assert_eq!(settings.default_view_mode, ViewMode::Spread);
        assert_eq!(settings.translation.provider, TranslationProvider::Claude);
        assert_eq!(settings.translation.target_language, "en");
    }

    #[test]
    fn parse_ignores_a_version_written_by_another_build() {
        let settings = parse_settings(r#"{ "version": 99, "defaultBinding": "right" }"#);
        assert_eq!(settings.version, SETTINGS_VERSION);
        assert_eq!(settings.default_binding, Binding::Right);
    }

    #[test]
    fn parse_trims_the_language_tag_and_rejects_unusable_ones() {
        assert_eq!(
            parse_settings(r#"{ "translation": { "targetLanguage": "  ja-JP  " } }"#)
                .translation
                .target_language,
            "ja-JP",
        );
        let too_long = "x".repeat(MAX_LANGUAGE_TAG_LEN + 1);
        for raw in [
            r#"{ "translation": { "targetLanguage": "   " } }"#.to_string(),
            r#"{ "translation": { "targetLanguage": null } }"#.to_string(),
            format!(r#"{{ "translation": {{ "targetLanguage": "{too_long}" }} }}"#),
        ] {
            assert_eq!(
                parse_settings(&raw).translation.target_language,
                "ja",
                "raw: {raw}",
            );
        }
    }

    #[test]
    fn load_returns_defaults_when_the_file_does_not_exist() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        assert_eq!(load_settings_from(&path).unwrap(), Settings::default());
        assert!(!path.exists(), "loading must not create the file");
    }

    #[test]
    fn save_then_load_returns_what_was_saved() {
        let dir = tempfile::tempdir().unwrap();
        // A directory Tauri would have created on first launch; saving has to
        // work before it exists.
        let path = dir.path().join("papyrus").join("settings.json");

        assert_eq!(save_settings_to(&path, &sample()).unwrap(), sample());
        assert_eq!(load_settings_from(&path).unwrap(), sample());
    }

    #[test]
    fn save_normalizes_what_it_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let untidy = Settings {
            version: 99,
            translation: TranslationSettings {
                target_language: "  fr  ".to_string(),
                models: BTreeMap::from([
                    ("claude".to_string(), " claude-opus-5 ".to_string()),
                    ("gemini".to_string(), "gemini-pro".to_string()),
                ]),
                ..TranslationSettings::default()
            },
            ..sample()
        };

        let stored = save_settings_to(&path, &untidy).unwrap();

        assert_eq!(stored.version, SETTINGS_VERSION);
        assert_eq!(stored.translation.target_language, "fr");
        assert_eq!(
            stored.translation.models,
            BTreeMap::from([("claude".to_string(), "claude-opus-5".to_string())]),
        );
        assert_eq!(load_settings_from(&path).unwrap(), stored);
    }

    #[test]
    fn save_leaves_no_tmp_files_behind() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");

        save_settings_to(&path, &sample()).unwrap();
        save_settings_to(&path, &Settings::default()).unwrap();

        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![SETTINGS_FILE.to_string()]);
    }

    #[test]
    fn provider_ids_match_their_serialized_form() {
        for provider in [
            TranslationProvider::Claude,
            TranslationProvider::Openai,
            TranslationProvider::Deepl,
        ] {
            assert_eq!(
                serde_json::to_value(provider).unwrap(),
                Value::String(provider.id().to_string()),
            );
        }
    }
}
