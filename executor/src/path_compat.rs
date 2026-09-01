// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::path::{Path, PathBuf};

pub(crate) fn strip_windows_verbatim_prefix(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(value) = value.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{value}"));
    }
    if let Some(value) = value.strip_prefix(r"\\?\") {
        return PathBuf::from(value);
    }
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_windows_drive_verbatim_prefix() {
        assert_eq!(
            strip_windows_verbatim_prefix(Path::new(r"\\?\D:\work\Wegent")),
            PathBuf::from(r"D:\work\Wegent")
        );
    }

    #[test]
    fn converts_windows_unc_verbatim_prefix() {
        assert_eq!(
            strip_windows_verbatim_prefix(Path::new(r"\\?\UNC\server\share\Wegent")),
            PathBuf::from(r"\\server\share\Wegent")
        );
    }

    #[test]
    fn preserves_regular_paths() {
        assert_eq!(
            strip_windows_verbatim_prefix(Path::new("/tmp/Wegent")),
            PathBuf::from("/tmp/Wegent")
        );
    }
}
