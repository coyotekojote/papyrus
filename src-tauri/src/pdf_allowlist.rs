//! Allow-list of PDF paths the sidecar commands may write next to (issue #40).
//!
//! `fs:scope` (capabilities/default.json) only gates the frontend's direct
//! reads through plugin-fs — it has no effect on this crate's own
//! filesystem access. Without a second gate here, `save_annotations` /
//! `save_notes` / `save_clip` would create a `foo.papyrus/` folder next to
//! *any* `*.pdf` path a caller names, whether or not the reader ever opened
//! it. This module tracks, in memory, the canonical (symlink-resolved) paths
//! the frontend has actually opened this session, and `sidecar::ensure_allowed`
//! refuses anything not in that set.
//!
//! Paths get in two ways: `register_pdf_path` below (called right after a
//! normal open succeeds) and `bookmarks::resolve_bookmark` (iOS only — see
//! that module for why it skips the root check this one applies).

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use percent_encoding::percent_decode_str;
use serde::Serialize;

use crate::sidecar;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PdfAllowlistError {
    /// Not a `.pdf` path by the same rule `sidecar::sidecar_dir` uses.
    InvalidPdfPath { path: String },
    /// `fs::canonicalize` failed — most commonly the file does not exist.
    NotFound { path: String },
    /// Canonicalized fine, but sits outside every allowed root.
    OutsideAllowedRoots { path: String },
}

/// Canonicalized PDF paths registered so far this session. Cleared on
/// restart by design (see plan's "known limitations") — a relaunch re-opens
/// the file through the normal flow anyway, which registers it again.
pub struct AllowedPdfs(Mutex<HashSet<PathBuf>>);

impl AllowedPdfs {
    pub fn new() -> Self {
        AllowedPdfs(Mutex::new(HashSet::new()))
    }

    pub fn insert(&self, path: PathBuf) {
        // A previous insert panicking mid-critical-section is not something
        // this module ever does, but recovering the poisoned guard rather
        // than propagating the panic keeps one bad command from wedging
        // every later one for the rest of the session.
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(path);
    }

    pub fn contains(&self, path: &Path) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains(path)
    }
}

impl Default for AllowedPdfs {
    fn default() -> Self {
        Self::new()
    }
}

/// Passes an ordinary filesystem path through unchanged. Strips a `file://`
/// scheme and percent-decodes what is left — iOS hands the frontend (and,
/// via `resolve_bookmark`, this crate) `file://` URLs rather than plain
/// paths, and those can contain spaces or non-ASCII names percent-encoded.
///
/// An invalid escape (not exactly two hex digits after `%`) is left as the
/// literal characters it was — matching how a browser address bar treats a
/// stray `%` — rather than rejected, since a name that happens to contain a
/// literal `%` is exactly as valid a filename as any other.
pub fn decode_maybe_file_url(input: &str) -> PathBuf {
    match input.strip_prefix("file://") {
        Some(rest) => PathBuf::from(percent_decode_str(rest).decode_utf8_lossy().into_owned()),
        None => PathBuf::from(input),
    }
}

/// Canonicalizes `path` and checks that it is a `.pdf` file sitting under one
/// of `roots` once symlinks are resolved.
///
/// Roots are injected rather than read from `app.path()` directly so this —
/// the security-relevant part — can be unit tested without a running Tauri
/// app; the command wrapper below builds them from `app.path()`.
pub fn canonical_pdf_under_roots(
    path: &Path,
    roots: &[PathBuf],
) -> Result<PathBuf, PdfAllowlistError> {
    sidecar::sidecar_dir(path).map_err(|_| PdfAllowlistError::InvalidPdfPath {
        path: path.display().to_string(),
    })?;
    let real_path = fs::canonicalize(path).map_err(|_| PdfAllowlistError::NotFound {
        path: path.display().to_string(),
    })?;
    let under_a_root = roots.iter().any(|root| {
        fs::canonicalize(root)
            .map(|real_root| real_path.starts_with(&real_root))
            .unwrap_or(false)
    });
    if under_a_root {
        Ok(real_path)
    } else {
        Err(PdfAllowlistError::OutsideAllowedRoots {
            path: real_path.display().to_string(),
        })
    }
}

/// Testable core of `register_pdf_path`, with the roots and state passed in
/// directly rather than pulled from a live `AppHandle` (see
/// `canonical_pdf_under_roots`).
fn register_pdf_path_with(
    path: &str,
    roots: &[PathBuf],
    state: &AllowedPdfs,
) -> Result<(), PdfAllowlistError> {
    let decoded = decode_maybe_file_url(path);
    let canonical = canonical_pdf_under_roots(&decoded, roots)?;
    state.insert(canonical);
    Ok(())
}

/// The same root set `capabilities/default.json`'s `fs:scope` allows plugin-fs
/// to read from — kept in sync by hand since the capability file has no way
/// to export this list back to Rust.
fn allowed_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    use tauri::Manager as _;
    let path = app.path();
    [path.home_dir(), path.document_dir(), path.download_dir()]
        .into_iter()
        .filter_map(Result::ok)
        .collect()
}

