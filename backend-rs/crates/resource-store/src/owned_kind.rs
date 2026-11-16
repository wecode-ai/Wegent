//! Non-null owned Kind row projection for workspace and onboarding lookups.
use brz_mysql::FromMysqlRow;

/// The full `kinds` projection used by `_list_owned_kinds`.
pub const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at";

/// One `kinds` row for an owned Team or Device.
#[derive(Debug, FromMysqlRow)]
pub struct OwnedKindRow {
    #[mysql(rename = "kinds_id")]
    pub id: i64,
    #[mysql(rename = "kinds_user_id")]
    pub user_id: i64,
    #[mysql(rename = "kinds_kind")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub kind: String,
    #[mysql(rename = "kinds_name")]
    pub name: String,
    #[mysql(rename = "kinds_namespace")]
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub namespace: String,
    #[mysql(rename = "kinds_json")]
    pub json: brz_mysql::Json<serde_json::Value>,
    #[mysql(rename = "kinds_is_active")]
    pub is_active: i8,
    #[mysql(rename = "kinds_created_at")]
    #[allow(dead_code)]
    pub created_at: chrono::NaiveDateTime,
    #[mysql(rename = "kinds_updated_at")]
    pub updated_at: chrono::NaiveDateTime,
}
