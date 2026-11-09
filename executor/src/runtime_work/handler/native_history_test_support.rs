// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

pub(in crate::runtime_work::handler) async fn stop_native_history(handler: &RuntimeWorkRpcHandler) {
    handler
        .codex_app_server
        .request("test/stop", json!({}))
        .await
        .unwrap();
    handler.codex_app_server.restart().await;
}

pub(in crate::runtime_work::handler) fn install_native_history(
    handler: &mut RuntimeWorkRpcHandler,
    root: &std::path::Path,
    turns: Vec<Value>,
    next_cursor: Option<&str>,
) {
    fs::create_dir_all(root).unwrap();
    let terminal_boundary = |turn: &Value| {
        matches!(
            turn["status"].as_str(),
            Some("completed" | "interrupted" | "failed")
        )
    };
    let item_count: usize = turns
        .iter()
        .map(|turn| {
            1 + turn["items"].as_array().unwrap().len() + usize::from(terminal_boundary(turn))
        })
        .sum();
    let padding = if next_cursor.is_some() {
        500usize.saturating_sub(item_count)
    } else {
        0
    };
    let mut entries: Vec<Value> = (0..padding)
        .map(|position| json!({"type":"realtime","position":position}))
        .collect();
    let mut metadata = Vec::new();
    for mut turn in turns {
        entries.push(json!({"type":"turnStarted","position":entries.len(),"turnId":turn["id"]}));
        for item in turn["items"].as_array().unwrap() {
            entries.push(
                json!({"type":"item","position":entries.len(),"turnId":turn["id"],"item":item}),
            );
        }
        if terminal_boundary(&turn) {
            entries.push(json!({
                "type":"turnCompleted","position":entries.len(),"turnId":turn["id"],
                "status":turn["status"],"completedAt":turn["completedAt"],
                "durationMs":turn["durationMs"],"error":turn["error"]
            }));
        }
        turn["items"] = json!([]);
        metadata.insert(0, turn);
    }
    for (method, response) in [
        ("initialize", json!({"userAgent":"test"})),
        ("thread_list", json!({"data":[],"nextCursor":null})),
        (
            "thread_read",
            json!({"thread":{"id":"thread-1","cwd":"/tmp/project","historyMode":"paginated"}}),
        ),
        (
            "thread_turns_list",
            json!({"data":metadata,"nextCursor":null}),
        ),
        (
            "thread_timeline_list",
            json!({"data":entries,"nextCursor":next_cursor}),
        ),
    ] {
        fs::write(root.join(format!("{method}.json")), response.to_string()).unwrap();
    }
    #[cfg(unix)]
    let binary = {
        // Never execute a freshly written inode: concurrent forks can retain its
        // writer descriptor until exec and cause ETXTBSY on Linux.
        let binary = root.join("native-history.sh");
        let fixture =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/native-history.sh");
        std::os::unix::fs::symlink(fixture, &binary).unwrap();
        binary
    };
    #[cfg(windows)]
    let binary = {
        let script = root.join("native-history.ps1");
        fs::write(
            script,
            r#"while ($null -ne ($line = [Console]::ReadLine())) {
  [IO.File]::AppendAllText((Join-Path $PSScriptRoot 'requests.jsonl'), $line + [Environment]::NewLine)
  $request = ConvertFrom-Json $line
  if ($null -eq $request.id) { continue }
  if ($request.method -eq 'test/stop') {
    [Console]::WriteLine((@{id=$request.id;result=@{}} | ConvertTo-Json -Compress))
    break
  }
  $method = $request.method.Replace('/', '_')
  if ($method -eq 'thread_list' -and $request.params.cursor -eq 'page-2') { $method = 'thread_list_page2' }
  $errorFile = Join-Path $PSScriptRoot ($method + '.error-once.json')
  if (Test-Path $errorFile) {
    $failure = ConvertFrom-Json ([IO.File]::ReadAllText($errorFile))
    Remove-Item $errorFile
    [Console]::WriteLine((@{id=$request.id;error=$failure} | ConvertTo-Json -Depth 100 -Compress))
    continue
  }
  $result = ConvertFrom-Json ([IO.File]::ReadAllText((Join-Path $PSScriptRoot ($method + '.json'))))
  [Console]::WriteLine((@{id=$request.id;result=$result} | ConvertTo-Json -Depth 100 -Compress))
}"#,
        )
        .unwrap();
        let binary = root.join("native-history.cmd");
        fs::write(&binary, "@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0native-history.ps1\"\r\n").unwrap();
        binary
    };
    handler.codex_app_server =
        CodexAppServerClient::isolated_for_test(binary.to_str().unwrap(), root.join("native-home"));
}
