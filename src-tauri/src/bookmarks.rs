//! Security-scoped bookmarks for iOS (issue #11).
//!
//! The document picker hands back a `file://` URL that plugin-fs can read
//! for the rest of the session (it calls `startAccessingSecurityScopedResource`
//! itself when it opens a `file://` URL), but that access does not survive a
//! relaunch. Recent files opened once from iCloud Drive or another app's
//! sandbox would otherwise go permanently missing the next time Papyrus
//! starts.
//!
//! Neither plugin-dialog nor plugin-fs exposes the bookmark APIs that solve
//! this (`NSURL bookmarkData` / `URL(resolvingBookmarkData:)`), so this module
//! calls them directly through objc2 — the same technique plugin-fs's own
//! `ios.rs` uses elsewhere in the same codebase for NSURL.
//!
//! Every other platform has no equivalent sandbox to work around: a path
//! opened once keeps working for as long as the file stays put, which is what
//! `create_bookmark`/`resolve_bookmark` returning `None` preserves — the
//! frontend falls back to the plain saved path (see `src/files/open.ts`).

use base64::{engine::general_purpose::STANDARD, Engine as _};

/// Encodes bookmark bytes as base64 so they can sit next to a recent-files
/// entry as plain text (see `RecentFile.bookmark` in `src/files/recent.ts`).
///
/// Only the iOS `imp` below calls this outside of tests; off iOS it is dead
/// code by design (`allow`ed below) so the encoding itself still has a test
/// that runs on every platform, including this development machine, which
/// has no iOS target to run tests on.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
fn encode_bookmark(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

/// The inverse of [`encode_bookmark`], same reasoning.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
fn decode_bookmark(bookmark: &str) -> Result<Vec<u8>, base64::DecodeError> {
    STANDARD.decode(bookmark)
}

#[cfg(target_os = "ios")]
mod imp {
    use objc2::rc::Retained;
    use objc2::runtime::Bool;
    use objc2_foundation::{
        NSData, NSString, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions, NSURL,
    };

    use super::{decode_bookmark, encode_bookmark};

    pub fn create_bookmark(path: &str) -> Result<Option<String>, String> {
        let ns_path = NSString::from_str(path);
        let url = NSURL::fileURLWithPath(&ns_path);
        // macOS's `.withSecurityScope` creation option is not available on
        // iOS (there is no separate sandbox extension to request it for): an
        // iOS app is sandboxed as a whole, so a plain bookmark is enough.
        let options = NSURLBookmarkCreationOptions::empty();
        let data: Retained<NSData> = url
            .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
                options, None, None,
            )
            .map_err(|err| err.to_string())?;
        Ok(Some(encode_bookmark(&data.to_vec())))
    }

    pub fn resolve_bookmark(bookmark: &str) -> Result<Option<String>, String> {
        let bytes = decode_bookmark(bookmark).map_err(|err| err.to_string())?;
        let data = NSData::from_vec(bytes);
        let options = NSURLBookmarkResolutionOptions::empty();
        // A stale bookmark (the file moved within its container, an iCloud
        // sync relocated it, …) still resolves to a URL here; this module
        // does not read the staleness flag or re-create the bookmark from
        // it — recreating is left to the frontend's normal "open again"
        // path, which already handles a bookmark that turns out not to work.
        let mut stale = Bool::NO;
        let url: Retained<NSURL> = unsafe {
            NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
                &data,
                options,
                None,
                &mut stale as *mut Bool,
            )
        }
        .map_err(|err| err.to_string())?;

        // Only a successful start makes the resolved path actually readable.
        // `stop` is deliberately never called: plugin-fs's own iOS support
        // takes the same position (see its `ios.rs`) — the scope is released
        // when the app process ends, and stopping here could cut off a read
        // that is still in flight elsewhere in the same session.
        if !unsafe { url.startAccessingSecurityScopedResource() } {
            return Err("failed to access the security-scoped resource".to_string());
        }

        let resolved = url
            .absoluteString()
            .map(|value| value.to_string())
            .ok_or_else(|| "resolved bookmark has no URL string".to_string())?;
        Ok(Some(resolved))
    }
}

#[cfg(not(target_os = "ios"))]
mod imp {
    /// Bookmarks exist only to survive iOS re-scoping a sandboxed URL on every
    /// launch. Every other platform keeps a plain absolute path working for as
    /// long as the file stays where it was opened, so there is nothing to
    /// create.
    pub fn create_bookmark(_path: &str) -> Result<Option<String>, String> {
        Ok(None)
    }

    /// See [`create_bookmark`]: nothing was ever created, so there is nothing
    /// to resolve.
    pub fn resolve_bookmark(_bookmark: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
}

/// Creates a security-scoped bookmark for `path`, or `None` off iOS.
#[tauri::command]
pub fn create_bookmark(path: String) -> Result<Option<String>, String> {
    imp::create_bookmark(&path)
}

/// Resolves a bookmark from [`create_bookmark`] back to a readable `file://`
/// URL, or `None` off iOS.
#[tauri::command]
pub fn resolve_bookmark(bookmark: String) -> Result<Option<String>, String> {
    imp::resolve_bookmark(&bookmark)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trips_arbitrary_bytes() {
        let original: Vec<u8> = vec![0, 1, 2, 255, 254, 253, 128, 127, 10, 13];
        let encoded = encode_bookmark(&original);
        assert_eq!(decode_bookmark(&encoded).unwrap(), original);
    }

    #[test]
    fn base64_round_trips_an_empty_bookmark() {
        let encoded = encode_bookmark(&[]);
        assert_eq!(decode_bookmark(&encoded).unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn decoding_rejects_text_that_is_not_valid_base64() {
        assert!(decode_bookmark("not base64!! @@").is_err());
    }

    #[cfg(not(target_os = "ios"))]
    #[test]
    fn off_ios_creating_a_bookmark_returns_none() {
        assert_eq!(create_bookmark("/tmp/example.pdf".to_string()), Ok(None));
    }

    #[cfg(not(target_os = "ios"))]
    #[test]
    fn off_ios_resolving_a_bookmark_returns_none() {
        assert_eq!(resolve_bookmark("anything".to_string()), Ok(None));
    }
}
