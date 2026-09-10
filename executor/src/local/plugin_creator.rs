// SPDX-License-Identifier: Apache-2.0
//! Executor-owned Creator resources, shared by desktop and cloud Codex homes.

use std::{fs, io::Write, path::Path};

use fs2::FileExt;

pub const SKILL_NAME: &str = "wework-plugin-creator";

const FILES: &[(&str, &[u8])] = &[
    (
        "SKILL.md",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../sdk/plugin-creator/SKILL.md"
        )),
    ),
    (
        "references/account-auth.md",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../sdk/plugin-creator/references/account-auth.md"
        )),
    ),
    (
        "references/account-auth.en.md",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../sdk/plugin-creator/references/account-auth.en.md"
        )),
    ),
    (
        "scripts/validate_wework_plugin.py",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../sdk/plugin-creator/scripts/validate_wework_plugin.py"
        )),
    ),
    (
        "scripts/auth-sdk/tool.py",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../sdk/plugin-auth/tool.py"
        )),
    ),
    (
        "scripts/auth-sdk/README.md",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../sdk/plugin-auth/README.md"
        )),
    ),
    (
        "scripts/auth-sdk/README.en.md",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../sdk/plugin-auth/README.en.md"
        )),
    ),
    (
        "scripts/auth-sdk/LICENSE",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../sdk/plugin-auth/LICENSE"
        )),
    ),
    (
        "scripts/auth-sdk/templates/account-auth.py.tmpl",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../sdk/plugin-auth/templates/account-auth.py.tmpl"
        )),
    ),
    (
        "scripts/auth-sdk/templates/cli.py.tmpl",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../sdk/plugin-auth/templates/cli.py.tmpl"
        )),
    ),
    (
        "scripts/auth-sdk/templates/auth_provider.py.tmpl",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../sdk/plugin-auth/templates/auth_provider.py.tmpl"
        )),
    ),
    (
        "scripts/auth-sdk/templates/oauth-provider.inc",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../sdk/plugin-auth/templates/oauth-provider.inc"
        )),
    ),
    (
        "scripts/auth-sdk/wegent_plugin_auth/__init__.py",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../sdk/plugin-auth/wegent_plugin_auth/__init__.py"
        )),
    ),
    (
        "scripts/auth-sdk/wegent_plugin_auth/adapter.py",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../sdk/plugin-auth/wegent_plugin_auth/adapter.py"
        )),
    ),
    (
        "scripts/auth-sdk/wegent_plugin_auth/configuration.py",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../sdk/plugin-auth/wegent_plugin_auth/configuration.py"
        )),
    ),
    (
        "scripts/auth-sdk/wegent_plugin_auth/runtime.py",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../sdk/plugin-auth/wegent_plugin_auth/runtime.py"
        )),
    ),
    (
        "scripts/auth-sdk/wegent_plugin_auth/transport.py",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../sdk/plugin-auth/wegent_plugin_auth/transport.py"
        )),
    ),
];

/// Materialize the skill before discovery/startup. The SDK is embedded directly
/// from its canonical source, so released executors never need a source checkout.
pub fn install(codex_home: &Path) -> Result<(), String> {
    install_files(codex_home)
        .map_err(|error| format!("prepare Wework Plugin Creator failed: {error}"))
}

fn install_files(codex_home: &Path) -> std::io::Result<()> {
    fs::create_dir_all(codex_home)?;
    let lock_path = codex_home.join(".wework-plugin-creator.lock");
    reject_symlink(&lock_path)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)?;
    lock.lock_exclusive()?;
    let skills = codex_home.join("skills");
    create_directory(&skills)?;
    let root = skills.join(SKILL_NAME);
    create_directory(&root)?;
    for (relative, content) in FILES {
        let path = root.join(relative);
        let mut parent = root.clone();
        for component in Path::new(relative).parent().unwrap().components() {
            parent.push(component);
            create_directory(&parent)?;
        }
        reject_symlink(&path)?;
        if fs::read(&path).is_ok_and(|current| current == *content) {
            continue;
        }
        let mut temporary = tempfile::NamedTempFile::new_in(&parent)?;
        temporary.write_all(content)?;
        temporary.persist(&path).map_err(|error| error.error)?;
    }
    Ok(())
}

fn create_directory(path: &Path) -> std::io::Result<()> {
    reject_symlink(path)?;
    fs::create_dir_all(path)
}

fn reject_symlink(path: &Path) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Creator resources must not use symlinks",
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_and_repairs_resources_without_changing_codex_system_skills() {
        let home = tempfile::tempdir().unwrap();
        let upstream = home.path().join("skills/.system/plugin-creator");
        fs::create_dir_all(&upstream).unwrap();
        fs::write(upstream.join("SKILL.md"), "upstream-owned").unwrap();
        install(home.path()).unwrap();
        let root = home.path().join("skills").join(SKILL_NAME);
        let script = root.join("scripts/auth-sdk/tool.py");
        fs::write(&script, "obsolete").unwrap();
        fs::remove_file(root.join("scripts/auth-sdk/templates/cli.py.tmpl")).unwrap();
        install(home.path()).unwrap();
        for (relative, content) in FILES {
            assert_eq!(fs::read(root.join(relative)).unwrap(), *content);
        }
        assert_eq!(
            fs::read_to_string(upstream.join("SKILL.md")).unwrap(),
            "upstream-owned"
        );
        let before = fs::metadata(&script).unwrap().modified().unwrap();
        install(home.path()).unwrap();
        assert_eq!(fs::metadata(&script).unwrap().modified().unwrap(), before);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_write_through_a_skill_symlink() {
        use std::os::unix::fs::symlink;
        let home = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        fs::create_dir(home.path().join("skills")).unwrap();
        symlink(other.path(), home.path().join("skills").join(SKILL_NAME)).unwrap();
        assert!(install(home.path()).unwrap_err().contains("symlinks"));
        assert_eq!(fs::read_dir(other.path()).unwrap().count(), 0);
    }
}
