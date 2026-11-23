// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! External Issue reads create a local shadow only after provider authorization.

use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::{SystemTime, UNIX_EPOCH};

use brz_mysql::{Json, MysqlRow, MysqlService};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::super::assignments::ensure_shadow;

struct Provider {
    base: String,
    calls: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

impl Provider {
    async fn start(provider: &str, concurrent: bool) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let captured = calls.clone();
        let provider = provider.to_owned();
        let barrier = concurrent.then(|| Arc::new(tokio::sync::Barrier::new(2)));
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let calls = captured.clone();
                let provider = provider.clone();
                let barrier = barrier.clone();
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                        let mut chunk = [0; 2048];
                        let count = socket.read(&mut chunk).await.unwrap();
                        assert!(count > 0);
                        request.extend_from_slice(&chunk[..count]);
                    }
                    let request = String::from_utf8(request).unwrap();
                    let path = request
                        .lines()
                        .next()
                        .unwrap()
                        .split_whitespace()
                        .nth(1)
                        .unwrap();
                    let number: i64 = path.rsplit('/').next().unwrap().parse().unwrap();
                    calls.fetch_add(1, Ordering::SeqCst);
                    if let Some(barrier) = barrier {
                        barrier.wait().await;
                    }
                    let status = match number {
                        10 => 404,
                        13 => 503,
                        _ => 200,
                    };
                    let body = issue(&provider, number).to_string();
                    socket.write_all(format!(
                        "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()
                    ).as_bytes()).await.unwrap();
                });
            }
        });
        Self { base, calls, task }
    }
}

