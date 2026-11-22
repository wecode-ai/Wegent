// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Row and response models for the Smart app marketplace listing.
//!
//! The row projection mirrors `db.query(SmartApp).filter(status == "published")`
//! (`app/models/smart_app_marketplace.py`), and both response types mirror
//! `SmartAppMarketplaceListResponse` / `SmartAppMarketplaceItem`
//! (`app/schemas/smart_app.py`), which FastAPI renders as `application/json`.
use brz_json::OpaqueJson;
use brz_mysql::{FromMysqlRow, Json};
use chrono::NaiveDateTime;
use serde_json::{Map, Value};

/// One published `smart_apps` row.
///
/// `db.query(SmartApp)` labels each column `<table>_<column>`, so the
/// projection keeps the source aliases and column order.
#[derive(Debug, FromMysqlRow)]
pub struct PublishedSmartAppRow {
    #[mysql(rename = "smart_apps_id")]
    pub id: i64,
    #[mysql(rename = "smart_apps_owner_user_id")]
    pub owner_user_id: i64,
    #[mysql(rename = "smart_apps_name")]
    pub name: String,
    #[mysql(rename = "smart_apps_display_name")]
    pub display_name: String,
    #[mysql(rename = "smart_apps_summary")]
    pub summary: String,
    #[mysql(rename = "smart_apps_description_md")]
    pub description_md: String,
    #[mysql(rename = "smart_apps_source_type")]
    pub source_type: String,
    #[mysql(rename = "smart_apps_visibility")]
    pub visibility: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "smart_apps_status")]
    pub status: String,
    #[mysql(rename = "smart_apps_tags_json")]
    pub tags_json: Json<OpaqueJson>,
    #[mysql(rename = "smart_apps_icon_storage_key")]
    pub icon_storage_key: String,
    #[mysql(rename = "smart_apps_screenshots_json")]
    pub screenshots_json: Json<OpaqueJson>,
    #[mysql(rename = "smart_apps_extensions_json")]
    pub extensions_json: Json<OpaqueJson>,
    #[mysql(rename = "smart_apps_latest_release_id")]
    pub latest_release_id: i64,
    #[mysql(rename = "smart_apps_featured_rank")]
    pub featured_rank: i64,
    #[mysql(rename = "smart_apps_is_listed")]
    pub is_listed: bool,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "smart_apps_created_at")]
    pub created_at: NaiveDateTime,
    #[mysql(rename = "smart_apps_updated_at")]
    pub updated_at: NaiveDateTime,
    #[mysql(rename = "smart_apps_published_at")]
    pub published_at: NaiveDateTime,
}

/// `SmartAppMarketplaceListResponse` (`app/schemas/smart_app.py`).
#[derive(Debug, serde::Serialize)]
pub struct SmartAppMarketplaceListResponse {
    pub items: Vec<SmartAppMarketplaceItem>,
}

/// `SmartAppMarketplaceItem` (`app/schemas/smart_app.py`).
///
/// Field order and camelCase names match the pydantic model so the serialized
/// body is byte-compatible. Datetimes are preformatted to the pydantic v2
/// datetime JSON form, and `requirements`/`extensions`/`releaseExtensions`
/// keep the stored JSON object order.
#[derive(Debug, serde::Serialize)]
pub struct SmartAppMarketplaceItem {
    pub id: i64,
    pub name: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub summary: String,
    #[serde(rename = "descriptionMd")]
    pub description_md: String,
    #[serde(rename = "sourceType")]
    pub source_type: String,
    #[serde(rename = "ownerUserId")]
    pub owner_user_id: i64,
    #[serde(rename = "ownerDisplayName")]
    pub owner_display_name: String,
    #[serde(rename = "accessRole")]
    pub access_role: String,
    pub visibility: String,
    pub tags: Vec<String>,
    #[serde(rename = "iconUrl")]
    pub icon_url: String,
    #[serde(rename = "screenshotUrls")]
    pub screenshot_urls: Vec<String>,
    pub featured: bool,
    #[serde(rename = "latestReleaseId")]
    pub latest_release_id: i64,
    pub version: String,
    #[serde(rename = "releaseNotes")]
    pub release_notes: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: i64,
    pub requirements: Value,
    pub extensions: Value,
    #[serde(rename = "releaseExtensions")]
    pub release_extensions: Value,
    #[serde(rename = "scanStatus")]
    pub scan_status: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(rename = "publishedAt")]
    pub published_at: String,
}

/// An empty JSON object as Python's `{}` default renders.
pub fn empty_object() -> Value {
    Value::Object(Map::new())
}

/// Python truthiness of a decoded JSON value (`x or {}` / `if x`).
pub fn json_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(values) => !values.is_empty(),
        Value::Object(values) => !values.is_empty(),
    }
}

