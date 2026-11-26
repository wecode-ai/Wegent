//! Host-owned permissions and effective boundaries for the primary DingTalk delegation.
use super::{now, source_provider, stand_in_connection, TaskRuntimeError, DINGTALK_PROVIDER};
use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Utc};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const TEMPLATES: [&str; 3] = ["document", "schedule", "process"];

pub fn is_primary_dingtalk(identity: &Value, source: &Value) -> bool {
    identity["id"] == "@primary" && source_provider(source) == DINGTALK_PROVIDER
}

pub fn requires_dingtalk_delegation(identity: &Value, source: &Value) -> bool {
    // Keep previously selected sources that required native confirmation.
    is_primary_dingtalk(identity, source)
        && (source["delegated"] == true
            || identity["delegation"]["version"].as_u64().unwrap_or(0) > 0
            || source["policy"]["askBeforeAct"] != true
            || !is_selected_conversation(source))
}

pub fn active_delegated_source<'a>(identity: &'a Value, source: &Value) -> Option<&'a Value> {
    let delegation = &identity["delegation"];
    if !is_primary_dingtalk(identity, source)
        || identity["enabled"] != true
        || delegation["authorized"] != true
        || delegation["paused"] != false
        || !delegation["version"]
            .as_u64()
            .is_some_and(|version| version > 0)
        || !is_exact_source(source)
        || source["delegated"] != true
    {
        return None;
    }
    let current = stand_in_connection(identity, source)?;
    (is_exact_source(current)
        && current["delegated"] == true
        && current["paused"] == false
        && current["profile"] == delegation["profile"]
        && current["accountId"] == delegation["accountId"]
        && source["accountId"] == current["accountId"])
        .then_some(current)
}

fn timestamp(value: &Value) -> Option<DateTime<Utc>> {
    let text = value.as_str()?;
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|time| time.with_timezone(&Utc))
        .or_else(|| {
            NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S")
                .ok()
                .and_then(|time| Local.from_local_datetime(&time).single())
                .map(|time| time.with_timezone(&Utc))
        })
}

fn after(value: &Value, cutoff: &Value) -> bool {
    timestamp(value)
        .zip(timestamp(cutoff))
        .is_some_and(|(event, start)| event > start)
}

pub fn permits_delegated_message(identity: &Value, source: &Value, at: &Value) -> bool {
    active_delegated_source(identity, source)
        .is_some_and(|current| after(at, &current["enabledAfter"]))
}

pub fn permits_delegated_reply(
    identity: &Value,
    source: &Value,
    template: &str,
    at: &Value,
) -> bool {
    let delegation = &identity["delegation"];
    TEMPLATES.contains(&template)
        && delegation["templates"][template] == true
        && after(at, &delegation["templateEnabledAfter"][template])
        && permits_delegated_message(identity, source, at)
}

pub(super) fn migrate_delegation_version(primary: &mut Value) -> bool {
    let Some(delegation) = primary.get_mut("delegation") else {
        return false;
    };
    if delegation["authorized"] == true && delegation.get("version").is_none() {
        delegation["version"] = json!(1);
        return true;
    }
    false
}

pub(super) fn invalidate_account(
    primary: &mut Value,
    source: &Value,
) -> Result<bool, TaskRuntimeError> {
    let policy = &primary["delegation"];
    let current = stand_in_connection(primary, source);
    if source_provider(source) != DINGTALK_PROVIDER
        || !is_exact_source(source)
        || source["delegated"] != true
        || policy["authorized"] != true
        || policy["profile"] != source["profile"]
        || policy["accountId"] != source["accountId"]
        || !current.is_some_and(|row| {
            row["delegated"] == true
                && row["accountId"] == source["accountId"]
                && row["enabledAfter"] == source["enabledAfter"]
        })
    {
        return Ok(false);
    }
    let version = next_version(policy["version"].as_u64().unwrap_or(0))?;
    if let Some(sources) = primary["connections"].as_array_mut() {
        sources.retain(|row| source_provider(row) != DINGTALK_PROVIDER);
    }
    let policy = &mut primary["delegation"];
    policy["authorized"] = json!(false);
    policy["paused"] = json!(true);
    policy["accountInvalidated"] = json!(true);
    policy["version"] = json!(version);
    policy["effectiveAfter"] = json!(now());
    policy["templateEnabledAfter"] = json!({});
    Ok(true)
}

fn is_selected_conversation(source: &Value) -> bool {
    matches!(source["kind"].as_str(), Some("direct" | "group"))
        && source["id"]
            .as_str()
            .is_some_and(|id| !id.is_empty() && id != "*")
        && source.get("scope").is_none()
        && source.get("collectionKey").is_none()
}

fn is_exact_source(source: &Value) -> bool {
    is_selected_conversation(source)
        && source["accountId"]
            .as_str()
            .is_some_and(|id| !id.trim().is_empty() && id.len() <= 256)
}

fn dingtalk_sources(primary: &Value) -> impl Iterator<Item = &Value> {
    primary["connections"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|source| source_provider(source) == DINGTALK_PROVIDER)
}

fn source_scope(primary: &Value) -> BTreeMap<(&str, &str), bool> {
    dingtalk_sources(primary)
        .map(|source| {
            (
                (
                    source["kind"].as_str().unwrap_or_default(),
                    source["id"].as_str().unwrap_or_default(),
                ),
                source["paused"] == true,
            )
        })
        .collect()
}

fn invalid(message: &str) -> TaskRuntimeError {
    TaskRuntimeError::Invalid(message.into())
}

fn next_version(version: u64) -> Result<u64, TaskRuntimeError> {
    version
        .checked_add(1)
        .ok_or_else(|| invalid("Delegation version is exhausted"))
}

