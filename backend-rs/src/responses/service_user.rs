// SPDX-FileCopyrightText: 2026 Weibo, Inc.

//! Service-key user provisioning for Responses create requests.

use brz_mysql::MysqlError;

use super::auth::{AuthenticatedKey, UserLookup};
use crate::request_sql::RequestSql;
use crate::state::AppState;
use crate::user_reader::{UserByIdReader, UserRecord};

fn onboarding_state(state: &AppState) -> wegent_onboarding::state::AppState {
    wegent_onboarding::state::AppState {
        mysql: state.mysql.clone(),
        redis: state.redis.clone(),
        entity_resolvers: state.entity_resolvers.clone(),
        task_store: state.task_store.clone(),
    }
}

/// The source's fixed placeholder email for service-key users.
fn placeholder_email(username: &str) -> String {
    format!("{username}@api.auto")
}

/// `str(uuid.uuid4())`-shaped random input for the unusable local password.
fn random_uuid_v4() -> String {
    use std::fmt::Write as _;

    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes).expect("OS randomness is available");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let mut out = String::with_capacity(36);
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) {
            out.push('-');
        }
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Preserve the source's `api:{service_key_name}` marker within the column
/// width. Long names share a truncated prefix, but the key that created the
/// row is already visible through its `api_keys` identity and access logs.
fn auth_source(service_key_name: &str) -> String {
    format!("api:{service_key_name}").chars().take(20).collect()
}

/// Provision a service-key target user while resolving a create request.
/// The deferred lookup runs on the request transaction, while the insert uses
/// a short nested service transaction so the committed row is visible to the
/// default-resource initialization.
///
/// The lookup uses the deployment reader so a cache deployment follows its own
/// read path. A genuine new row is inserted in its own transaction so onboarding
/// sees the committed user. A duplicate-key race re-reads the row and only the
/// request that inserted it applies default resources.
pub(crate) async fn provision(
    state: &AppState,
    user_reader: &dyn UserByIdReader,
    sql: &mut dyn RequestSql,
    key: &AuthenticatedKey,
) -> Result<UserRecord, MysqlError> {
    let UserLookup::ByName(target_username) = &key.lookup else {
        unreachable!("only service keys name a target user")
    };

    if let Some(user) = user_reader
        .get_by_name_on(sql, target_username)
        .await
        .map_err(reader_failure)?
    {
        return Ok(user);
    }

    let service_key_name = key.api_key_name.as_deref().unwrap_or_default();
    let created = state
        .mysql
        .with_transaction(async |transaction| {
            insert_service_user(
                transaction,
                target_username,
                service_key_name,
                &placeholder_email(target_username),
            )
            .await
        })
        .await;

    match created {
        Ok(user) => {
            if let Err(error) = user_reader
                .invalidate_user_cache(user.id, &user.user_name)
                .await
            {
                tracing::warn!(%error, "[responses] service-user cache invalidation failed");
            }
            let onboarding = onboarding_state(state);
            crate::new_user_resources::apply(&onboarding, state.seed_tasks.as_ref(), user.id).await;
            Ok(user)
        }
        Err(error) if error.is_duplicate_key() => user_reader
            .get_by_name_on(sql, target_username)
            .await
            .map_err(reader_failure)?
            .ok_or(error),
        Err(error) => Err(error),
    }
}

/// Insert and refresh one service-key user. Bcrypt is CPU-heavy, so hashing is
/// moved off the async worker.
async fn insert_service_user<T: brz_mysql::MysqlTransaction>(
    transaction: &mut T,
    username: &str,
    service_key_name: &str,
    email: &str,
) -> Result<UserRecord, MysqlError> {
    let random_secret = random_uuid_v4();
    let password_hash =
        tokio::task::spawn_blocking(move || bcrypt::hash(random_secret, bcrypt::DEFAULT_COST))
            .await
            .map_err(|error| MysqlError::InvalidQuery {
                reason: error.to_string(),
            })?
            .map_err(|error| MysqlError::InvalidQuery {
                reason: error.to_string(),
            })?;

    transaction
        .execute(
            "INSERT INTO users (user_name, password_hash, email, git_info, is_active, `role`, \
             auth_source, preferences, created_at, updated_at) VALUES (?, ?, ?, '[]', 1, 'user', \
             ?, '{}', NOW(), NOW())",
            (
                username,
                password_hash.as_str(),
                email,
                auth_source(service_key_name).as_str(),
            ),
        )
        .await?;
    let user = transaction
        .fetch_optional(crate::user_reader::USER_BY_NAME_QUERY, (username,))
        .await?;
    let user = user.as_ref().map(UserRecord::from_mysql_row).transpose()?;
    user.ok_or_else(|| MysqlError::InvalidQuery {
        reason: "service user row disappeared after insert".to_string(),
    })
}