/// `dict(value or {})` for a stored JSON column that the schema declares as an
/// object; `null` and non-objects render the empty object.
pub fn object_or_empty(json: &Json<OpaqueJson>) -> Value {
    match json.0.to_value() {
        Value::Object(values) => Value::Object(values),
        _ => empty_object(),
    }
}

/// `list(value or [])` for a stored JSON array of strings; `null` and
/// non-arrays render no entries.
pub fn string_list(json: &Json<OpaqueJson>) -> Vec<String> {
    match json.0.to_value() {
        Value::Array(values) => values
            .into_iter()
            .filter_map(|value| value.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

/// pydantic v2 datetime serialization for a naive DB `datetime`
/// (`YYYY-MM-DDTHH:MM:SS`, microseconds appended only when non-zero).
pub fn pydantic_datetime(value: NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn datetime(
        year: i32,
        month: u32,
        day: u32,
        hour: u32,
        minute: u32,
        second: u32,
        micros: u32,
    ) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(year, month, day)
            .expect("valid date")
            .and_hms_micro_opt(hour, minute, second, micros)
            .expect("valid time")
    }

    #[test]
    fn pydantic_datetime_matches_the_recorded_naive_form() {
        assert_eq!(
            pydantic_datetime(datetime(2026, 9, 21, 9, 49, 11, 266_722)),
            "2026-09-21T09:49:11.266722"
        );
        assert_eq!(
            pydantic_datetime(datetime(2026, 9, 10, 10, 17, 6, 537_107)),
            "2026-09-10T10:17:06.537107"
        );
        assert_eq!(
            pydantic_datetime(datetime(2026, 9, 10, 10, 17, 6, 0)),
            "2026-09-10T10:17:06"
        );
    }

    #[test]
    fn truthiness_matches_python() {
        assert!(!json_truthy(&Value::Null));
        assert!(!json_truthy(&serde_json::json!({})));
        assert!(!json_truthy(&serde_json::json!([])));
        assert!(!json_truthy(&serde_json::json!("")));
        assert!(!json_truthy(&serde_json::json!(0)));
        assert!(json_truthy(&serde_json::json!({"dsh": ">=22"})));
        assert!(json_truthy(&serde_json::json!([".xlsx"])));
    }

    #[test]
    fn item_serializes_in_pydantic_field_order() {
        let item = SmartAppMarketplaceItem {
            id: 13,
            name: "dsh-xlsx2dashboard".to_owned(),
            display_name: "DSH".to_owned(),
            summary: "summary".to_owned(),
            description_md: "description".to_owned(),
            source_type: "user".to_owned(),
            owner_user_id: 8,
            owner_display_name: "jiangyang7".to_owned(),
            access_role: "public".to_owned(),
            visibility: "public".to_owned(),
            tags: vec!["daily_work".to_owned()],
            icon_url: "http://s3.example/icon.png".to_owned(),
            screenshot_urls: Vec::new(),
            featured: false,
            latest_release_id: 29,
            version: "0.4.0".to_owned(),
            release_notes: String::new(),
            size_bytes: 516_482,
            requirements: serde_json::json!({"dsh": "0.1.0-rc.8"}),
            extensions: empty_object(),
            release_extensions: empty_object(),
            scan_status: "passed".to_owned(),
            updated_at: "2026-09-21T09:49:11.266722".to_owned(),
            published_at: "2026-09-10T10:17:06.537107".to_owned(),
        };
        let response = SmartAppMarketplaceListResponse { items: vec![item] };
        let body = serde_json::to_string(&response).expect("serializes");
        assert_eq!(
            body,
            "{\"items\":[{\"id\":13,\"name\":\"dsh-xlsx2dashboard\",\"displayName\":\"DSH\",\
             \"summary\":\"summary\",\"descriptionMd\":\"description\",\
             \"sourceType\":\"user\",\"ownerUserId\":8,\"ownerDisplayName\":\"jiangyang7\",\
             \"accessRole\":\"public\",\"visibility\":\"public\",\"tags\":[\"daily_work\"],\
             \"iconUrl\":\"http://s3.example/icon.png\",\"screenshotUrls\":[],\
             \"featured\":false,\"latestReleaseId\":29,\"version\":\"0.4.0\",\
             \"releaseNotes\":\"\",\"sizeBytes\":516482,\
             \"requirements\":{\"dsh\":\"0.1.0-rc.8\"},\"extensions\":{},\
             \"releaseExtensions\":{},\"scanStatus\":\"passed\",\
             \"updatedAt\":\"2026-09-21T09:49:11.266722\",\
             \"publishedAt\":\"2026-09-10T10:17:06.537107\"}]}"
        );
    }
}