impl Drop for Provider {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn issue(provider: &str, number: i64) -> Value {
    let mut labels = vec![
        "wegent:creator:7:Owner".to_owned(),
        "wegent:status:in_progress".to_owned(),
        "wegent:priority:high".to_owned(),
        "topic".to_owned(),
    ];
    if matches!(number, 11 | 12) {
        labels.push("wegent:security:related".into());
    }
    if number == 12 {
        labels.push("wegent:assignee:user:8:Viewer".into());
    }
    let mut issue = json!({
        "title":"External task", "state":"opened", "labels":labels,
        "created_at":"2026-11-01T00:00:00Z", "updated_at":"2026-11-02T00:00:00Z",
    });
    if provider == "github" {
        issue["number"] = json!(number);
        issue["body"] = json!("  Requirements\nWegent-Parent: EXT-1\nMore details  ");
    } else {
        issue["iid"] = json!(number);
        issue["description"] = json!("  Requirements\nWegent-Parent: EXT-1\nMore details  ");
    }
    issue
}

struct Fixture {
    admin: MysqlService,
    mysql: MysqlService,
    database: String,
}

impl Fixture {
    async fn new(provider: &str, base: &str) -> Self {
        let address: std::net::SocketAddr = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
            .expect("disposable loopback MySQL required")
            .parse()
            .unwrap();
        assert!(address.ip().is_loopback());
        let admin =
            MysqlService::connect(&format!("mysql://root@{address}/mysql?ssl-mode=disabled"))
                .await
                .unwrap();
        let database = format!(
            "shadow_{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        admin
            .execute(format!("CREATE DATABASE {database}"), ())
            .await
            .unwrap();
        let mysql = MysqlService::connect(&format!(
            "mysql://root@{address}/{database}?ssl-mode=disabled"
        ))
        .await
        .unwrap();
        mysql
            .execute(wegent_backend_test_support::LOOP_ITEMS_NULLABLE_SQL, ())
            .await
            .unwrap();
        for sql in include_str!("../../tests/fixtures/assignment_access.sql")
            .split(';')
            .map(str::trim)
            .filter(|sql| !sql.is_empty())
        {
            mysql.execute(sql, ()).await.unwrap();
        }
        mysql.execute(
            "INSERT INTO loop_items(id,resource_type,project_key,name,description,status,created_by_user_id,metadata,created_at,updated_at) VALUES ('1001','project','EXT','External project','','active',7,?,NOW(),NOW())",
            (Json(json!({"task_provider":provider,"default_issue_security":"open","provider_config":provider_config(provider, base)})),),
        ).await.unwrap();
        let columns = super::super::loop_repository::EXECUTION_COLUMNS
            .split(',')
            .map(|column| {
                let column = column
                    .trim()
                    .split(" AS ")
                    .next()
                    .unwrap()
                    .rsplit('.')
                    .next()
                    .unwrap();
                format!("`{column}` TEXT")
            })
            .collect::<Vec<_>>()
            .join(",");
        mysql
            .execute(format!("CREATE TABLE loop_item_executions ({columns})"), ())
            .await
            .unwrap();
        Self {
            admin,
            mysql,
            database,
        }
    }

    async fn close(self) {
        self.mysql.close().await;
        self.admin
            .execute(format!("DROP DATABASE {}", self.database), ())
            .await
            .unwrap();
        self.admin.close().await;
    }
}

fn provider_config(provider: &str, base: &str) -> Value {
    use aes_gcm::{
        Aes256Gcm,
        aead::{Aead, KeyInit, Payload},
    };
    use base64::Engine as _;
    use sha2::{Digest, Sha256};

    let context = format!("{provider}:provider.invalid:example/repo");
    let key = Sha256::digest(b"wegent-cloud-project-provider:attachment-contract-test-key");
    let nonce = [0u8; 12];
    let ciphertext = Aes256Gcm::new_from_slice(&key)
        .unwrap()
        .encrypt(
            (&nonce).into(),
            Payload {
                msg: b"fixture-token",
                aad: context.as_bytes(),
            },
        )
        .unwrap();
    json!({"domain":"provider.invalid","repository":"example/repo","api_base":base,"credential":{
        "version":2,"algorithm":"aes-256-gcm","context":context,
        "nonce":base64::engine::general_purpose::STANDARD.encode(nonce),
        "ciphertext":base64::engine::general_purpose::STANDARD.encode(ciphertext),
    }})
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; invoked by the Backend Rust CI job"]
async fn external_shadow_creation_preserves_provider_access_and_replays() {
    for provider in ["github", "gitlab"] {
        let server = Provider::start(provider, false).await;
        let fixture = Fixture::new(provider, &server.base).await;
        let state = crate::app_test_support::app(fixture.mysql.clone());
        ensure_shadow(&state, "EXT-9", 7).await.unwrap();
        let row: MysqlRow = fixture.mysql.fetch_one("SELECT id,title,description,parent_id,status,priority,metadata FROM loop_items WHERE id='EXT-9'", ()).await.unwrap();
        assert_eq!(
            row.get_required::<String>("title").unwrap(),
            "External task"
        );
        assert_eq!(
            row.get_required::<String>("description").unwrap(),
            "Requirements\nMore details"
        );
        assert_eq!(row.get_required::<String>("parent_id").unwrap(), "EXT-1");
        assert_eq!(row.get_required::<String>("status").unwrap(), "in_progress");
        assert_eq!(row.get_required::<String>("priority").unwrap(), "high");
        assert_eq!(
            row.get_required::<Json<Value>>("metadata").unwrap().0,
            json!({"tags":["topic"],"external_shadow":true})
        );
        fixture.mysql.execute("UPDATE loop_items SET title='Preserved',version=9,metadata=JSON_OBJECT('local',true) WHERE id='EXT-9'", ()).await.unwrap();
        ensure_shadow(&state, "EXT-9", 7).await.unwrap();
        assert_eq!(server.calls.load(Ordering::SeqCst), 1);
        let row: (String, i64, Json<Value>) = fixture
            .mysql
            .fetch_one(
                "SELECT title,version,metadata FROM loop_items WHERE id='EXT-9'",
                (),
            )
            .await
            .unwrap();
        assert_eq!(row, ("Preserved".into(), 9, Json(json!({"local":true}))));
        fixture.close().await;
    }
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; invoked by the Backend Rust CI job"]
async fn shadow_creation_rejects_invisible_missing_and_unrelated_issues() {
    let provider = Provider::start("gitlab", false).await;
    let fixture = Fixture::new("gitlab", &provider.base).await;
    let state = crate::app_test_support::app(fixture.mysql.clone());

    let error = ensure_shadow(&state, "EXT-9", 9).await.unwrap_err();
    assert_eq!(error.status(), brz_http_server::StatusCode::NOT_FOUND);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    for (item, user) in [("EXT-10", 7), ("EXT-11", 8), ("missing-local", 7)] {
        let error = ensure_shadow(&state, item, user).await.unwrap_err();
        assert_eq!(error.status(), brz_http_server::StatusCode::NOT_FOUND);
    }
    let error = ensure_shadow(&state, "EXT-13", 7).await.unwrap_err();
    assert_eq!(error.status(), brz_http_server::StatusCode::BAD_GATEWAY);
    let count: i64 = fixture
        .mysql
        .fetch_one(
            "SELECT COUNT(*) FROM loop_items WHERE resource_type='task'",
            (),
        )
        .await
        .unwrap();
    assert_eq!(count, 0);

    ensure_shadow(&state, "EXT-12", 8).await.unwrap();
    let assignee: i32 = fixture
        .mysql
        .fetch_one(
            "SELECT assignee_user_id FROM loop_items WHERE id='EXT-12'",
            (),
        )
        .await
        .unwrap();
    assert_eq!(assignee, 8);
    fixture.mysql.execute("INSERT INTO loop_items(id,resource_type,cloud_project_id,description,created_by_user_id,created_at,updated_at) VALUES ('local-item','task','1001','Local task',7,NOW(),NOW())", ()).await.unwrap();
    let calls = provider.calls.load(Ordering::SeqCst);
    ensure_shadow(&state, "local-item", 7).await.unwrap();
    assert_eq!(provider.calls.load(Ordering::SeqCst), calls);
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; invoked by the Backend Rust CI job"]
async fn shadow_creation_preserves_legacy_unset_columns() {
    let provider = Provider::start("gitlab", false).await;
    let fixture = Fixture::new("gitlab", &provider.base).await;
    fixture
        .mysql
        .execute(
            "UPDATE loop_items SET assignee_user_id=0, deleted_at='1970-01-01 00:00:01'",
            (),
        )
        .await
        .unwrap();
    fixture.mysql.execute("ALTER TABLE loop_items MODIFY assignee_user_id INT NOT NULL DEFAULT 0, MODIFY deleted_at DATETIME NOT NULL DEFAULT '1970-01-01 00:00:01'", ()).await.unwrap();
    let state = crate::app_test_support::app(fixture.mysql.clone());

    ensure_shadow(&state, "EXT-9", 7).await.unwrap();
    ensure_shadow(&state, "EXT-12", 8).await.unwrap();

    let row: (i32, String, i64) = fixture.mysql.fetch_one("SELECT assignee_user_id, CAST(deleted_at AS CHAR), (public_id IS NULL AND project_key IS NULL AND storage_prefix IS NULL) FROM loop_items WHERE id='EXT-9'", ()).await.unwrap();
    assert_eq!(row, (0, "1970-01-01 00:00:01".into(), 1));
    assert!(
        super::super::loop_repository::LoopItemRepository::new(&fixture.mysql)
            .get_task_item_entity("EXT-9")
            .await
            .unwrap()
            .is_some()
    );
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; invoked by the Backend Rust CI job"]
async fn simultaneous_shadow_creation_keeps_one_row() {
    let provider = Provider::start("gitlab", true).await;
    let fixture = Fixture::new("gitlab", &provider.base).await;
    let state = crate::app_test_support::app(fixture.mysql.clone());

    let (first, second) = tokio::join!(
        ensure_shadow(&state, "EXT-9", 7),
        ensure_shadow(&state, "EXT-9", 7),
    );

    first.unwrap();
    second.unwrap();
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    let count: i64 = fixture
        .mysql
        .fetch_one(
            "SELECT COUNT(*) FROM loop_items WHERE id='EXT-9' AND resource_type='task'",
            (),
        )
        .await
        .unwrap();
    assert_eq!(count, 1);
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; invoked by the Backend Rust CI job"]
async fn shadow_reads_observe_the_primary_before_replication() {
    let provider = Provider::start("gitlab", false).await;
    let writer = Fixture::new("gitlab", &provider.base).await;
    let reader = Fixture::new("gitlab", &provider.base).await;
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS").unwrap();
    let mysql = MysqlService::connect_lazy_read_write_named_with_options(
        &format!(
            "mysql://root@{address}/{}?ssl-mode=disabled",
            writer.database
        ),
        &format!(
            "mysql://root@{address}/{}?ssl-mode=disabled",
            reader.database
        ),
        "external-shadow-test",
        brz_mysql::MysqlServiceOptions::default(),
    )
    .unwrap();
    let state = crate::app_test_support::app(mysql.clone());

    ensure_shadow(&state, "EXT-9", 7).await.unwrap();
    let item = super::super::loop_repository::LoopItemRepository::new(&mysql)
        .get_task_item_entity("EXT-9")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(item.id, "EXT-9");
    super::super::assignments::require_issue_read_for_user(&state, "EXT-9", 7)
        .await
        .unwrap();
    let count: i64 = reader
        .mysql
        .fetch_one("SELECT COUNT(*) FROM loop_items WHERE id='EXT-9'", ())
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "reader stays behind the primary throughout the test"
    );
    mysql.close().await;
    writer.close().await;
    reader.close().await;
}
