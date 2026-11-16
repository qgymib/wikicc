//! Value normalization: the per-field cleanups the merge applies to whatever
//! the winning source wrote — `home`/`exclude` candidates, the `exclude`
//! list and the `favicon` path.

use crate::error::{Error, Result};

/// Normalize a `home` value or an `exclude` entry for matching: trimmed,
/// `/`-separated, without a leading `./`.
pub(crate) fn normalize_candidate(raw: &str) -> String {
    let mut candidate = raw.trim().replace('\\', "/");
    while let Some(rest) = candidate.strip_prefix("./") {
        candidate = rest.to_string();
    }
    candidate
}

/// Normalize and validate the `exclude` entries of any source.
///
/// Each entry becomes a `/`-separated directory path relative to the input
/// folder: trimmed, `\` read as `/`, a leading `./` and any trailing `/`
/// dropped. An entry that normalizes to nothing, or that carries an empty,
/// `.` or `..` component, is a hard error — an exclusion that escapes the
/// input folder or cannot match any directory would silently do nothing, and
/// a broken instruction must not look like it worked. Duplicates keep their
/// first occurrence, so the order the author wrote is the order that counts.
pub(crate) fn normalize_excludes(entries: &[String]) -> Result<Vec<String>> {
    let mut excludes: Vec<String> = Vec::new();
    for raw in entries {
        let candidate = normalize_candidate(raw);
        let candidate = candidate.trim_end_matches('/');
        if candidate.is_empty() {
            return Err(Error::InvalidInput(
                "'exclude' entries must be non-empty directory paths".to_string(),
            ));
        }
        if candidate
            .split('/')
            .any(|component| component.is_empty() || component == "." || component == "..")
        {
            return Err(Error::InvalidInput(format!(
                "'exclude' entry '{candidate}' is not a directory path inside the input folder"
            )));
        }
        if !excludes.iter().any(|known| known == candidate) {
            excludes.push(candidate.to_string());
        }
    }
    Ok(excludes)
}

/// Normalize a `favicon` value of any source.
///
/// The value becomes a `/`-separated file path relative to the input folder:
/// trimmed, `\` read as `/`, a leading `./` and a trailing `/` dropped. A
/// value that normalizes to nothing, or that carries an empty, `.` or `..`
/// component, is a hard error: the favicon is a file inside the input folder,
/// and a path that escapes it or cannot name one must not silently build a
/// site that carries the default icon instead.
pub(crate) fn normalize_favicon(raw: &str) -> Result<String> {
    let candidate = normalize_candidate(raw);
    let candidate = candidate.trim_end_matches('/');

    if candidate.is_empty() {
        return Err(Error::InvalidInput(
            "'favicon' must be a non-empty file path".to_string(),
        ));
    }
    if candidate
        .split('/')
        .any(|component| component.is_empty() || component == "." || component == "..")
    {
        return Err(Error::InvalidInput(format!(
            "'favicon' value '{candidate}' is not a file path inside the input folder"
        )));
    }

    Ok(candidate.to_string())
}
