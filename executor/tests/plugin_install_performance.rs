// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Controlled local comparison. Only package transport is simulated; publication,
//! integrity checks, runtime installation and configuration use the filesystem.

use std::{
    collections::BTreeMap,
    fs,
    future::Future,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime},
};

use serde_json::json;
use wegent_executor::{
    local::capabilities::{
        CapabilityPackageProvider, CapabilitySyncError, CapabilitySyncHandler,
        GlobalCapabilityStore, SkillSyncSpec,
    },
    services::workbench::archive_hash,
};

#[derive(Default)]
struct DownloadMetrics {
    count: AtomicUsize,
    bytes: AtomicUsize,
    nanoseconds: AtomicU64,
}

struct Packages {
    archives: BTreeMap<String, Vec<u8>>,
    metrics: Arc<DownloadMetrics>,
}

impl CapabilityPackageProvider for Packages {
    fn stage_skill<'a>(
        &'a self,
        _spec: &'a SkillSyncSpec,
        _target: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<(), CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async { panic!("This fixture syncs plugins only") })
    }

    fn download_plugin<'a>(
        &'a self,
        path: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async move {
            let started = Instant::now();
            tokio::time::sleep(Duration::from_millis(10)).await;
            let bytes = self
                .archives
                .get(path)
                .expect("Known fixture package")
                .clone();
            self.metrics.count.fetch_add(1, Ordering::SeqCst);
            self.metrics.bytes.fetch_add(bytes.len(), Ordering::SeqCst);
            self.metrics
                .nanoseconds
                .fetch_add(started.elapsed().as_nanos() as u64, Ordering::SeqCst);
            Ok(bytes)
        })
    }
}

fn archive(name: &str) -> Vec<u8> {
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (path, content) in [
        (
            ".claude-plugin/plugin.json",
            json!({"name": name, "version": "1.0.0"}).to_string(),
        ),
        ("payload.txt", format!("Small immutable package {name}")),
    ] {
        archive
            .start_file(path, zip::write::FileOptions::default())
            .unwrap();
        archive.write_all(content.as_bytes()).unwrap();
    }
    archive.finish().unwrap().into_inner()
}

fn modified_runtime_directories(store: &GlobalCapabilityStore) -> BTreeMap<PathBuf, SystemTime> {
    store.manifest.load().unwrap()["plugins"]
        .as_object()
        .unwrap()
        .values()
        .map(|plugin| {
            let path = PathBuf::from(plugin["runtime"]["claude_link"].as_str().unwrap());
            let modified = fs::metadata(&path).unwrap().modified().unwrap();
            (path, modified)
        })
        .collect()
}

#[tokio::test]
async fn installing_three_plugins_only_materializes_the_three_changes() {
    let baseline = std::env::var("WEGENT_PLUGIN_PERF_BASELINE").is_ok_and(|value| value == "1");
    let root = tempfile::tempdir().unwrap();
    let store = GlobalCapabilityStore::new(
        root.path().join("state/manifest-v2.json"),
        root.path().join("claude/skills"),
    )
    .with_plugins_dir(root.path().join("claude/plugins"))
    .with_codex_skills_dir(root.path().join("codex/skills"))
    .with_codex_plugins_dir(root.path().join("codex/plugins"))
    .with_workbench_root(root.path().join("workbench"));
    let metrics = Arc::new(DownloadMetrics::default());
    let mut archives = BTreeMap::new();
    let plugins = (0..16)
        .map(|index| {
            let name = format!("plugin-{index:02}");
            let path = format!("/package/{name}");
            let bytes = archive(&name);
            let checksum = archive_hash(&bytes);
            archives.insert(path.clone(), bytes);
            json!({"name": name, "marketplace": "wegent", "version": "1.0.0",
            "installed_plugin_id": index + 1, "download_path": path, "checksum": checksum})
        })
        .collect::<Vec<_>>();
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        Packages {
            archives,
            metrics: metrics.clone(),
        },
    );
    let warmed = handler
        .apply_sync(json!({"scope": "plugins", "plugins": &plugins[..13]}))
        .await
        .unwrap();
    assert_eq!(warmed["success"], true);
    let initial_files = modified_runtime_directories(&store);
    metrics.count.store(0, Ordering::SeqCst);
    metrics.bytes.store(0, Ordering::SeqCst);
    metrics.nanoseconds.store(0, Ordering::SeqCst);
    let started = Instant::now();
    let mut request_ms = Vec::new();
    for index in 13..16 {
        let payload = if baseline {
            json!({"scope": "plugins", "plugins": &plugins[..=index]})
        } else {
            json!({"scope": "plugin_delta", "mode": "merge", "plugins": [plugins[index].clone()],
                "plugin_sync": {"version": 2, "generation": index - 12, "complete": false}})
        };
        let request_started = Instant::now();
        let result = handler.apply_sync(payload).await.unwrap();
        assert_eq!(result["success"], true);
        if !baseline {
            assert_eq!(result["plugin_sync"]["version"], 2);
        }
        request_ms.push(request_started.elapsed().as_secs_f64() * 1000.0);
    }
    let total_ms = started.elapsed().as_secs_f64() * 1000.0;
    let rewrites = initial_files
        .iter()
        .filter(|(path, modified)| fs::metadata(path).unwrap().modified().unwrap() != **modified)
        .count();
    let downloads = metrics.count.load(Ordering::SeqCst);
    assert_eq!(downloads, if baseline { 45 } else { 3 });
    assert_eq!(
        store.manifest.load().unwrap()["plugins"]
            .as_object()
            .unwrap()
            .len(),
        16
    );
    if !baseline {
        assert_eq!(rewrites, 0);
    }
    let result = json!({"mode": if baseline {"baseline_full_sync"} else {"optimized_plugin_delta"},
        "initial_plugins": 13, "new_plugins": 3, "simulated_download_delay_ms": 10,
        "download_count": downloads, "download_bytes": metrics.bytes.load(Ordering::SeqCst),
        "download_ms": metrics.nanoseconds.load(Ordering::SeqCst) as f64 / 1_000_000.0,
        "total_ms": total_ms, "request_ms": request_ms, "existing_runtime_rewrites": rewrites});
    println!("PLUGIN_INSTALL_PERFORMANCE_RESULT {result}");
    if let Some(path) = std::env::var_os("WEGENT_PLUGIN_PERF_RESULT_PATH") {
        fs::write(path, serde_json::to_vec_pretty(&result).unwrap()).unwrap();
    }
}
