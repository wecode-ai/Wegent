//! Initial administrator password handshake for the anonymous login page.

use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use serde_json::{Value, json};

use crate::http_compat::FastApiError;

#[derive(FromMysqlRow)]
struct BootstrapRow {
    config_value: Json<Value>,
}

pub(crate) async fn is_required(mysql: &impl Mysql) -> MysqlResult<bool> {
    let enabled = crate::config::env_or_dotenv("CHECK_SYSTEM_INITIALIZATION_STATUS");
    read_required(mysql, checks_enabled(enabled.as_deref())).await
}

fn checks_enabled(value: Option<&str>) -> bool {
    !value.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "off" | "no"
        )
    })
}

async fn read_required(mysql: &impl Mysql, enabled: bool) -> MysqlResult<bool> {
    if !enabled {
        return Ok(false);
    }
    // Read on each handshake: Python completes setup in a separate process.
    let row: Option<BootstrapRow> = mysql
        .fetch_optional(
            "SELECT config_value FROM system_configs \
             WHERE config_key = 'admin_password_initialized' LIMIT 1",
            (),
        )
        .await?;
    Ok(row.is_some_and(|row| row.config_value.0.get("completed") == Some(&Value::Bool(false))))
}

pub(crate) fn setup_required() -> FastApiError {
    FastApiError::json_body(
        brz_http_server::StatusCode::BAD_REQUEST,
        json!({
            "error_code": "ADMIN_PASSWORD_SETUP_REQUIRED",
            "detail": {
                "error_code": "ADMIN_PASSWORD_SETUP_REQUIRED",
                "admin_username": "admin"
            }
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::mysql_rows::{MysqlRows, Value as MysqlValue};

    #[tokio::test]
    async fn reads_live_marker_after_password_setup() {
        let completed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let source = completed.clone();
        let database = MysqlRows::start(move |query| {
            assert!(query.contains("config_key = 'admin_password_initialized'"));
            vec![(
                "config_value",
                MysqlValue::Text(
                    json!({
                        "completed": source.load(std::sync::atomic::Ordering::SeqCst)
                    })
                    .to_string(),
                ),
            )]
        })
        .await;
        assert!(read_required(&database.mysql, true).await.unwrap());
        completed.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(!read_required(&database.mysql, true).await.unwrap());
    }

    #[tokio::test]
    async fn disabled_checks_do_not_access_database() {
        let database = crate::sql_test_support::KindQueryCapture::failing_reads();
        assert!(!read_required(&database, false).await.unwrap());
        assert!(database.queries().is_empty());
    }

    #[tokio::test]
    async fn absent_marker_keeps_normal_login() {
        let database = crate::sql_test_support::KindQueryCapture::default();
        assert!(!read_required(&database, true).await.unwrap());
    }

    #[test]
    fn handshake_matches_login_form_contract() {
        let error = setup_required();
        assert_eq!(error.status(), brz_http_server::StatusCode::BAD_REQUEST);
        assert!(!error.carries_challenge());
        let body: Value = serde_json::from_str(&error.validation_detail()).unwrap();
        assert_eq!(body["error_code"], "ADMIN_PASSWORD_SETUP_REQUIRED");
        assert_eq!(body["admin_username"], "admin");
        assert!(checks_enabled(None));
        for value in ["false", "False", "0", "off", "no"] {
            assert!(!checks_enabled(Some(value)));
        }
    }

    #[tokio::test]
    async fn only_explicit_false_requires_setup() {
        for document in [
            json!({}),
            json!({"completed": null}),
            json!({"completed": 0}),
            json!({"completed": "false"}),
            json!({"completed": true}),
        ] {
            let database = MysqlRows::start(move |_| {
                vec![("config_value", MysqlValue::Text(document.to_string()))]
            })
            .await;
            assert!(!read_required(&database.mysql, true).await.unwrap());
        }
    }

    #[tokio::test]
    async fn database_failure_is_not_treated_as_initialized() {
        let database = crate::sql_test_support::KindQueryCapture::failing_reads();
        assert!(read_required(&database, true).await.is_err());
    }
}
