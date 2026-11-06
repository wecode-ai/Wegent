// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::cell::RefCell;

thread_local! {
    static READ_FILES: RefCell<Option<Vec<PathBuf>>> = const { RefCell::new(None) };
    static HASHED_FILES: RefCell<Option<Vec<PathBuf>>> = const { RefCell::new(None) };
}

pub(super) fn record_hash(path: &Path) {
    record_read(path);
    HASHED_FILES.with_borrow_mut(|paths| {
        if let Some(paths) = paths {
            paths.push(path.to_owned());
        }
    });
}

pub(super) fn record_read(path: &Path) {
    READ_FILES.with_borrow_mut(|paths| {
        if let Some(paths) = paths {
            paths.push(path.to_owned());
        }
    });
}

struct ReadProbe;

impl ReadProbe {
    fn start() -> Self {
        READ_FILES.with_borrow_mut(|paths| *paths = Some(Vec::new()));
        HASHED_FILES.with_borrow_mut(|paths| *paths = Some(Vec::new()));
        Self
    }
}

impl Drop for ReadProbe {
    fn drop(&mut self) {
        READ_FILES.with_borrow_mut(|paths| *paths = None);
        HASHED_FILES.with_borrow_mut(|paths| *paths = None);
    }
}

fn payload_reads() -> Vec<PathBuf> {
    READ_FILES.with_borrow(|paths| {
        paths
            .iter()
            .flatten()
            .filter(|path| path.file_name().is_some_and(|name| name == "payload.bin"))
            .cloned()
            .collect()
    })
}

struct Fixture {
    _root: tempfile::TempDir,
    store: GlobalCapabilityStore,
    spec: PluginSyncSpec,
    source: PathBuf,
}

impl Fixture {
    fn new(codex_only: bool, manifests: &[&str]) -> Self {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("package");
        fs::create_dir_all(&source).unwrap();
        for relative in manifests {
            let path = source.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, r#"{"name":"demo","version":"1.0","description":"Demo","skills":"./skills/","interface":{"displayName":"Demo"}}"#).unwrap();
        }
        fs::write(source.join("payload.bin"), vec![42; 1024 * 1024]).unwrap();
        fs::create_dir_all(source.join("hooks")).unwrap();
        fs::write(source.join("hooks/start.sh"), "#!/bin/sh\nexit 0\n").unwrap();
        let mut store = GlobalCapabilityStore::new(
            root.path().join("state/manifest-v2.json"),
            root.path().join("claude/skills"),
        )
        .with_plugins_dir(root.path().join("claude/plugins"))
        .with_codex_plugins_dir(root.path().join("codex/plugins"))
        .with_workbench_root(root.path().join("workbench"));
        store.codex_only_plugins = codex_only;
        let spec = PluginSyncSpec::from_value(&json!({
            "name":"demo", "marketplace":"wegent", "version":"1.0",
        }))
        .unwrap();
        Self {
            _root: root,
            store,
            spec,
            source,
        }
    }

    fn runtimes(&self) -> Vec<PathBuf> {
        self.store
            .plugin_runtime_targets(&self.spec)
            .into_iter()
            .map(|(path, _)| path)
            .collect()
    }

    fn install_copies(&self) {
        for runtime in self.runtimes() {
            self.copy_to(&runtime);
        }
    }

    fn marketplace_copies(&self) -> Vec<PathBuf> {
        self.store
            .plugin_runtime_targets(&self.spec)
            .into_iter()
            .map(|(_, field)| {
                let claude = field == "claude_link";
                let market = if claude {
                    self.store.claude_marketplace_dir(&self.spec.marketplace)
                } else {
                    self.store.codex_marketplace_dir(&self.spec.marketplace)
                };
                market
                    .join("plugins")
                    .join(self.store.marketplace_plugin_name(&self.spec, claude))
            })
            .collect()
    }

    fn copy_to(&self, path: &Path) {
        copy_dir_atomic(&self.source, path).unwrap();
        ensure_dual_plugin_manifests(path).unwrap();
        ensure_plugin_hook_permissions(path).unwrap();
    }

    fn reused(&self) -> BTreeSet<PathBuf> {
        self.store
            .unchanged_plugin_runtime_paths(&self.spec, &self.source)
            .unwrap()
    }
}

#[test]
fn reuse_reads_payload_once_per_actual_tree_without_rehashing_or_a_payload_template() {
    for (codex_only, marketplace_copies) in
        [(true, false), (false, false), (true, true), (false, true)]
    {
        let fixture = Fixture::new(codex_only, &[CODEX_PLUGIN_MANIFEST_PATH]);
        fixture.install_copies();
        let mut expected_paths = fixture.runtimes();
        if marketplace_copies {
            for path in fixture.marketplace_copies() {
                fixture.copy_to(&path);
                expected_paths.push(path);
            }
        }
        let _probe = ReadProbe::start();

        let reused = fixture.reused();

        assert!(expected_paths.iter().all(|path| reused.contains(path)));
        let mut expected = vec![fixture.source.join("payload.bin")];
        expected.extend(expected_paths.iter().map(|path| path.join("payload.bin")));
        expected.sort();
        let mut actual = payload_reads();
        actual.sort();
        assert_eq!(
            actual, expected,
            "Every payload must be read only once, without a staging copy"
        );
        HASHED_FILES.with_borrow(|paths| {
            assert!(
                paths
                    .iter()
                    .flatten()
                    .all(|path| path.file_name().unwrap() != "payload.bin"),
                "Runtime comparison must not recompute payload SHA256"
            );
        });
    }
}

