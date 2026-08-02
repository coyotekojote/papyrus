//! API key storage in the OS keychain (issue #9).
//!
//! Translation providers need an API key, and a key is the one thing in this
//! app that must not sit in a plain file: `settings.json` is world-readable
//! text that iCloud or a backup would happily copy around. Keys go to the OS
//! keychain (Keychain Services on macOS/iOS, Credential Manager on Windows,
//! the Secret Service on Linux) instead.
//!
//! The WebView never sees a key. It can write one, delete one, and ask whether
//! one is configured — nothing here ever returns a key to the frontend. The
//! translation layer (issue #10) reads them on the Rust side, where the HTTP
//! call is made anyway.

use serde::Serialize;

use crate::settings::{TranslationProvider, PROVIDERS};

/// Keychain service name, shared by every provider entry. Matches the bundle
/// identifier so the entries are recognizable in Keychain Access.
const SERVICE: &str = "com.coyotekojote.papyrus";

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum KeychainError {
    /// An id that names no provider this build knows.
    UnknownProvider { provider: String },
    /// A blank key would look "configured" while failing every request.
    EmptyKey,
    /// The keychain itself refused: locked, denied by the user, unavailable.
    Keychain { message: String },
}

type Result<T> = std::result::Result<T, KeychainError>;

/// Whether a provider has a key stored — never the key itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyStatus {
    pub provider: String,
    pub configured: bool,
}

/// The keychain operations this module needs, so the command layer can be
/// tested without touching (or prompting) the real one.
pub trait KeyStore {
    fn set(&self, provider: TranslationProvider, key: &str) -> Result<()>;
    /// Removes the entry; missing is success, so deleting twice is harmless.
    fn delete(&self, provider: TranslationProvider) -> Result<()>;
    fn contains(&self, provider: TranslationProvider) -> Result<bool>;
}

/// The real OS keychain.
pub struct OsKeychain;

impl OsKeychain {
    fn entry(provider: TranslationProvider) -> Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, provider.id()).map_err(into_error)
    }
}

fn into_error(err: keyring::Error) -> KeychainError {
    KeychainError::Keychain {
        message: err.to_string(),
    }
}

impl KeyStore for OsKeychain {
    fn set(&self, provider: TranslationProvider, key: &str) -> Result<()> {
        Self::entry(provider)?.set_password(key).map_err(into_error)
    }

    fn delete(&self, provider: TranslationProvider) -> Result<()> {
        match Self::entry(provider)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(into_error(err)),
        }
    }

    /// Asks the keychain for the entry's *attributes*, never its data.
    ///
    /// Reading a key's value is what makes macOS put an "allow access?" prompt
    /// in front of the app, and it re-asks whenever the binary's signature
    /// changes — which, for a development build, is every rebuild. Answering
    /// "is a key set?" needs none of that: a search that does not ask for the
    /// data is not access to the secret, and never prompts.
    #[cfg(target_vendor = "apple")]
    fn contains(&self, provider: TranslationProvider) -> Result<bool> {
        use security_framework::item::{ItemClass, ItemSearchOptions};
        use security_framework_sys::base::errSecItemNotFound;

        let found = ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .service(SERVICE)
            .account(provider.id())
            .load_attributes(true)
            .search();
        match found {
            Ok(results) => Ok(!results.is_empty()),
            Err(err) if err.code() == errSecItemNotFound => Ok(false),
            Err(err) => Err(KeychainError::Keychain {
                message: err.to_string(),
            }),
        }
    }

    /// Elsewhere the password is read and dropped: those platforms either do
    /// not gate reads behind a prompt, or offer no cheaper presence check.
    #[cfg(not(target_vendor = "apple"))]
    fn contains(&self, provider: TranslationProvider) -> Result<bool> {
        match Self::entry(provider)?.get_password() {
            Ok(_) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(err) => Err(into_error(err)),
        }
    }
}

/// The provider an id names, or `UnknownProvider`. Ids arrive from the
/// frontend, so they are matched against the list rather than trusted.
fn provider_from_id(id: &str) -> Result<TranslationProvider> {
    TranslationProvider::from_id(id).ok_or_else(|| KeychainError::UnknownProvider {
        provider: id.to_string(),
    })
}

pub fn save_api_key_in(store: &dyn KeyStore, provider_id: &str, key: &str) -> Result<()> {
    let provider = provider_from_id(provider_id)?;
    // Copying a key out of a dashboard picks up whitespace; a key with a
    // newline glued to it fails in a way nobody can see.
    let key = key.trim();
    if key.is_empty() {
        return Err(KeychainError::EmptyKey);
    }
    store.set(provider, key)
}

pub fn delete_api_key_in(store: &dyn KeyStore, provider_id: &str) -> Result<()> {
    store.delete(provider_from_id(provider_id)?)
}

pub fn api_key_status_in(store: &dyn KeyStore) -> Result<Vec<ApiKeyStatus>> {
    PROVIDERS
        .into_iter()
        .map(|provider| {
            Ok(ApiKeyStatus {
                provider: provider.id().to_string(),
                configured: store.contains(provider)?,
            })
        })
        .collect()
}

// --- Tauri commands ---

#[tauri::command]
pub fn save_api_key(provider: String, key: String) -> Result<()> {
    save_api_key_in(&OsKeychain, &provider, &key)
}

