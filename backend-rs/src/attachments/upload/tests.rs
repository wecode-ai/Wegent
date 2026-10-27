// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for the chat attachment upload pipeline
//! (`src/attachments/upload/mod.rs`).

use super::*;
use brz_mysql::{FromMysqlRow, MysqlArgs, MysqlExecution, MysqlResult, MysqlTransaction};

/// An object store whose write always fails, like the source `save`
/// raising when `put_object` fails.
struct FailingStorageBackend;

struct HostingBackend {
    fail: bool,
    invalid: bool,
}

#[async_trait::async_trait]
impl AttachmentUploadBackend for HostingBackend {
    fn external_storage_backend(&self, mime_type: &str, purpose: &str) -> Option<&str> {
        (matches!(mime_type, "video/mp4" | "audio/mpeg")
            && matches!(purpose, "default" | "video_reference"))
        .then_some("media_hosting")
    }

    async fn store_external_attachment(
        &self,
        request: ExternalAttachmentUploadRequest<'_>,
    ) -> Result<ExternalAttachmentStorageResult, ExternalAttachmentUploadError> {
        assert_eq!(request.content, b"original media");
        assert_eq!(request.user_id, 7);
        if self.fail {
            return Err(ExternalAttachmentUploadError::Unavailable);
        }
        if self.invalid {
            return Err(ExternalAttachmentUploadError::InvalidInput(
                "provider rejected the material".to_owned(),
            ));
        }
        Ok(ExternalAttachmentStorageResult {
            backend_type: "media_hosting".to_owned(),
            storage_key: String::new(),
            type_data: Map::from_iter([(
                "provider_reference".to_owned(),
                serde_json::json!({
                    "media_id": "media-123", "upload_id": "upload-456"
                }),
            )]),
        })
    }

    fn backend_type(&self) -> &str {
        "unused_object_store"
    }
    async fn ensure_ready(&self) -> Result<(), UploadBackendError> {
        panic!("hosted attachments must not probe the object store")
    }
    async fn store_object(&self, _: StoreObjectRequest<'_>) -> Result<bool, UploadBackendError> {
        panic!("hosted attachments must not write to the object store")
    }
    async fn upload_image_pid(&self, _: ImageUploadRequest<'_>) -> Option<ImagePid> {
        None
    }
    async fn delete_object(&self, _: &str) -> Result<bool, UploadBackendError> {
        Ok(true)
    }
}

#[tokio::test]
async fn hosted_materials_persist_ready_references_without_binary_storage_or_parsing() {
    for (filename, extension, mime_type) in [
        ("reference.mp4", ".mp4", "video/mp4"),
        ("reference.mp3", ".mp3", "audio/mpeg"),
    ] {
        for purpose in ["default", "video_reference"] {
            let backend = HostingBackend {
                fail: false,
                invalid: false,
            };
            assert_eq!(
                external_storage::prepare_backend(&backend, mime_type, purpose)
                    .await
                    .unwrap(),
                "media_hosting"
            );
            let mut transaction = StatementLog::default();
            let mut metadata = build_type_data(
                filename,
                extension,
                14,
                mime_type,
                "media_hosting",
                "temporary-key",
            );
            metadata.insert("lifecycle_owner".to_owned(), Value::from("upload-test"));
            let outcome = store_and_parse(
                &mut transaction,
                &backend,
                73,
                7,
                filename,
                extension,
                b"original media",
                "temporary-key".to_owned(),
                metadata,
                purpose,
                &mut None,
            )
            .await
            .unwrap();
            assert!(matches!(
                outcome,
                UploadOutcome::Parsed {
                    context_id: 73,
                    truncation_info: None
                }
            ));
            assert_eq!(transaction.statements.len(), 1);
            assert!(transaction.statements[0].contains("status='ready', binary_data=X''"));
            let persisted: Value =
                serde_json::from_str(transaction.first_parameters[0].as_ref().unwrap()).unwrap();
            assert_eq!(
                persisted["provider_reference"],
                serde_json::json!({"media_id":"media-123", "upload_id":"upload-456"})
            );
            assert_eq!(persisted["storage_backend"], "media_hosting");
            assert_eq!(persisted["storage_key"], "");
            assert_eq!(persisted["is_encrypted"], false);
            assert_eq!(persisted["encryption_version"], 0);
            assert_eq!(persisted["mime_type"], mime_type);
            assert_eq!(persisted["original_filename"], filename);
            assert_eq!(persisted["lifecycle_owner"], "upload-test");
        }
    }
}

#[tokio::test]
async fn hosting_failure_propagates_before_any_ready_or_binary_write() {
    let mut transaction = StatementLog::default();
    let result = store_and_parse(
        &mut transaction,
        &HostingBackend {
            fail: true,
            invalid: false,
        },
        73,
        7,
        "reference.mp4",
        ".mp4",
        b"original media",
        "key".to_owned(),
        Map::new(),
        "video_reference",
        &mut None,
    )
    .await;
    assert!(
        result.is_err(),
        "the caller must roll back its upload transaction"
    );
    assert!(transaction.statements.is_empty());
}

#[tokio::test]
async fn hosting_validation_is_rolled_back_and_keeps_the_upload_bad_request_contract() {
    let mut transaction = StatementLog::default();
    let mut validation_error = None;
    let error = store_and_parse(
        &mut transaction,
        &HostingBackend {
            fail: false,
            invalid: true,
        },
        73,
        7,
        "reference.mp4",
        ".mp4",
        b"original media",
        "key".to_owned(),
        Map::new(),
        "video_reference",
        &mut validation_error,
    )
    .await
    .err()
    .expect("validation must abort the transaction");
    assert!(transaction.statements.is_empty());
    assert_eq!(
        validation_error.as_deref(),
        Some("provider rejected the material")
    );
    assert_eq!(
        upload_dependency_error(error, validation_error).status(),
        StatusCode::BAD_REQUEST
    );
    let dependency = brz_mysql::MysqlError::InvalidQuery {
        reason: "unavailable".to_owned(),
    };
    assert_eq!(
        upload_dependency_error(dependency, None).status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
}

#[tokio::test]
async fn public_default_keeps_media_in_the_configured_binary_backend() {
    assert_eq!(
        external_storage::prepare_backend(&MySqlStorageBackend, "video/mp4", "video_reference")
            .await
            .unwrap(),
        "mysql"
    );
    let mut transaction = StatementLog::default();
    let result = store_and_parse(
        &mut transaction,
        &FailingStorageBackend,
        73,
        7,
        "reference.mp4",
        ".mp4",
        b"original media",
        "key".to_owned(),
        Map::new(),
        "video_reference",
        &mut None,
    )
    .await;
    assert!(result.is_err());
    assert!(transaction.statements.is_empty());
}

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
    first_parameters: Vec<Option<String>>,
}

impl MysqlTransaction for StatementLog {
    async fn execute<S, A>(&mut self, sql: S, args: A) -> MysqlResult<MysqlExecution>
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
        self.first_parameters.push(match args.first_route_value() {
            Some(brz_mysql::MysqlRouteValue::String(value)) => Some(value.to_owned()),
            _ => None,
        });
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
        "default",
        &mut None,
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