/// Registers `path` as a PDF the sidecar commands may now touch. Called by
/// the frontend right after a normal (non-bookmark) open succeeds — see
/// `src/files/open.ts`'s `registerPdfPath` and `App.tsx`'s `openPath`.
#[tauri::command]
pub fn register_pdf_path(
    app: tauri::AppHandle,
    path: String,
    state: tauri::State<'_, AllowedPdfs>,
) -> Result<(), PdfAllowlistError> {
    register_pdf_path_with(&path, &allowed_roots(&app), &state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn accepts_a_real_pdf_under_a_root() {
        let root = tempfile::tempdir().unwrap();
        let pdf = root.path().join("paper.pdf");
        fs::write(&pdf, b"%PDF-1.4").unwrap();

        assert_eq!(
            canonical_pdf_under_roots(&pdf, &[root.path().to_path_buf()]).unwrap(),
            fs::canonicalize(&pdf).unwrap(),
        );
    }

    #[test]
    fn rejects_a_non_pdf_extension() {
        let root = tempfile::tempdir().unwrap();
        let txt = root.path().join("notes.txt");
        fs::write(&txt, b"hi").unwrap();

        assert_eq!(
            canonical_pdf_under_roots(&txt, &[root.path().to_path_buf()]),
            Err(PdfAllowlistError::InvalidPdfPath {
                path: txt.display().to_string(),
            }),
        );
    }

    #[test]
    fn rejects_a_path_outside_every_root() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let pdf = outside.path().join("paper.pdf");
        fs::write(&pdf, b"%PDF-1.4").unwrap();

        assert!(matches!(
            canonical_pdf_under_roots(&pdf, &[root.path().to_path_buf()]),
            Err(PdfAllowlistError::OutsideAllowedRoots { .. })
        ));
    }

    #[test]
    fn rejects_a_path_that_does_not_exist() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("ghost.pdf");

        assert!(matches!(
            canonical_pdf_under_roots(&missing, &[root.path().to_path_buf()]),
            Err(PdfAllowlistError::NotFound { .. })
        ));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_that_escapes_the_root_even_though_the_link_sits_inside_it() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let real = outside.path().join("secret.pdf");
        fs::write(&real, b"%PDF-1.4").unwrap();
        let link = root.path().join("looks-local.pdf");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        assert!(matches!(
            canonical_pdf_under_roots(&link, &[root.path().to_path_buf()]),
            Err(PdfAllowlistError::OutsideAllowedRoots { .. })
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_to_a_real_entity_under_the_root_resolves_to_that_entity() {
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("paper.pdf");
        fs::write(&real, b"%PDF-1.4").unwrap();
        let link = root.path().join("alias.pdf");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        assert_eq!(
            canonical_pdf_under_roots(&link, &[root.path().to_path_buf()]).unwrap(),
            fs::canonicalize(&real).unwrap(),
        );
    }

    #[test]
    fn allowed_pdfs_rejects_an_unregistered_path() {
        let allowed = AllowedPdfs::new();
        assert!(!allowed.contains(Path::new("/Papers/attention.pdf")));
    }

    #[test]
    fn allowed_pdfs_accepts_a_registered_path() {
        let allowed = AllowedPdfs::new();
        let path = PathBuf::from("/Papers/attention.pdf");
        allowed.insert(path.clone());
        assert!(allowed.contains(&path));
    }

    #[cfg(unix)]
    #[test]
    fn register_pdf_path_with_inserts_the_canonical_path() {
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("paper.pdf");
        fs::write(&real, b"%PDF-1.4").unwrap();
        let link = root.path().join("alias.pdf");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let state = AllowedPdfs::new();

        register_pdf_path_with(link.to_str().unwrap(), &[root.path().to_path_buf()], &state)
            .unwrap();

        assert!(state.contains(&fs::canonicalize(&real).unwrap()));
    }

    #[test]
    fn register_pdf_path_with_reports_outside_root_errors() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let pdf = outside.path().join("paper.pdf");
        fs::write(&pdf, b"%PDF-1.4").unwrap();
        let state = AllowedPdfs::new();

        assert!(matches!(
            register_pdf_path_with(pdf.to_str().unwrap(), &[root.path().to_path_buf()], &state),
            Err(PdfAllowlistError::OutsideAllowedRoots { .. })
        ));
        assert!(!state.contains(&fs::canonicalize(&pdf).unwrap()));
    }

    #[test]
    fn decode_maybe_file_url_passes_a_plain_path_through() {
        assert_eq!(
            decode_maybe_file_url("/Papers/attention.pdf"),
            PathBuf::from("/Papers/attention.pdf"),
        );
    }

    #[test]
    fn decode_maybe_file_url_strips_scheme_and_decodes_a_space() {
        assert_eq!(
            decode_maybe_file_url("file:///Papers/My%20Notes/attention.pdf"),
            PathBuf::from("/Papers/My Notes/attention.pdf"),
        );
    }

    #[test]
    fn decode_maybe_file_url_decodes_percent_encoded_japanese() {
        // "論文.pdf" percent-encoded as UTF-8 bytes.
        assert_eq!(
            decode_maybe_file_url("file:///Papers/%E8%AB%96%E6%96%87.pdf"),
            PathBuf::from("/Papers/論文.pdf"),
        );
    }

    #[test]
    fn decode_maybe_file_url_leaves_an_invalid_escape_literal() {
        // "%zz" is not a valid two-hex-digit escape, so it stays as-is
        // rather than being dropped or causing an error.
        assert_eq!(
            decode_maybe_file_url("file:///Papers/100%zz.pdf"),
            PathBuf::from("/Papers/100%zz.pdf"),
        );
    }
}
