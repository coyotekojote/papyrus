//! Sidecar storage layer (issue #5).
//!
//! Persists notes and annotations next to the PDF in a `<name>.papyrus/`
//! folder so iCloud Drive (or any file sync) carries them between devices.
//! All writes are atomic (tmp file + rename) and every read/write reports the
//! file's mtime so the frontend can detect external changes made by another
//! device mid-session.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

/// The only annotations schema version this build can read and write.
pub const ANNOTATIONS_VERSION: u32 = 1;

const SIDECAR_EXTENSION: &str = "papyrus";
const NOTES_FILE: &str = "notes.md";
const ANNOTATIONS_FILE: &str = "annotations.json";

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SidecarError {
    /// The given path does not look like a PDF file, so no sidecar folder can
    /// be derived for it.
    InvalidPdfPath {
        path: String,
    },
    /// annotations.json was written by a newer schema; refusing to touch it
    /// prevents a lossy rewrite from this older build.
    UnsupportedVersion {
        found: u32,
        supported: u32,
    },
    /// The file on disk changed since the caller last loaded it (e.g. iCloud
    /// synced an edit from another device). The caller should reload first.
    Conflict {
        path: String,
    },
    Parse {
        message: String,
    },
    Io {
        message: String,
    },
}

impl From<std::io::Error> for SidecarError {
    fn from(err: std::io::Error) -> Self {
        SidecarError::Io {
            message: err.to_string(),
        }
    }
}

type Result<T> = std::result::Result<T, SidecarError>;

// --- schema (docs/design.md, v1) ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    pub id: String,
    pub page: u32,
    /// Normalized (0-1) page coordinates, zoom/device independent.
    pub rects: Vec<Rect>,
    pub color: String,
    pub text: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    pub page: u32,
    pub rect: Rect,
    /// Path relative to the sidecar folder, e.g. `clips/clip-0001.png`.
    pub file: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotations {
    pub version: u32,
    #[serde(default)]
    pub highlights: Vec<Highlight>,
    #[serde(default)]
    pub clips: Vec<Clip>,
}

impl Default for Annotations {
    fn default() -> Self {
        Annotations {
            version: ANNOTATIONS_VERSION,
            highlights: Vec::new(),
            clips: Vec::new(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedAnnotations {
    pub annotations: Annotations,
    /// None when annotations.json does not exist yet.
    pub modified_at_ms: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedNotes {
    pub content: String,
    /// None when notes.md does not exist yet.
    pub modified_at_ms: Option<i64>,
}

/// Snapshot of sidecar file mtimes, for polling external (iCloud) changes.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarStatus {
    pub notes_modified_at_ms: Option<i64>,
    pub annotations_modified_at_ms: Option<i64>,
}

// --- path convention ---

/// `foo.pdf` → `foo.papyrus/`. Fails when the path is not a `.pdf` file.
pub fn sidecar_dir(pdf_path: &Path) -> Result<PathBuf> {
    let is_pdf = pdf_path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"));
    let stem_ok = pdf_path.file_stem().is_some_and(|stem| !stem.is_empty());
    if !is_pdf || !stem_ok {
        return Err(SidecarError::InvalidPdfPath {
            path: pdf_path.display().to_string(),
        });
    }
    Ok(pdf_path.with_extension(SIDECAR_EXTENSION))
}

fn notes_path(pdf_path: &Path) -> Result<PathBuf> {
    Ok(sidecar_dir(pdf_path)?.join(NOTES_FILE))
}

fn annotations_path(pdf_path: &Path) -> Result<PathBuf> {
    Ok(sidecar_dir(pdf_path)?.join(ANNOTATIONS_FILE))
}

// --- mtime / external change detection ---

fn modified_at_ms(path: &Path) -> Result<Option<i64>> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
    };
    let modified = metadata.modified()?;
    let ms = match modified.duration_since(UNIX_EPOCH) {
        Ok(since) => i64::try_from(since.as_millis()).unwrap_or(i64::MAX),
        // Pre-1970 mtimes should not happen, but clamp instead of panicking.
        Err(_) => 0,
    };
    Ok(Some(ms))
}

/// Fails with `Conflict` when the file's current mtime does not match what the
/// caller last observed — i.e. another device edited it in the meantime.
fn ensure_unchanged(path: &Path, base_modified_at_ms: Option<i64>) -> Result<()> {
    if modified_at_ms(path)? == base_modified_at_ms {
        return Ok(());
    }
    Err(SidecarError::Conflict {
        path: path.display().to_string(),
    })
}

// --- atomic write ---

/// Writes via a same-directory tmp file + atomic replace so a crash or a
/// mid-write iCloud sync never leaves a half-written file at the destination.
/// `NamedTempFile::persist` replaces an existing destination on every platform
/// (rename on Unix, MoveFileEx with MOVEFILE_REPLACE_EXISTING on Windows) and
/// removes the tmp file automatically when the write fails.
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path.parent().ok_or_else(|| SidecarError::Io {
        message: format!("no parent directory for {}", path.display()),
    })?;
    fs::create_dir_all(dir)?;
    let mut tmp = tempfile::Builder::new()
        .prefix(".papyrus-tmp-")
        .tempfile_in(dir)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|err| SidecarError::Io {
        message: err.error.to_string(),
    })?;
    // Fsync the directory so the rename itself survives a crash. Windows has
    // no equivalent directory handle sync, and a failure here does not lose
    // data (the content was already fsynced), so best-effort is enough.
    #[cfg(unix)]
    if let Ok(dir_file) = fs::File::open(dir) {
        let _ = dir_file.sync_all();
    }
    Ok(())
}