#[tauri::command]
pub fn delete_api_key(provider: String) -> Result<()> {
    delete_api_key_in(&OsKeychain, &provider)
}

/// Which providers have a key, for the settings screen. Only the flags cross
/// the IPC boundary.
#[tauri::command]
pub fn api_key_status() -> Result<Vec<ApiKeyStatus>> {
    api_key_status_in(&OsKeychain)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// Stands in for the OS keychain. Not thread-safe, which is all a
    /// single-threaded test needs.
    #[derive(Default)]
    struct FakeStore {
        keys: RefCell<HashMap<&'static str, String>>,
        /// When set, every operation fails with it — a locked keychain.
        failure: Option<&'static str>,
    }

    impl FakeStore {
        fn locked() -> Self {
            FakeStore {
                failure: Some("keychain is locked"),
                ..FakeStore::default()
            }
        }

        fn check(&self) -> Result<()> {
            match self.failure {
                Some(message) => Err(KeychainError::Keychain {
                    message: message.to_string(),
                }),
                None => Ok(()),
            }
        }

        fn stored(&self, provider: TranslationProvider) -> Option<String> {
            self.keys.borrow().get(provider.id()).cloned()
        }
    }

    impl KeyStore for FakeStore {
        fn set(&self, provider: TranslationProvider, key: &str) -> Result<()> {
            self.check()?;
            self.keys
                .borrow_mut()
                .insert(provider.id(), key.to_string());
            Ok(())
        }

        fn delete(&self, provider: TranslationProvider) -> Result<()> {
            self.check()?;
            self.keys.borrow_mut().remove(provider.id());
            Ok(())
        }

        fn contains(&self, provider: TranslationProvider) -> Result<bool> {
            self.check()?;
            Ok(self.keys.borrow().contains_key(provider.id()))
        }
    }

    #[test]
    fn saving_stores_the_key_under_the_provider_id() {
        let store = FakeStore::default();

        save_api_key_in(&store, "openai", "sk-test-123").unwrap();

        assert_eq!(
            store.stored(TranslationProvider::Openai).as_deref(),
            Some("sk-test-123"),
        );
        assert_eq!(store.stored(TranslationProvider::Claude), None);
    }

    #[test]
    fn saving_trims_whitespace_around_a_pasted_key() {
        let store = FakeStore::default();

        save_api_key_in(&store, "claude", "  sk-ant-123\n").unwrap();

        assert_eq!(
            store.stored(TranslationProvider::Claude).as_deref(),
            Some("sk-ant-123"),
        );
    }

    #[test]
    fn saving_a_blank_key_is_refused_and_stores_nothing() {
        let store = FakeStore::default();

        for blank in ["", "   ", "\n\t"] {
            assert!(
                matches!(
                    save_api_key_in(&store, "deepl", blank),
                    Err(KeychainError::EmptyKey)
                ),
                "expected EmptyKey for {blank:?}",
            );
        }
        assert_eq!(store.stored(TranslationProvider::Deepl), None);
    }

    #[test]
    fn an_unknown_provider_is_refused_by_every_operation() {
        let store = FakeStore::default();

        for result in [
            save_api_key_in(&store, "gemini", "key"),
            delete_api_key_in(&store, "gemini"),
        ] {
            assert!(
                matches!(result, Err(KeychainError::UnknownProvider { provider }) if provider == "gemini"),
            );
        }
        assert!(store.keys.borrow().is_empty());
    }

    #[test]
    fn deleting_removes_only_that_provider_and_is_idempotent() {
        let store = FakeStore::default();
        save_api_key_in(&store, "claude", "a").unwrap();
        save_api_key_in(&store, "deepl", "b").unwrap();

        delete_api_key_in(&store, "claude").unwrap();
        // Deleting what is no longer there is not an error: the reader who
        // clicks twice has the state they asked for either way.
        delete_api_key_in(&store, "claude").unwrap();

        assert_eq!(store.stored(TranslationProvider::Claude), None);
        assert_eq!(
            store.stored(TranslationProvider::Deepl).as_deref(),
            Some("b")
        );
    }

    #[test]
    fn status_reports_every_provider_without_revealing_a_key() {
        let store = FakeStore::default();
        save_api_key_in(&store, "openai", "sk-test-123").unwrap();

        let status = api_key_status_in(&store).unwrap();

        assert_eq!(
            status,
            vec![
                ApiKeyStatus {
                    provider: "claude".into(),
                    configured: false,
                },
                ApiKeyStatus {
                    provider: "openai".into(),
                    configured: true,
                },
                ApiKeyStatus {
                    provider: "deepl".into(),
                    configured: false,
                },
            ],
        );
        let json = serde_json::to_string(&status).unwrap();
        assert!(!json.contains("sk-test-123"), "the key leaked into {json}");
    }

    #[test]
    fn a_locked_keychain_surfaces_as_an_error_rather_than_a_false_status() {
        let store = FakeStore::locked();

        assert!(matches!(
            api_key_status_in(&store),
            Err(KeychainError::Keychain { .. })
        ));
        assert!(matches!(
            save_api_key_in(&store, "claude", "key"),
            Err(KeychainError::Keychain { .. })
        ));
    }
}
