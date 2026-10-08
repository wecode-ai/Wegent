// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Typed application handlers for the external Sites project API
//! (`app.services.site_application_types`).
//!
//! Each supported application type converts one upstream project document into
//! its typed [`SiteListItem`]. The conversions mirror
//! `SiteApplicationHandler.parse` and `MiniProgramApplicationHandler.parse`,
//! including the `InvalidApplicationProjectError` branch the caller maps to a
//! `502 SitesUpstreamUnavailableError`.
use serde_json::Value;

use super::response::{MiniProgramResponse, SiteListItem, SiteResponse};

/// The current-contract application types that have a registered handler.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AppType {
    Web,
    MiniProgram,
}

impl AppType {
    /// `SiteAppType` current-contract name (`web` / `miniapp`).
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Web => "web",
            Self::MiniProgram => "miniapp",
        }
    }

    /// `ApplicationTypeHandler.matches`: whether one upstream document belongs
    /// to this application type.
    pub(super) fn matches(self, payload: &Value) -> bool {
        let Some(object) = payload.as_object() else {
            return false;
        };
        normalized_application_type(or_truthy(
            object.get("app_type"),
            object.get("project_type"),
        )) == self.as_str()
    }

    /// `ApplicationTypeHandler.parse`: validate one upstream project and return
    /// its typed application. `Err(())` is `InvalidApplicationProjectError`.
    pub(super) fn parse(self, payload: &Value) -> Result<SiteListItem, ()> {
        match self {
            Self::Web => parse_site(payload).map(SiteListItem::Site),
            Self::MiniProgram => parse_mini_program(payload).map(SiteListItem::MiniProgram),
        }
    }
}

/// `SiteApplicationHandler.parse`.
fn parse_site(payload: &Value) -> Result<SiteResponse, ()> {
    let object = payload.as_object().ok_or(())?;
    let internal_url = any_http_url(
        object
            .get("url")
            .and_then(Value::as_str)
            .filter(|url| !url.is_empty())
            .ok_or(())?,
    )
    .ok_or(())?;
    let network = normalize_network(object.get("network"));
    let project_id = object.get("id").and_then(Value::as_str).ok_or(())?;
    let owner_username = object
        .get("owner_username")
        .and_then(Value::as_str)
        .ok_or(())?;
    let access_role = access_role(object.get("access_role")).ok_or(())?;
    let name = object.get("title").and_then(Value::as_str).ok_or(())?;
    let slug = match object.get("slug") {
        Some(value) if is_truthy(value) => value.as_str().ok_or(())?,
        _ => project_id,
    };
    let created_at = render_datetime(object.get("created_at").ok_or(())?).ok_or(())?;
    let external_url = (network == "outer").then(|| internal_url.clone());
    let publish_status = if object.get("version_status").and_then(Value::as_str) == Some("scanning")
    {
        "scanning"
    } else if network == "outer" {
        "published"
    } else {
        "unpublished"
    };
    Ok(SiteResponse {
        app_type: "web",
        siteid: project_id.to_owned(),
        project_id: project_id.to_owned(),
        taskid: project_id.to_owned(),
        username: owner_username.to_owned(),
        owner_username: owner_username.to_owned(),
        access_role,
        name: name.to_owned(),
        slug: slug.to_owned(),
        custom_domain_prefix: optional_str(object.get("custom_domain_prefix"))?,
        network,
        internal_url,
        external_url,
        publish_status,
        last_publish_error: None,
        thumbnail_url: thumbnail_url(object.get("snapshot"))?,
        created_at: created_at.clone(),
        updated_at: created_at,
        published_at: None,
    })
}

/// `MiniProgramApplicationHandler.parse`.
fn parse_mini_program(payload: &Value) -> Result<MiniProgramResponse, ()> {
    let object = payload.as_object().ok_or(())?;
    let project_id = object.get("id").and_then(Value::as_str).ok_or(())?;
    let owner_username = object
        .get("owner_username")
        .and_then(Value::as_str)
        .ok_or(())?;
    let access_role = access_role(object.get("access_role")).ok_or(())?;
    let name = object.get("title").and_then(Value::as_str).ok_or(())?;
    let network = normalize_network(object.get("network"));
    let created_at = render_datetime(object.get("created_at").ok_or(())?).ok_or(())?;
    let updated_at = match object.get("updated_at") {
        None => created_at.clone(),
        Some(value) => render_datetime(value).ok_or(())?,
    };
    let status = match object.get("status") {
        Some(value) if is_truthy(value) => value.as_str().ok_or(())?.to_owned(),
        _ => {
            if network == "outer" {
                "published".to_owned()
            } else {
                "experience".to_owned()
            }
        }
    };
    let experience_url = match or_truthy(object.get("experience_url"), object.get("url")) {
        None => None,
        Some(value) => Some(any_http_url(value.as_str().ok_or(())?).ok_or(())?),
    };
    Ok(MiniProgramResponse {
        app_type: "miniapp",
        siteid: project_id.to_owned(),
        project_id: project_id.to_owned(),
        taskid: project_id.to_owned(),
        username: owner_username.to_owned(),
        owner_username: owner_username.to_owned(),
        access_role,
        name: name.to_owned(),
        slug: project_id.to_owned(),
        app_id: optional_str(object.get("app_id"))?,
        status,
        version: optional_str(object.get("version"))?,
        experience_url,
        thumbnail_url: thumbnail_url(object.get("snapshot"))?,
        created_at,
        updated_at,
    })
}

