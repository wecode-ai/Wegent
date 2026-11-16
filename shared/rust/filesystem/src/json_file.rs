// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{fs, io::Write, path::Path};

use serde::Serialize;

pub fn write_json_file(path: &Path, value: &(impl Serialize + ?Sized)) -> Result<(), String> {
    let parent = path.parent().ok_or("JSON file has no parent")?;
    let name = path.file_name().ok_or("JSON file has no file name")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    // tempfile calls Win32 directly when persisting. Both paths need the
    // canonical parent's verbatim prefix, including a destination not yet created.
    let parent = fs::canonicalize(parent)
        .map_err(|error| format!("failed to resolve {}: {error}", parent.display()))?;
    let target = parent.join(name);
    let content = serde_json::to_string_pretty(value)
        .map_err(|error| format!("failed to serialize JSON: {error}"))?;
    let mut file = tempfile::NamedTempFile::new_in(&parent)
        .map_err(|error| format!("failed to stage {}: {error}", path.display()))?;
    file.write_all(content.as_bytes())
        .and_then(|_| file.as_file().sync_all())
        .map_err(|error| format!("failed to write {}: {error}", path.display()))?;
    file.persist(target)
        .map_err(|error| format!("failed to publish {}: {}", path.display(), error.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn creates_and_replaces_json_beyond_windows_max_path() {
        let directory = tempfile::tempdir().unwrap();
        let mut parent = crate::path_compat::strip_windows_verbatim_prefix(directory.path());
        for _ in 0..5 {
            parent.push("long-agent-home-directory-".repeat(3));
        }
        let path = parent.join("配置.json");
        assert!(path.as_os_str().len() > 260);
        for version in [1, 2] {
            let value = json!({"version": version, "skills": ["测试技能"]});
            write_json_file(&path, &value).unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&fs::read(&path).unwrap()).unwrap(),
                value
            );
        }
        assert_eq!(fs::read_dir(parent).unwrap().count(), 1);
    }

    #[test]
    fn failed_publication_preserves_destination_and_cleans_staging_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        fs::create_dir(&path).unwrap();
        let sentinel = path.join("sentinel");
        fs::write(&sentinel, "existing data").unwrap();

        let error = write_json_file(&path, &json!({"version": 1})).unwrap_err();

        assert!(error.contains("failed to publish"));
        assert_eq!(fs::read_to_string(sentinel).unwrap(), "existing data");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
