// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for the chat attachment upload pipeline
//! (`src/attachments/upload/mod.rs`).

use super::*;
use brz_mysql::{FromMysqlRow, MysqlArgs, MysqlExecution, MysqlResult, MysqlTransaction};

#[test]
fn empty_uploads_are_rejected_before_the_upload_pipeline() {
    for filename in ["image.png", "empty.csv", "empty.txt"] {
        let multipart = Multipart {
            fields: vec![brz_http_server::Upload {
                name: "file".to_owned(),
                filename: Some(filename.to_owned()),
                content_type: None,
                bytes: bytes::Bytes::new(),
            }],
        };
        let error = bind_upload_file(&multipart, None).unwrap_err();
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
        assert_eq!(error.validation_detail(), "\"File is empty\"");
    }
}

#[test]
fn binding_keeps_missing_filename_and_nonempty_file_contracts() {
    let missing = bind_upload_file(&Multipart { fields: vec![] }, None).unwrap_err();
    assert_eq!(missing.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let multipart = Multipart {
        fields: vec![brz_http_server::Upload {
            name: "file".to_owned(),
            filename: Some("document.csv".to_owned()),
            content_type: None,
            bytes: bytes::Bytes::from_static(b"name,value\na,42"),
        }],
    };
    assert_eq!(
        bind_upload_file(&multipart, None).unwrap(),
        ("document.csv", b"name,value\na,42".as_slice())
    );
    let mut missing_filename = multipart;
    missing_filename.fields[0].filename = None;
    let error = bind_upload_file(&missing_filename, None).unwrap_err();
    assert_eq!(error.status(), StatusCode::BAD_REQUEST);
    assert_eq!(error.validation_detail(), "\"Filename is required\"");
}

#[test]
fn empty_overwrites_keep_the_text_document_clearing_contract() {
    for filename in ["document.txt", "document.md"] {
        let multipart = Multipart {
            fields: vec![brz_http_server::Upload {
                name: "file".to_owned(),
                filename: Some(filename.to_owned()),
                content_type: None,
                bytes: bytes::Bytes::new(),
            }],
        };
        let (name, bytes) = bind_upload_file(&multipart, Some(42)).unwrap();
        assert_eq!(name, filename);
        assert!(bytes.is_empty());
        let parsed = document::parse(bytes, &document::extension_of(name)).unwrap();
        assert!(parsed.text.is_empty());
        assert_eq!(parsed.text_length, 0);
    }
}

/// An object store whose write always fails, like the source `save`
/// raising when `put_object` fails.
struct FailingStorageBackend;

#[async_trait::async_trait]
impl AttachmentUploadBackend for FailingStorageBackend {
    fn backend_type(&self) -> &str {
        "minio"
    }

    async fn ensure_ready(&self) -> Result<(), UploadBackendError> {
        Ok(())
    }

    async fn store_object(&self, _: StoreObjectRequest<'_>) -> Result<bool, UploadBackendError> {
        Err(UploadBackendError)
    }

    async fn upload_image_pid(&self, _: ImageUploadRequest<'_>) -> Option<ImagePid> {
        None
    }

    async fn delete_object(&self, _: &str) -> Result<bool, UploadBackendError> {
        Ok(true)
    }
}

/// Records the statements a transaction executes without a database.
#[derive(Default)]
struct StatementLog {
    statements: Vec<String>,
}

impl MysqlTransaction for StatementLog {
    async fn execute<S, A>(&mut self, sql: S, _: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        let collapsed = sql
            .as_ref()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        self.statements.push(collapsed);
        Ok(MysqlExecution {
            rows_affected: 0,
            last_insert_id: 0,
        })
    }

    async fn fetch_optional<S, A, T>(&mut self, sql: S, _: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.statements.push(
            sql.as_ref()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
        );
        Ok(None)
    }

    async fn fetch_one<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<T>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        panic!("unexpected fetch_one")
    }

    async fn fetch_all<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        Ok(Vec::new())
    }

    fn fetch<'transaction, S, A, T>(
        &'transaction mut self,
        _: S,
        _: A,
    ) -> impl futures_util::Stream<Item = MysqlResult<T>> + Send + 'transaction
    where
        S: AsRef<str> + Send + 'transaction,
        A: MysqlArgs + Send + 'transaction,
        T: FromMysqlRow + Send + 'transaction,
    {
        futures_util::stream::once(async { panic!("unexpected streaming query") })
    }
}

/// The owner reload follows the source's image-upload gate, and reuses the
/// projection the recording stores for the reloading statement.
#[test]
fn the_owner_reload_follows_the_image_upload_gate() {
    for image in ["a.png", "b.PNG", "c.jpg", "d.jpeg", "e.gif"] {
        assert!(
            attempts_image_upload(image),
            "{image} runs the image upload"
        );
    }
    for other in ["a.xlsx", "b.docx", "c.pdf", "d.md", "no-extension"] {
        assert!(
            !attempts_image_upload(other),
            "{other} does not run the image upload"
        );
    }
    assert!(USER_ENTITY_BY_ID_QUERY.starts_with("SELECT users.id, users.user_name"));
    assert!(!USER_ENTITY_BY_ID_QUERY.contains("LIMIT"));
}

