// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::io::Read;

use super::super::*;

#[test]
fn older_native_pages_cannot_overwrite_a_newer_file_change_artifact() {
    let _environment = crate::agents::CodexLaunchEnvironment::new();
    let workspace = tempfile::tempdir().unwrap();
    let file = workspace.path().join("file.txt");
    let project_page = |id: &str, replacement: &str| {
        let thread = json!({"id":"thread-1","cwd":workspace.path(),"timeline":true,"turns":[{
            "id":"turn-1","status":"completed","items":[{
                "id":id,"type":"patchApplyEnd","status":"completed","changes":{
                    (file.to_string_lossy().to_string()):{
                        "type":"update","unified_diff":format!("@@ -1 +1 @@\n-old\n+{replacement}\n")
                    }
                }
            }]
        }]});
        project_transcript_cancellable(
            &thread,
            "device-1",
            true,
            true,
            &super::super::super::transcript_work::Cancellation::new(),
        )
        .unwrap()
        .turns[0]["fileChanges"]
            .clone()
    };
    let read_patch = |summary: &Value| {
        let id = summary["artifact_id"].as_str().unwrap();
        let path = executor_home()
            .join("artifacts")
            .join(id)
            .join("changes.patch.gz");
        let mut patch = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(path).unwrap())
            .read_to_string(&mut patch)
            .unwrap();
        patch
    };
    let newest = project_page("patch-new", "newest");
    let newest_patch = read_patch(&newest);
    let older = project_page("patch-old", "older");

    assert_ne!(newest["artifact_id"], older["artifact_id"]);
    assert!(newest_patch.contains("+newest\n"));
    assert!(read_patch(&older).contains("+older\n"));
    assert_eq!(read_patch(&newest), newest_patch);
}