fn selected_account(primary: &Value, previous: &Value) -> Result<(Value, Value), TaskRuntimeError> {
    let selected = dingtalk_sources(primary).next();
    let (profile, account) = selected
        .map_or((&previous["profile"], &previous["accountId"]), |source| {
            (&source["profile"], &source["accountId"])
        });
    if !dingtalk_sources(primary).all(|source| {
        is_exact_source(source)
            && source["profile"] == *profile
            && source["accountId"] == *account
            && source.get("paused").map_or(true, Value::is_boolean)
    }) {
        return Err(invalid(
            "Select exact DingTalk conversations for one verified account",
        ));
    }
    Ok((profile.clone(), account.clone()))
}

pub(super) fn strip_source_markers(identity: &mut Value) {
    for source in identity
        .get_mut("connections")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        if let Some(fields) = source.as_object_mut() {
            fields.remove("delegated");
        }
    }
}

fn templates(requested: &Value, previous: &Value) -> Result<Value, TaskRuntimeError> {
    let selected = requested
        .get("templates")
        .or_else(|| previous.get("templates"));
    if let Some(selected) = selected {
        if !selected.as_object().is_some_and(|fields| {
            fields.len() == TEMPLATES.len()
                && TEMPLATES
                    .iter()
                    .all(|template| selected[*template].is_boolean())
        }) {
            return Err(invalid(
                "The three delegation templates require boolean values",
            ));
        }
        return Ok(selected.clone());
    }
    Ok(json!({"document":true,"schedule":true,"process":true}))
}

pub(super) fn save_delegation(
    primary: &mut Value,
    previous_primary: &Value,
    direct_save: bool,
) -> Result<(), TaskRuntimeError> {
    let requested = primary["delegation"].clone();
    let previous = &previous_primary["delegation"];
    strip_source_markers(primary);
    if requested.is_null() && previous.is_null() {
        return Ok(());
    }
    if !requested.is_null() && !requested.is_object() {
        return Err(invalid("Invalid DingTalk delegation"));
    }
    let action = match requested.get("action") {
        None => "",
        Some(value) => value
            .as_str()
            .ok_or_else(|| invalid("Invalid delegation action"))?,
    };
    let (profile, account) = selected_account(primary, previous)?;
    let same_account = previous["profile"] == profile && previous["accountId"] == account;
    let was_authorized = same_account && previous["authorized"] == true;
    let has_sources = dingtalk_sources(primary).any(|source| source["paused"] != true);
    let enabled = primary["enabled"] == true;
    let (authorized, paused) = match action {
        "" => (
            was_authorized,
            !was_authorized || previous["paused"] != false || !has_sources || !enabled,
        ),
        "enable" if !was_authorized && has_sources && enabled => (true, false),
        "pause" if was_authorized => (true, true),
        "resume" if was_authorized && previous["paused"] == true && has_sources && enabled => {
            (true, false)
        }
        _ => return Err(invalid("The requested delegation action is unavailable")),
    };
    let template_settings = templates(&requested, previous)?;
    let boundary = json!(now());
    let carry_boundaries = was_authorized && (previous["paused"] == false || paused);
    stamp_delegated_sources(
        primary,
        previous_primary,
        same_account,
        carry_boundaries,
        &boundary,
    );
    let changed = !same_account
        || previous["authorized"] != authorized
        || previous["paused"] != paused
        || previous["templates"] != template_settings
        || source_scope(primary) != source_scope(previous_primary);
    if !direct_save && (changed || requested.get("action").is_some()) {
        return Err(invalid(
            "Change DingTalk delegation in the assistant settings",
        ));
    }
    let version = previous["version"].as_u64().unwrap_or(0);
    let version = if changed && (authorized || version > 0) {
        next_version(version)?
    } else {
        version
    };
    let cutoffs = TEMPLATES
        .into_iter()
        .filter(|template| template_settings[*template] == true)
        .map(|template| {
            let previous_cutoff = &previous["templateEnabledAfter"][template];
            let cutoff = if carry_boundaries
                && previous["templates"][template] == true
                && timestamp(previous_cutoff).is_some()
            {
                previous_cutoff.clone()
            } else {
                boundary.clone()
            };
            (template.to_owned(), cutoff)
        })
        .collect::<serde_json::Map<String, Value>>();
    primary["delegation"] = json!({
        "version": version, "profile": profile, "accountId": account, "authorized": authorized,
        "paused": paused, "templates": template_settings, "templateEnabledAfter": cutoffs,
        "accountInvalidated": previous["accountInvalidated"] == true && !authorized,
        "effectiveAfter": if changed { &boundary } else { &previous["effectiveAfter"] }
    });
    Ok(())
}

fn stamp_delegated_sources(
    primary: &mut Value,
    previous: &Value,
    same_account: bool,
    carry_boundaries: bool,
    boundary: &Value,
) {
    for source in primary["connections"]
        .as_array_mut()
        .into_iter()
        .flatten()
        .filter(|source| source_provider(source) == DINGTALK_PROVIDER)
    {
        let prior = same_account
            .then(|| stand_in_connection(previous, source))
            .flatten()
            .unwrap_or(&Value::Null);
        let paused = source["paused"]
            .as_bool()
            .unwrap_or(prior["paused"] == true);
        source["enabledAfter"] = if carry_boundaries
            && (prior["paused"] == false || paused)
            && timestamp(&prior["enabledAfter"]).is_some()
        {
            prior["enabledAfter"].clone()
        } else {
            boundary.clone()
        };
        source["delegated"] = json!(true);
        source["paused"] = json!(paused);
        source["policy"]["automatic"] = json!(true);
        source["policy"]["askBeforeAct"] = json!(false);
        source["policy"]["immediate"] = json!(true);
    }
}