#[test]
fn marketplace_directory_copies_are_verified_independently_of_the_runtime() {
    let fixture = Fixture::new(true, &[CODEX_PLUGIN_MANIFEST_PATH]);
    fixture.install_copies();
    let market = &fixture.marketplace_copies()[0];
    fixture.copy_to(market);
    assert!(fixture.reused().contains(market));

    fs::write(market.join("payload.bin"), vec![43; 1024 * 1024]).unwrap();

    let reused = fixture.reused();
    assert!(!reused.contains(market));
    assert!(fixture.runtimes().iter().all(|path| reused.contains(path)));
}

#[test]
fn first_install_does_not_prepare_a_comparison_template() {
    let fixture = Fixture::new(true, &[CODEX_PLUGIN_MANIFEST_PATH]);
    let _probe = ReadProbe::start();

    assert!(fixture.reused().is_empty());

    assert!(payload_reads().is_empty());
}

#[test]
fn normalized_manifests_and_hook_permissions_match_in_both_runtime_layouts() {
    for codex_only in [true, false] {
        for manifests in [
            vec![CODEX_PLUGIN_MANIFEST_PATH],
            vec![CLAUDE_PLUGIN_MANIFEST_PATH],
            vec![CODEX_PLUGIN_MANIFEST_PATH, CLAUDE_PLUGIN_MANIFEST_PATH],
        ] {
            let fixture = Fixture::new(codex_only, &manifests);
            fixture.install_copies();

            assert_eq!(fixture.reused(), fixture.runtimes().into_iter().collect());
            assert_eq!(
                fixture.source.join(CODEX_PLUGIN_MANIFEST_PATH).exists(),
                manifests.contains(&CODEX_PLUGIN_MANIFEST_PATH)
            );
            assert_eq!(
                fixture.source.join(CLAUDE_PLUGIN_MANIFEST_PATH).exists(),
                manifests.contains(&CLAUDE_PLUGIN_MANIFEST_PATH)
            );
        }
    }
}

#[test]
fn corrupt_missing_and_unexpected_files_never_qualify_for_reuse() {
    for change in [
        "content",
        "truncated",
        "appended",
        "missing",
        "extra",
        "manifest",
        "published-bytecode",
    ] {
        let fixture = Fixture::new(true, &[CODEX_PLUGIN_MANIFEST_PATH]);
        fs::create_dir_all(fixture.source.join("__pycache__")).unwrap();
        fs::write(
            fixture.source.join("__pycache__/published.pyc"),
            "published",
        )
        .unwrap();
        fixture.install_copies();
        let runtime = &fixture.runtimes()[0];
        match change {
            "content" => fs::write(runtime.join("payload.bin"), vec![43; 1024 * 1024]).unwrap(),
            "truncated" => {
                fs::write(runtime.join("payload.bin"), vec![42; 1024 * 1024 - 1]).unwrap()
            }
            "appended" => {
                fs::write(runtime.join("payload.bin"), vec![42; 1024 * 1024 + 1]).unwrap()
            }
            "missing" => fs::remove_file(runtime.join("payload.bin")).unwrap(),
            "extra" => fs::write(runtime.join("extra.txt"), "unexpected").unwrap(),
            "manifest" => fs::write(
                runtime.join(CODEX_PLUGIN_MANIFEST_PATH),
                r#"{"name":"other"}"#,
            )
            .unwrap(),
            "published-bytecode" => {
                fs::write(runtime.join("__pycache__/published.pyc"), "corrupted").unwrap()
            }
            _ => unreachable!(),
        }

        assert!(!fixture.reused().contains(runtime), "{change}");
    }
}

#[test]
fn generated_bytecode_is_ignored_but_each_probe_rechecks_runtime_content() {
    let fixture = Fixture::new(true, &[CODEX_PLUGIN_MANIFEST_PATH]);
    fixture.install_copies();
    let runtime = &fixture.runtimes()[0];
    fs::create_dir_all(runtime.join("__pycache__")).unwrap();
    fs::write(runtime.join("__pycache__/generated.pyc"), "generated").unwrap();
    assert!(fixture.reused().contains(runtime));

    fs::write(runtime.join("payload.bin"), vec![43; 1024 * 1024]).unwrap();

    assert!(!fixture.reused().contains(runtime));
}

#[cfg(unix)]
#[test]
fn changed_execute_bits_and_nested_symlinks_never_qualify_for_reuse() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    for change in ["hook-mode", "payload-mode", "symlink"] {
        let fixture = Fixture::new(true, &[CODEX_PLUGIN_MANIFEST_PATH]);
        fixture.install_copies();
        let runtime = &fixture.runtimes()[0];
        let payload = runtime.join("payload.bin");
        match change {
            "hook-mode" => fs::set_permissions(
                runtime.join("hooks/start.sh"),
                fs::Permissions::from_mode(0o644),
            )
            .unwrap(),
            "payload-mode" => {
                fs::set_permissions(&payload, fs::Permissions::from_mode(0o755)).unwrap()
            }
            "symlink" => {
                fs::remove_file(&payload).unwrap();
                symlink(fixture.source.join("payload.bin"), &payload).unwrap();
            }
            _ => unreachable!(),
        }

        assert!(!fixture.reused().contains(runtime), "{change}");
        assert_eq!(
            fs::read(fixture.source.join("payload.bin")).unwrap(),
            vec![42; 1024 * 1024]
        );
    }
}
