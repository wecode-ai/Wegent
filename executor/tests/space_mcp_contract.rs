// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Process-level contract for the `space-mcp-server` (wework_space) executable.
//!
//! This is the E2E guard for the migrate() ordering bug: on a legacy local
//! database (loop_items without `assignee_agent_id`), the MCP server must still
//! start, complete the MCP initialize handshake, and expose the project-space
//! tools. A failed migration makes the process exit before the handshake and
//! Codex reports "MCP server 'wework_space' was not ready for this step".

use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    time::timeout,
};

const BIN: &str = env!("CARGO_BIN_EXE_wegent-executor");

fn temp_home(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!("wegent-space-mcp-{label}-{}", std::process::id()))
}

/// Seed a legacy tasks.sqlite that predates robot support (no
/// `assignee_agent_id` column, no `loop_item_executions` table).
fn seed_legacy_database(home: &Path) {
    let data_dir = home.join("data");
    std::fs::create_dir_all(&data_dir).unwrap();
    let connection = rusqlite::Connection::open(data_dir.join("tasks.sqlite")).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            );
            CREATE TABLE loop_items (
                id TEXT PRIMARY KEY,
                resource_type TEXT NOT NULL,
                project_space TEXT NOT NULL DEFAULT 'default',
                cloud_project_id TEXT,
                parent_id TEXT,
                loop_item_id TEXT,
                delivery_id TEXT,
                public_id TEXT UNIQUE,
                project_key TEXT UNIQUE,
                name TEXT,
                title TEXT,
                description TEXT NOT NULL DEFAULT '',
                storage_prefix TEXT UNIQUE,
                sequence_number INTEGER,
                next_item_number INTEGER,
                created_by_user_id INTEGER,
                updated_by_user_id INTEGER,
                assignee_user_id INTEGER,
                user_id INTEGER,
                added_by_user_id INTEGER,
                source TEXT,
                status TEXT,
                priority TEXT,
                due_at TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0,
                current_delivery_id TEXT,
                local_project_id INTEGER,
                device_id TEXT,
                is_default INTEGER,
                task_user_id INTEGER,
                task_id TEXT,
                task_title TEXT,
                backend_task_id INTEGER,
                linked_by_user_id INTEGER,
                linked_at TEXT,
                unlinked_at TEXT,
                path TEXT,
                kind TEXT,
                display_name TEXT,
                relative_path TEXT,
                object_key TEXT,
                content_type TEXT,
                size_bytes INTEGER,
                sha256 TEXT,
                source_task_binding_id TEXT,
                source_task_snapshot TEXT,
                markdown_object_key TEXT,
                chat_object_key TEXT,
                manifest_object_key TEXT,
                metadata TEXT,
                version INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                completed_at TEXT,
                delivered_at TEXT,
                deleted_at TEXT
            );
            INSERT INTO schema_migrations(version, applied_at) VALUES (3, '2026-08-01T00:00:00+00:00');",
        )
        .unwrap();
    drop(connection);
}

struct McpChild {
    process: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    stdout: BufReader<tokio::process::ChildStdout>,
    next_id: u64,
}

impl McpChild {
    async fn spawn(home: &Path) -> Self {
        let mut process = Command::new(BIN)
            .arg("space-mcp-server")
            .env("WEGENT_EXECUTOR_HOME", home)
            .env_remove("WEGENT_BACKEND_URL")
            .env_remove("WEGENT_AUTH_TOKEN")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = process.stdin.take().unwrap();
        let stdout = BufReader::new(process.stdout.take().unwrap());
        let mut child = Self {
            process,
            stdin,
            stdout,
            next_id: 1,
        };
        // Drain stderr asynchronously so a write never blocks.
        if let Some(stderr) = child.process.stderr.take() {
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                while reader.read_line(&mut line).await.is_ok_and(|count| count > 0) {
                    line.clear();
                }
            });
        }
        child
    }

    async fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        self.stdin
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        self.stdin.flush().await.unwrap();
        let mut line = String::new();
        let count = timeout(Duration::from_secs(15), self.stdout.read_line(&mut line))
            .await
            .expect("space-mcp-server did not answer in time")
            .expect("failed to read space-mcp-server response");
        assert!(count > 0, "space-mcp-server closed stdout without a response");
        serde_json::from_str(&line).unwrap()
    }
}

#[tokio::test]
async fn space_mcp_server_handshakes_on_a_legacy_database() {
    let home = temp_home("legacy");
    let _ = std::fs::remove_dir_all(&home);
    seed_legacy_database(&home);

    let mut child = McpChild::spawn(&home).await;
    let initialize = child
        .request(
            "initialize",
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "space-mcp-contract", "version": "1"},
            }),
        )
        .await;
    assert_eq!(
        initialize["result"]["serverInfo"]["name"],
        json!("wework_space")
    );

    let tools = child.request("tools/list", json!({})).await;
    let names = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect::<Vec<_>>();
    assert!(names.contains(&"list_spaces"));
    assert!(names.contains(&"create_board_item"));
    assert!(names.contains(&"get_board_item"));

    // list_spaces without a backend falls back to local projects and succeeds.
    let spaces = child.request("tools/call", json!({"name": "list_spaces", "arguments": {}})).await;
    assert!(spaces.get("error").is_none(), "list_spaces failed: {spaces}");

    child.process.kill().await.unwrap();
    child.process.wait().await.unwrap();
    let _ = std::fs::remove_dir_all(&home);
}

#[tokio::test]
async fn space_mcp_server_exposes_environment_for_cloud_bound_projects() {
    let home = temp_home("cloud-env");
    let _ = std::fs::remove_dir_all(&home);
    seed_legacy_database(&home);

    let mut process = Command::new(BIN)
        .arg("space-mcp-server")
        .env("WEGENT_EXECUTOR_HOME", &home)
        .env("WEGENT_BACKEND_URL", "https://backend.example.com")
        .env("WEGENT_AUTH_TOKEN", "space-token")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stdin = process.stdin.take().unwrap();
    let stdout = BufReader::new(process.stdout.take().unwrap());
    let mut child = McpChild {
        process,
        stdin,
        stdout,
        next_id: 1,
    };
    if let Some(stderr) = child.process.stderr.take() {
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            while reader.read_line(&mut line).await.is_ok_and(|count| count > 0) {
                line.clear();
            }
        });
    }
    let initialize = child
        .request(
            "initialize",
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "space-mcp-contract", "version": "1"},
            }),
        )
        .await;
    assert_eq!(
        initialize["result"]["serverInfo"]["name"],
        json!("wework_space")
    );

    child.process.kill().await.unwrap();
    child.process.wait().await.unwrap();
    let _ = std::fs::remove_dir_all(&home);
}