/// The upload endpoint is registered exactly once by the router that
/// `Application` builds; the route table selects the same method and path.
#[test]
fn the_upload_route_is_registered_once() {
    // `method_bit`: POST.
    const POST: u16 = 1 << 5;
    let methods: Vec<u16> =
        brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
            .into_iter()
            .flat_map(|entry| (entry.0.routes)())
            .filter(|route| route.path == "/api/attachments/upload")
            .map(|route| route.methods)
            .collect();
    assert_eq!(methods, [POST], "the upload endpoint is registered once");
}

/// A failing object write must not fall through to the MySQL `binary_data`
/// column: the source `save` raises, the session never commits, and the
/// endpoint renders 500 `Failed to upload attachment`.
#[tokio::test]
async fn a_failed_storage_write_aborts_before_any_column_write() {
    let mut transaction = StatementLog::default();
    let result = store_and_parse(
        &mut transaction,
        &FailingStorageBackend,
        1364828,
        157,
        "平台架构周报2026-04-17.md",
        ".md",
        b"## title\n\nbody",
        "attachments/0123456789ab_20261009000000_157_1364828".to_string(),
        Map::new(),
    )
    .await;

    assert!(matches!(
        result,
        Err(brz_mysql::MysqlError::InvalidQuery { .. })
    ));
    assert!(transaction.statements.is_empty());
}

/// Capture ordinary statements and primary transactions used by the upload tail.
#[derive(Default, Clone)]
struct StatementCapture {
    statements: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

impl brz_mysql::Mysql for StatementCapture {
    type Transaction = StatementLog;

    fn with_route<R: brz_mysql::MysqlRouting + 'static>(&self, _: R) -> brz_mysql::MysqlService {
        panic!("plain queries must reuse the configured service")
    }

    fn route<K: brz_mysql::MysqlRouteKey>(&self, _key: K) -> Self {
        self.clone()
    }

    async fn with_transaction<T, F>(&self, operation: F) -> MysqlResult<T>
    where
        T: Send,
        F: for<'a> AsyncFnOnce(&'a mut Self::Transaction) -> MysqlResult<T> + Send,
    {
        let mut transaction = StatementLog::default();
        let result = operation(&mut transaction).await;
        self.statements
            .lock()
            .unwrap()
            .extend(transaction.statements);
        result
    }

    async fn fetch_optional<S, A, T>(&self, sql: S, _: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.record(sql.as_ref());
        Ok(None)
    }

    async fn fetch_all<S, A, T>(&self, sql: S, _: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.record(sql.as_ref());
        Ok(Vec::new())
    }

    async fn execute<S, A>(&self, sql: S, _: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        self.record(sql.as_ref());
        Ok(MysqlExecution {
            rows_affected: 0,
            last_insert_id: 0,
        })
    }

    async fn fetch_one<S, A, T>(&self, _: S, _: A) -> MysqlResult<T>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        panic!("unexpected fetch_one")
    }

    fn fetch<'a, S, A, T>(
        &'a self,
        _: S,
        _: A,
    ) -> impl futures_util::Stream<Item = MysqlResult<T>> + Send + 'a
    where
        S: AsRef<str> + Send + 'a,
        A: MysqlArgs + Send + 'a,
        T: FromMysqlRow + Send + 'a,
    {
        futures_util::stream::once(async { panic!("unexpected streaming query") })
    }
}

impl StatementCapture {
    fn record(&self, sql: &str) {
        let collapsed = sql.split_whitespace().collect::<Vec<_>>().join(" ");
        self.statements.lock().unwrap().push(collapsed);
    }

    fn statements(&self) -> Vec<String> {
        self.statements.lock().unwrap().clone()
    }
}

/// The parsed upload tail runs the service's own post-commit
/// `db.refresh(context)` — the unaliased re-select the recording captures
/// right after the upload commit (recorded 505) — while a parse failure
/// never reaches the refresh.
#[tokio::test]
async fn the_parsed_upload_tail_refreshes_the_context_after_commit() {
    let mysql = StatementCapture::default();
    let context_id = finish_uploaded_context(
        &mysql,
        (
            1392107,
            UploadOutcome::Parsed {
                context_id: 1392107,
                truncation_info: None,
            },
        ),
    )
    .await
    .expect("the parsed tail succeeds");
    assert_eq!(context_id, 1392107);
    let statements = mysql.statements();
    assert_eq!(statements.len(), 1, "exactly one refresh read");
    assert!(
        statements[0].starts_with(
            "SELECT subtask_contexts.id, subtask_contexts.subtask_id, \
             subtask_contexts.user_id, subtask_contexts.context_type"
        ),
        "the refresh uses the unaliased db.refresh projection: {}",
        statements[0]
    );
    assert!(
        statements[0].ends_with("FROM subtask_contexts WHERE subtask_contexts.id = ?"),
        "the refresh re-selects by primary key: {}",
        statements[0]
    );

    // A committed parse failure re-raises before any refresh.
    let failed = StatementCapture::default();
    assert!(
        finish_uploaded_context(
            &failed,
            (
                1,
                UploadOutcome::ParseFailed {
                    body: serde_json::json!({"detail": "parse failed"})
                }
            )
        )
        .await
        .is_err()
    );
    assert!(failed.statements().is_empty());
}
