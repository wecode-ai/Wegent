// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeSet, fs, path::Path};

use serde_json::json;
use wegent_executor::local::app_ipc::AppIpcServer;

fn collect_production_typescript_files(root: &Path, files: &mut Vec<std::path::PathBuf>) {
    for entry in fs::read_dir(root).expect("Wework source directory should be readable") {
        let entry = entry.expect("Wework source entry should be readable");
        let path = entry.path();
        if path.is_dir() {
            if path.file_name().is_some_and(|name| name == "__tests__") {
                continue;
            }
            collect_production_typescript_files(&path, files);
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if (name.ends_with(".ts") || name.ends_with(".tsx"))
            && !name.contains(".test.")
            && !name.contains(".spec.")
        {
            files.push(path);
        }
    }
}

fn renderer_plugin_methods(source_root: &Path) -> BTreeSet<String> {
    const PREFIX: &str = "executor.plugins.";

    let mut files = Vec::new();
    collect_production_typescript_files(source_root, &mut files);
    let mut methods = BTreeSet::new();
    for path in files {
        let source = fs::read_to_string(&path).expect("Wework source file should be UTF-8");
        let mut remaining = source.as_str();
        while let Some(index) = remaining.find(PREFIX) {
            let candidate = &remaining[index..];
            let length = candidate
                .chars()
                .take_while(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '.' | '_')
                })
                .map(char::len_utf8)
                .sum::<usize>();
            methods.insert(candidate[..length].to_owned());
            remaining = &candidate[length..];
        }
    }
    methods
}

fn method_is_declared(method: &str, declared: &[String]) -> bool {
    declared.iter().any(|candidate| {
        candidate == method
            || candidate
                .strip_suffix(".*")
                .is_some_and(|prefix| method.starts_with(&format!("{prefix}.")))
    })
}

#[tokio::test]
async fn every_renderer_plugin_method_is_declared_by_executor() {
    let repository_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("Executor should live below the repository root");
    let methods = renderer_plugin_methods(&repository_root.join("wework/src"));
    assert!(
        methods.contains("executor.plugins.personal.package"),
        "renderer plugin method extraction should find the packaging path"
    );

    let description = AppIpcServer::new()
        .dispatch("executor.protocol.describe", json!({}))
        .await
        .expect("protocol description should succeed");
    let declared = description["renderer_methods"]
        .as_array()
        .expect("renderer_methods should be an array")
        .iter()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let missing = methods
        .iter()
        .filter(|method| !method_is_declared(method, &declared))
        .cloned()
        .collect::<Vec<_>>();

    assert!(
        missing.is_empty(),
        "Wework Renderer calls plugin methods that Executor does not declare: {missing:?}"
    );
}