// --- load / save ---

fn read_annotations(path: &Path) -> Result<Option<Annotations>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
    };
    let annotations: Annotations =
        serde_json::from_slice(&bytes).map_err(|err| SidecarError::Parse {
            message: err.to_string(),
        })?;
    if annotations.version != ANNOTATIONS_VERSION {
        return Err(SidecarError::UnsupportedVersion {
            found: annotations.version,
            supported: ANNOTATIONS_VERSION,
        });
    }
    Ok(Some(annotations))
}

pub fn load_annotations_from(pdf_path: &Path) -> Result<LoadedAnnotations> {
    let path = annotations_path(pdf_path)?;
    // Capture the mtime BEFORE reading: if the file changes between the two
    // steps, the stale mtime makes the next save fail with a safe Conflict
    // instead of silently clobbering content we never loaded.
    let modified_at_ms = modified_at_ms(&path)?;
    match read_annotations(&path)? {
        Some(annotations) => Ok(LoadedAnnotations {
            annotations,
            modified_at_ms,
        }),
        None => Ok(LoadedAnnotations {
            annotations: Annotations::default(),
            modified_at_ms: None,
        }),
    }
}

pub fn save_annotations_to(
    pdf_path: &Path,
    annotations: &Annotations,
    base_modified_at_ms: Option<i64>,
) -> Result<i64> {
    if annotations.version != ANNOTATIONS_VERSION {
        return Err(SidecarError::UnsupportedVersion {
            found: annotations.version,
            supported: ANNOTATIONS_VERSION,
        });
    }
    let path = annotations_path(pdf_path)?;
    ensure_unchanged(&path, base_modified_at_ms)?;
    let mut json = serde_json::to_vec_pretty(annotations).map_err(|err| SidecarError::Parse {
        message: err.to_string(),
    })?;
    json.push(b'\n');
    atomic_write(&path, &json)?;
    modified_at_ms(&path)?.ok_or_else(|| SidecarError::Io {
        message: format!("{} vanished right after writing", path.display()),
    })
}

pub fn load_notes_from(pdf_path: &Path) -> Result<LoadedNotes> {
    let path = notes_path(pdf_path)?;
    // Same ordering rationale as load_annotations_from: mtime first, so a
    // concurrent external change can only cause a safe Conflict later.
    let modified_at_ms = modified_at_ms(&path)?;
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LoadedNotes {
                content: String::new(),
                modified_at_ms: None,
            })
        }
        Err(err) => return Err(err.into()),
    };
    Ok(LoadedNotes {
        content,
        modified_at_ms,
    })
}

pub fn save_notes_to(
    pdf_path: &Path,
    content: &str,
    base_modified_at_ms: Option<i64>,
) -> Result<i64> {
    let path = notes_path(pdf_path)?;
    ensure_unchanged(&path, base_modified_at_ms)?;
    atomic_write(&path, content.as_bytes())?;
    modified_at_ms(&path)?.ok_or_else(|| SidecarError::Io {
        message: format!("{} vanished right after writing", path.display()),
    })
}

pub fn sidecar_status_of(pdf_path: &Path) -> Result<SidecarStatus> {
    Ok(SidecarStatus {
        notes_modified_at_ms: modified_at_ms(&notes_path(pdf_path)?)?,
        annotations_modified_at_ms: modified_at_ms(&annotations_path(pdf_path)?)?,
    })
}

// --- Tauri commands ---

#[tauri::command]
pub fn load_annotations(pdf_path: String) -> Result<LoadedAnnotations> {
    load_annotations_from(Path::new(&pdf_path))
}

