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

use std::fs;

use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::pdf_allowlist::{self, AllowedPdfs};
use crate::sidecar;

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
        // What the document picker hands the frontend — and what comes back
        // here — is a `file://` URL string, not a filesystem path.
        // `fileURLWithPath` would swallow that string as a literal path
        // component and bookmark a location that does not exist, so the URL
        // form gets `URLWithString` and only a plain path (a caller that got
        // one from somewhere else) goes through `fileURLWithPath`.
        let ns_path = NSString::from_str(path);
        let url = if path.starts_with("file://") {
            NSURL::URLWithString(&ns_path).ok_or_else(|| format!("not a valid file URL: {path}"))?
        } else {
            NSURL::fileURLWithPath(&ns_path)
        };
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
/// URL, or `None` off iOS. On success, also registers the resolved path in
/// `state` (issue #40) so sidecar commands are allowed to touch it —
/// separated out as `resolve_bookmark_with` so this can be unit tested
/// without a live `AppHandle`/`State`.
#[tauri::command]
pub fn resolve_bookmark(
    bookmark: String,
    state: tauri::State<'_, AllowedPdfs>,
) -> Result<Option<String>, String> {
    resolve_bookmark_with(&bookmark, &state)
}

/// Unlike `register_pdf_path` (`pdf_allowlist.rs`), this applies no root
/// check: a security-scoped bookmark can resolve into another app's sandboxed
/// container or an iCloud share outside `$HOME`/`$DOCUMENT`/`$DOWNLOAD`, and
/// the bookmark's own existence already proves the user chose this file
/// through the OS picker at some point. A canonicalize failure here (the
/// bookmarked file has since moved or been deleted) just means nothing gets
/// registered — the resolved URL is still returned as-is, and any later
/// sidecar command on it will fail with `PathNotAllowed`, which is the
/// correct outcome for a location this crate could not verify.
fn resolve_bookmark_with(bookmark: &str, state: &AllowedPdfs) -> Result<Option<String>, String> {
    let resolved = imp::resolve_bookmark(bookmark)?;
    if let Some(url) = &resolved {
        register_resolved_bookmark(state, url);
    }
    Ok(resolved)
}

/// The registration half of `resolve_bookmark_with`, split out so it can be
/// tested directly — off iOS, `imp::resolve_bookmark` never returns `Some`,
/// so this path would otherwise have no test coverage at all on this
/// development machine.
fn register_resolved_bookmark(state: &AllowedPdfs, resolved: &str) {
    let decoded = pdf_allowlist::decode_maybe_file_url(resolved);
    // Every other path into AllowedPdfs (`register_pdf_path_with`, via
    // `canonical_pdf_under_roots`) checks this before inserting, so skipping
    // it here would let a non-.pdf bookmark break the allow-list's
    // invariant that everything in it is a path sidecar.rs may treat as a
    // PDF.
    if sidecar::sidecar_dir(&decoded).is_err() {
        return;
    }
    if let Ok(canonical) = fs::canonicalize(decoded) {
        state.insert(canonical);
    }
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
        let state = AllowedPdfs::new();
        assert_eq!(resolve_bookmark_with("anything", &state), Ok(None));
    }

    #[test]
    fn register_resolved_bookmark_inserts_the_canonical_path() {
        let dir = tempfile::tempdir().unwrap();
        let pdf = dir.path().join("paper.pdf");
        fs::write(&pdf, b"%PDF-1.4").unwrap();
        let state = AllowedPdfs::new();

        register_resolved_bookmark(&state, pdf.to_str().unwrap());

        assert!(state.contains(&fs::canonicalize(&pdf).unwrap()));
    }

    #[test]
    fn register_resolved_bookmark_decodes_a_file_url_first() {
        let dir = tempfile::tempdir().unwrap();
        let pdf = dir.path().join("paper.pdf");
        fs::write(&pdf, b"%PDF-1.4").unwrap();
        let state = AllowedPdfs::new();
        let url = format!("file://{}", pdf.display());

        register_resolved_bookmark(&state, &url);

        assert!(state.contains(&fs::canonicalize(&pdf).unwrap()));
    }

    #[test]
    fn register_resolved_bookmark_rejects_a_non_pdf_path() {
        let dir = tempfile::tempdir().unwrap();
        let txt = dir.path().join("notes.txt");
        fs::write(&txt, b"not a pdf").unwrap();
        let state = AllowedPdfs::new();

        register_resolved_bookmark(&state, txt.to_str().unwrap());

        assert!(!state.contains(&fs::canonicalize(&txt).unwrap()));
    }

    #[test]
    fn register_resolved_bookmark_silently_ignores_a_path_that_does_not_exist() {
        let state = AllowedPdfs::new();

        // Must not panic; there is simply nothing to register.
        register_resolved_bookmark(&state, "/nonexistent/paper.pdf");

        assert!(!state.contains(std::path::Path::new("/nonexistent/paper.pdf")));
    }
}