/// Convert the deployment reader's opaque error to the provisioning boundary's
/// database error type.
fn reader_failure(error: anyhow::Error) -> MysqlError {
    MysqlError::InvalidQuery {
        reason: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::mysql_rows::{MysqlRows, Row, Value};
    use std::sync::Arc;
    use std::time::Duration;

    #[derive(Default)]
    struct RecordedRequestSql {
        calls: std::sync::Mutex<Vec<(crate::request_sql::RouteKey, String, usize)>>,
    }

    #[async_trait::async_trait]
    impl RequestSql for RecordedRequestSql {
        async fn execute_statement(
            &mut self,
            route: crate::request_sql::RouteKey,
            sql: &str,
            arguments: crate::request_sql::StatementArgs,
        ) -> brz_mysql::MysqlResult<brz_mysql::MysqlExecution> {
            self.calls
                .lock()
                .unwrap()
                .push((route, sql.to_string(), arguments.len()));
            Ok(brz_mysql::MysqlExecution {
                rows_affected: 1,
                last_insert_id: 0,
            })
        }

        async fn fetch_optional_row(
            &mut self,
            route: crate::request_sql::RouteKey,
            sql: &str,
            arguments: crate::request_sql::StatementArgs,
        ) -> brz_mysql::MysqlResult<Option<brz_mysql::MysqlRow>> {
            self.calls
                .lock()
                .unwrap()
                .push((route, sql.to_string(), arguments.len()));
            Ok(None)
        }

        async fn fetch_all_rows(
            &mut self,
            route: crate::request_sql::RouteKey,
            sql: &str,
            arguments: crate::request_sql::StatementArgs,
        ) -> brz_mysql::MysqlResult<Vec<brz_mysql::MysqlRow>> {
            self.calls
                .lock()
                .unwrap()
                .push((route, sql.to_string(), arguments.len()));
            Ok(Vec::new())
        }
    }

    fn key() -> AuthenticatedKey {
        AuthenticatedKey {
            api_key_id: 6539,
            api_key_name: Some("responses-e2e".to_string()),
            key_hash: String::new(),
            lookup: UserLookup::ByName("service-target".to_string()),
        }
    }

    async fn scripted_state(existing: Option<UserRecord>) -> (Arc<AppState>, RecordingUserReader) {
        let fixture = MysqlRows::start_results(|_| (user_schema(), Vec::<Row>::new())).await;
        let state = crate::app_test_support::app(fixture.mysql.clone());
        let reader = RecordingUserReader {
            existing,
            invalidated: Default::default(),
        };
        (state, reader)
    }

    #[tokio::test]
    async fn an_existing_service_user_is_reused_without_inserting() {
        let (state, reader) = scripted_state(Some(user_record(true))).await;
        let mut sql = RecordedRequestSql::default();
        let user = provision(state.as_ref(), &reader, &mut sql, &key())
            .await
            .expect("existing user");
        assert_eq!(user.id, 6527);
        assert!(!*reader.invalidated.lock().unwrap());
    }

    fn user_record(is_active: bool) -> UserRecord {
        UserRecord {
            id: 6527,
            user_name: "service-target".to_string(),
            password_hash: "unused".to_string(),
            email: Some("service-target@api.auto".to_string()),
            git_info: serde_json::Value::Array(Vec::new()),
            is_active,
            role: "user".to_string(),
            auth_source: "api:responses-e2e".to_string(),
            preferences: "{}".to_string(),
            created_at: chrono::NaiveDateTime::default(),
            updated_at: chrono::NaiveDateTime::default(),
        }
    }

    /// Records whether provisioning wrote the user and whether the reader
    /// invalidated its cached absence.
    #[derive(Default)]
    struct RecordingUserReader {
        existing: Option<UserRecord>,
        invalidated: std::sync::Mutex<bool>,
    }

    #[async_trait::async_trait]
    impl crate::user_reader::UserByIdReader for RecordingUserReader {
        async fn get_by_id(&self, _: i64) -> anyhow::Result<Option<UserRecord>> {
            Ok(self.existing.clone())
        }

        async fn get_by_name(&self, _: &str) -> anyhow::Result<Option<UserRecord>> {
            Ok(self.existing.clone())
        }

        async fn get_entity_by_id(&self, _: i64) -> anyhow::Result<Option<UserRecord>> {
            Ok(self.existing.clone())
        }

        async fn get_by_id_on(
            &self,
            _: &mut dyn RequestSql,
            _: i64,
        ) -> anyhow::Result<Option<UserRecord>> {
            Ok(self.existing.clone())
        }

        async fn get_by_name_on(
            &self,
            _: &mut dyn RequestSql,
            _: &str,
        ) -> anyhow::Result<Option<UserRecord>> {
            Ok(self.existing.clone())
        }

        async fn invalidate_user_cache(&self, _: i64, _: &str) -> anyhow::Result<()> {
            *self.invalidated.lock().unwrap() = true;
            Ok(())
        }
    }

    #[test]
    fn auth_source_keeps_the_api_marker() {
        assert_eq!(auth_source("short"), "api:short");
        assert_eq!(
            auth_source("a-very-long-service-key-name"),
            "api:a-very-long-serv"
        );
        assert_eq!(auth_source("a-very-long-service-key-name").len(), 20);
    }

    /// Provisioning prepares the source's insert and refresh read in one
    /// transaction. The fake server errors on the insert, so the first two
    /// prepared statements are sufficient to lock the wire order.
    #[tokio::test]
    async fn a_new_service_user_is_inserted_before_the_refresh_read() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let fixture = MysqlRows::start_results(|_| (user_schema(), Vec::<Row>::new())).await;
            let state = crate::app_test_support::app(fixture.mysql.clone());
            let reader = crate::user_reader::PublicUserReader::new(fixture.mysql.clone());

            let mut sql = RecordedRequestSql::default();
            let _ = provision(&state, &reader, &mut sql, &key()).await;

            let queries = fixture.queries();
            let request_reads = sql.calls.lock().unwrap().clone();
            drop(fixture);

            assert_eq!(
                request_reads,
                vec![(
                    crate::request_sql::RouteKey::None,
                    crate::user_reader::USER_BY_NAME_QUERY.to_string(),
                    1
                )],
                "the deferred user read stays on the request handle"
            );

            let insert = queries.iter().find(|sql| sql.contains("INSERT INTO users"));
            assert!(insert.is_some(), "{queries:?}");
            let insert = insert.unwrap();
            assert!(insert.contains("VALUES (?, ?, ?, '[]', 1, 'user', ?, '{}', NOW(), NOW())"));
            assert!(
                queries
                    .iter()
                    .any(|sql| sql == crate::user_reader::USER_BY_NAME_QUERY)
            );
        })
        .await
        .expect("service-user provisioning should finish within the timeout");
    }

    fn text(value: &str) -> Value {
        Value::Text(value.to_owned())
    }

    fn user_schema() -> Row {
        vec![
            ("users_id", Value::I64(6527)),
            ("users_user_name", text("service-target")),
            ("users_password_hash", text("unused")),
            ("users_email", text("service-target@api.auto")),
            ("users_git_info", text("[]")),
            ("users_is_active", Value::I8(1)),
            ("users_role", text("user")),
            ("users_auth_source", text("api:responses-e2e")),
            ("users_preferences", text("{}")),
            ("users_created_at", Value::DateTime),
            ("users_updated_at", Value::DateTime),
        ]
    }
}
