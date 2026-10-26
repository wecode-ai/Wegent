// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

pub(super) fn install_native_history(
    handler: &mut RuntimeWorkRpcHandler,
    root: &std::path::Path,
    turns: Vec<Value>,
    next_cursor: Option<&str>,
) {
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
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
    let directory = format!("'{}'", root.display().to_string().replace('\'', "'\"'\"'"));
    let binary = root.join("native-history.sh");
    fs::write(
        &binary,
        format!(
            r#"#!/bin/sh
cd /
while IFS= read -r line; do
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  [ -n "$id" ] || continue
  method=$(printf '%s\n' "$line" | sed -n 's/.*"method":"\([^"]*\)".*/\1/p' | tr '/' '_')
  if [ "$method" = "test_stop" ]; then
    printf '{{"id":%s,"result":{{}}}}\n' "$id"
    exit 0
  fi
  error_file={directory}/"$method".error-once.json
  if [ -f "$error_file" ]; then
    printf '{{"id":%s,"error":' "$id"
    cat "$error_file"
    rm "$error_file"
    printf '}}\n'
    continue
  fi
  printf '{{"id":%s,"result":' "$id"
  cat {directory}/"$method".json
  printf '}}\n'
done
"#
        ),
    )
    .unwrap();
    #[cfg(unix)]
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
    #[cfg(windows)]
    let binary = {
        let script = root.join("native-history.ps1");
        fs::write(
            script,
            r#"while ($null -ne ($line = [Console]::ReadLine())) {
  $request = ConvertFrom-Json $line
  if ($null -eq $request.id) { continue }
  if ($request.method -eq 'test/stop') {
    [Console]::WriteLine((@{id=$request.id;result=@{}} | ConvertTo-Json -Compress))
    break
  }
  $method = $request.method.Replace('/', '_')
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