/// `normalize_application_type`: map historical names to the current contract,
/// keeping unknown names unchanged. A missing or non-string input is `web`.
fn normalized_application_type(value: Option<&Value>) -> &str {
    let current = match value.and_then(Value::as_str).map(str::trim) {
        Some(name) if !name.is_empty() => name,
        _ => "web",
    };
    match current {
        "site" => "web",
        "mini_program" => "miniapp",
        other => other,
    }
}

/// `normalize_site_network`: only `inner` / `outer` are accepted.
fn normalize_network(value: Option<&Value>) -> &'static str {
    match value.and_then(Value::as_str) {
        Some("outer") => "outer",
        _ => "inner",
    }
}

/// `SiteAccessRole`: `owner` or `collaborator`.
fn access_role(value: Option<&Value>) -> Option<String> {
    match value.and_then(Value::as_str) {
        Some(role @ ("owner" | "collaborator")) => Some(role.to_owned()),
        _ => None,
    }
}

/// `custom_domain_prefix` / `app_id` / `version`: `str | None`, rejecting any
/// other present value the way pydantic does.
fn optional_str(value: Option<&Value>) -> Result<Option<String>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(()),
    }
}

/// `thumbnail_url`: `snapshot` only when it is a non-empty string, validated as
/// an `AnyHttpUrl`.
fn thumbnail_url(snapshot: Option<&Value>) -> Result<Option<String>, ()> {
    match snapshot {
        Some(Value::String(url)) if !url.is_empty() => Ok(Some(any_http_url(url).ok_or(())?)),
        _ => Ok(None),
    }
}

/// pydantic `AnyHttpUrl` acceptance and serialization: an `http`/`https` URL
/// with a host, rendered by the `url` crate (which adds an empty path as `/`).
fn any_http_url(raw: &str) -> Option<String> {
    let parsed = url::Url::parse(raw).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return None;
    }
    Some(parsed.to_string())
}

/// Python `a or b` for two optional JSON references.
fn or_truthy<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    match a {
        Some(value) if is_truthy(value) => Some(value),
        _ => b,
    }
}

/// Python truthiness for a JSON value.
fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_none_or(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(object) => !object.is_empty(),
    }
}

/// pydantic `datetime` acceptance and serialization: an ISO-8601 string (an
/// optional offset is preserved, `Z` for UTC) or a numeric Unix timestamp in
/// seconds rendered as UTC.
pub(super) fn render_datetime(value: &Value) -> Option<String> {
    match value {
        Value::String(raw) => render_datetime_string(raw),
        Value::Number(number) => {
            let seconds = number.as_f64()?;
            let whole = seconds.trunc() as i64;
            let nanos = ((seconds.fract()) * 1e9).round() as u32;
            let timestamp = chrono::DateTime::from_timestamp(whole, nanos)?;
            Some(format!("{}Z", render_subseconds(timestamp.naive_utc())))
        }
        _ => None,
    }
}

/// `datetime.fromisoformat`: an RFC 3339 string or a naive `T`/space separated
/// timestamp.
fn render_datetime_string(raw: &str) -> Option<String> {
    if let Ok(aware) = chrono::DateTime::parse_from_rfc3339(raw) {
        return Some(render_aware(aware));
    }
    let naive = chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S%.f"))
        .ok()?;
    Some(render_subseconds(naive))
}

/// An aware datetime rendered as RFC 3339: `Z` for a zero offset, otherwise the
/// signed `HH:MM` offset.
fn render_aware(value: chrono::DateTime<chrono::FixedOffset>) -> String {
    let base = render_subseconds(value.naive_local());
    let offset = value.offset().local_minus_utc();
    if offset == 0 {
        return format!("{base}Z");
    }
    let sign = if offset < 0 { '-' } else { '+' };
    let magnitude = offset.unsigned_abs();
    format!(
        "{base}{sign}{:02}:{:02}",
        magnitude / 3600,
        (magnitude % 3600) / 60
    )
}

/// Python `isoformat` body: microseconds only when non-zero.
fn render_subseconds(value: chrono::NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
    }
}