#[tauri::command]
pub fn save_annotations(
    pdf_path: String,
    annotations: Annotations,
    base_modified_at_ms: Option<i64>,
) -> Result<i64> {
    save_annotations_to(Path::new(&pdf_path), &annotations, base_modified_at_ms)
}

#[tauri::command]
pub fn load_notes(pdf_path: String) -> Result<LoadedNotes> {
    load_notes_from(Path::new(&pdf_path))
}

#[tauri::command]
pub fn save_notes(
    pdf_path: String,
    content: String,
    base_modified_at_ms: Option<i64>,
) -> Result<i64> {
    save_notes_to(Path::new(&pdf_path), &content, base_modified_at_ms)
}

#[tauri::command]
pub fn sidecar_status(pdf_path: String) -> Result<SidecarStatus> {
    sidecar_status_of(Path::new(&pdf_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_annotations() -> Annotations {
        Annotations {
            version: 1,
            highlights: vec![Highlight {
                id: "hl-1".into(),
                page: 3,
                rects: vec![Rect {
                    x: 0.1,
                    y: 0.2,
                    w: 0.5,
                    h: 0.02,
                }],
                color: "yellow".into(),
                text: "抽出されたテキスト".into(),
                created_at: "2026-08-01T00:00:00Z".into(),
            }],
            clips: vec![Clip {
                id: "clip-1".into(),
                page: 5,
                rect: Rect {
                    x: 0.1,
                    y: 0.3,
                    w: 0.4,
                    h: 0.3,
                },
                file: "clips/clip-0001.png".into(),
                created_at: "2026-08-01T00:00:00Z".into(),
            }],
        }
    }

    #[test]
    fn sidecar_dir_replaces_pdf_extension() {
        assert_eq!(
            sidecar_dir(Path::new("/Papers/attention.pdf")).unwrap(),
            PathBuf::from("/Papers/attention.papyrus"),
        );
    }

    #[test]
    fn sidecar_dir_accepts_uppercase_extension() {
        assert_eq!(
            sidecar_dir(Path::new("/Papers/SCAN.PDF")).unwrap(),
            PathBuf::from("/Papers/SCAN.papyrus"),
        );
    }

    #[test]
    fn sidecar_dir_keeps_inner_dots() {
        assert_eq!(
            sidecar_dir(Path::new("/Papers/v1.2-draft.pdf")).unwrap(),
            PathBuf::from("/Papers/v1.2-draft.papyrus"),
        );
    }

    #[test]
    fn sidecar_dir_rejects_non_pdf_paths() {
        for path in ["/Papers/notes.txt", "/Papers/no-extension", "/Papers/.pdf"] {
            assert!(
                matches!(
                    sidecar_dir(Path::new(path)),
                    Err(SidecarError::InvalidPdfPath { .. })
                ),
                "expected InvalidPdfPath for {path}",
            );
        }
    }

    #[test]
    fn annotations_roundtrip_preserves_data() {
        let dir = tempfile::tempdir().unwrap();
        let pdf = dir.path().join("paper.pdf");
        let saved = sample_annotations();

        let mtime = save_annotations_to(&pdf, &saved, None).unwrap();
        let loaded = load_annotations_from(&pdf).unwrap();

        assert_eq!(loaded.annotations, saved);
        assert_eq!(loaded.modified_at_ms, Some(mtime));
    }

    #[test]
    fn load_annotations_defaults_when_file_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let loaded = load_annotations_from(&dir.path().join("paper.pdf")).unwrap();

        assert_eq!(loaded.annotations, Annotations::default());
        assert_eq!(loaded.annotations.version, ANNOTATIONS_VERSION);
        assert_eq!(loaded.modified_at_ms, None);
    }

    #[test]
    fn load_annotations_rejects_newer_schema_versions() {
        let dir = tempfile::tempdir().unwrap();
        let pdf = dir.path().join("paper.pdf");
        let sidecar = sidecar_dir(&pdf).unwrap();
        fs::create_dir_all(&sidecar).unwrap();
        fs::write(
            sidecar.join(ANNOTATIONS_FILE),
            r#"{"version": 2, "highlights": [], "clips": []}"#,
        )
        .unwrap();

        assert!(matches!(
            load_annotations_from(&pdf),
            Err(SidecarError::UnsupportedVersion {
                found: 2,
                supported: 1
            })
        ));
    }

    #[test]
    fn load_annotations_reports_parse_errors() {
        let dir = tempfile::tempdir().unwrap();
        let pdf = dir.path().join("paper.pdf");
        let sidecar = sidecar_dir(&pdf).unwrap();
        fs::create_dir_all(&sidecar).unwrap();
        fs::write(sidecar.join(ANNOTATIONS_FILE), "not json").unwrap();

        assert!(matches!(
            load_annotations_from(&pdf),
            Err(SidecarError::Parse { .. })
        ));
    }

    #[test]
    fn save_annotations_rejects_wrong_version() {
        let dir = tempfile::tempdir().unwrap();
        let pdf = dir.path().join("paper.pdf");
        let mut annotations = sample_annotations();
        annotations.version = 2;

        assert!(matches!(
            save_annotations_to(&pdf, &annotations, None),
            Err(SidecarError::UnsupportedVersion { .. })
        ));
    }

    #[test]
    fn save_detects_external_creation() {
        let dir = tempfile::tempdir().unwrap();
        let pdf = dir.path().join("paper.pdf");
        // Another device already created the file, but the caller thinks it
        // does not exist yet (base None).
        save_annotations_to(&pdf, &Annotations::default(), None).unwrap();

        assert!(matches!(
            save_annotations_to(&pdf, &sample_annotations(), None),
            Err(SidecarError::Conflict { .. })
        ));
    }

    #[test]
    fn save_detects_external_modification() {
        let dir = tempfile::tempdir().unwrap();
        let pdf = dir.path().join("paper.pdf");
        let mtime = save_notes_to(&pdf, "mine", None).unwrap();
        // Simulate an iCloud sync bumping the mtime behind our back.
        let path = notes_path(&pdf).unwrap();
        let later = fs::OpenOptions::new().write(true).open(&path).unwrap();
        later
            .set_modified(UNIX_EPOCH + std::time::Duration::from_millis(mtime as u64 + 5000))
            .unwrap();

        assert!(matches!(
            save_notes_to(&pdf, "clobber", Some(mtime)),
            Err(SidecarError::Conflict { .. })
        ));
    }

    #[test]
    fn save_succeeds_when_base_matches_disk() {
        let dir = tempfile::tempdir().unwrap();
        let pdf = dir.path().join("paper.pdf");
        let first = save_notes_to(&pdf, "v1", None).unwrap();
        save_notes_to(&pdf, "v2", Some(first)).unwrap();

        assert_eq!(load_notes_from(&pdf).unwrap().content, "v2");
    }

    #[test]
    fn notes_roundtrip_and_missing_default() {
        let dir = tempfile::tempdir().unwrap();
        let pdf = dir.path().join("paper.pdf");

        let missing = load_notes_from(&pdf).unwrap();
        assert_eq!(missing.content, "");
        assert_eq!(missing.modified_at_ms, None);

        let mtime = save_notes_to(&pdf, "# メモ\n本文", None).unwrap();
        let loaded = load_notes_from(&pdf).unwrap();
        assert_eq!(loaded.content, "# メモ\n本文");
        assert_eq!(loaded.modified_at_ms, Some(mtime));
    }

    #[test]
    fn atomic_write_leaves_no_tmp_files_behind() {
        let dir = tempfile::tempdir().unwrap();
        let pdf = dir.path().join("paper.pdf");
        save_notes_to(&pdf, "note", None).unwrap();
        save_annotations_to(&pdf, &sample_annotations(), None).unwrap();

        let names: Vec<String> = fs::read_dir(sidecar_dir(&pdf).unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(sorted, vec![ANNOTATIONS_FILE, NOTES_FILE]);
    }

    #[test]
    fn sidecar_status_reports_both_files() {
        let dir = tempfile::tempdir().unwrap();
        let pdf = dir.path().join("paper.pdf");

        let empty = sidecar_status_of(&pdf).unwrap();
        assert_eq!(empty.notes_modified_at_ms, None);
        assert_eq!(empty.annotations_modified_at_ms, None);

        let notes_mtime = save_notes_to(&pdf, "note", None).unwrap();
        let status = sidecar_status_of(&pdf).unwrap();
        assert_eq!(status.notes_modified_at_ms, Some(notes_mtime));
        assert_eq!(status.annotations_modified_at_ms, None);
    }

    #[test]
    fn saved_annotations_json_is_readable_v1() {
        let dir = tempfile::tempdir().unwrap();
        let pdf = dir.path().join("paper.pdf");
        save_annotations_to(&pdf, &sample_annotations(), None).unwrap();

        let raw = fs::read_to_string(annotations_path(&pdf).unwrap()).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["highlights"][0]["createdAt"], "2026-08-01T00:00:00Z");
        assert_eq!(value["clips"][0]["file"], "clips/clip-0001.png");
        assert!(raw.ends_with('\n'));
    }
}
