//! Host-owned permissions and effective boundaries for the primary DingTalk delegation.
use super::{now, source_provider, stand_in_connection, TaskRuntimeError, DINGTALK_PROVIDER};
use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Utc};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const TEMPLATES: [&str; 3] = ["document", "schedule", "process"];
const ACCOUNT_METADATA: [&str; 3] = ["organizationId", "organizationName", "accountName"];

pub fn is_primary_dingtalk(identity: &Value, source: &Value) -> bool {
    identity["id"] == "@primary" && source_provider(source) == DINGTALK_PROVIDER
}

pub fn requires_dingtalk_delegation(identity: &Value, source: &Value) -> bool {
    // Keep previously selected sources that required native confirmation.
    is_primary_dingtalk(identity, source)
        && (source["delegated"] == true
            || source["policy"]["askBeforeAct"] != true
            || (identity["dingTalkConnectionMode"] != "confirmed"
                && (identity["delegation"]["version"].as_u64().unwrap_or(0) > 0
                    || !is_selected_conversation(source))))
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
    (matches_enabled_source(current, delegation) && source["accountId"] == current["accountId"])
        .then_some(current)
}

fn matches_enabled_source(source: &Value, delegation: &Value) -> bool {
    is_exact_source(source)
        && source["delegated"] == true
        && source["paused"] == false
        && source["profile"] == delegation["profile"]
        && source["accountId"] == delegation["accountId"]
        && source["organizationId"] == delegation["organizationId"]
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
    let delegation = &identity["delegation"];
    active_delegated_source(identity, source).is_some_and(|current| {
        after(at, &current["enabledAfter"])
            && after_policy_cutoff(at, delegation.get("effectiveAfter"), delegation)
    })
}

fn after_policy_cutoff(at: &Value, cutoff: Option<&Value>, delegation: &Value) -> bool {
    // Legacy version 1 can omit policy cutoffs. The selected conversation's
    // saved cutoff is still mandatory and is at least as late as the earliest source cutoff.
    cutoff.map_or(delegation["version"] == 1, |cutoff| after(at, cutoff))
}

pub fn permits_delegated_reply(
    identity: &Value,
    source: &Value,
    template: &str,
    at: &Value,
) -> bool {
    let delegation = &identity["delegation"];
    let cutoff = match delegation.get("templateEnabledAfter") {
        Some(cutoffs) if !cutoffs.is_object() => return false,
        cutoffs => cutoffs.and_then(|cutoffs| cutoffs.get(template)),
    };
    TEMPLATES.contains(&template)
        && delegation["templates"][template] == true
        && after_policy_cutoff(at, cutoff, delegation)
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

fn earliest_enabled_source_boundary(primary: &Value) -> Option<&Value> {
    let delegation = &primary["delegation"];
    dingtalk_sources(primary)
        .filter(|source| matches_enabled_source(source, delegation))
        .filter_map(|source| {
            let cutoff = source.get("enabledAfter")?;
            Some((timestamp(cutoff)?, cutoff))
        })
        .min_by_key(|(time, _)| *time)
        .map(|(_, cutoff)| cutoff)
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

fn selected_account(primary: &Value, fallback: &Value) -> Result<(Value, Value), TaskRuntimeError> {
    let selected = dingtalk_sources(primary).next();
    let (profile, account) = selected
        .map_or((&fallback["profile"], &fallback["accountId"]), |source| {
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
            if fields.get("providerId").and_then(Value::as_str) == Some(DINGTALK_PROVIDER) {
                fields.remove("organizationId");
            }
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
    verified_account: Option<&Value>,
) -> Result<(), TaskRuntimeError> {
    let requested = primary["delegation"].clone();
    let previous = &previous_primary["delegation"];
    strip_source_markers(primary);
    let previously_confirmed = previous_primary["dingTalkConnectionMode"] == "confirmed";
    if previously_confirmed || primary["dingTalkConnectionMode"] == "confirmed" {
        if requested.get("action").is_some()
            || (!direct_save
                && (!previously_confirmed
                    || !dingtalk_sources(primary).eq(dingtalk_sources(previous_primary))))
        {
            return Err(invalid(
                "Change DingTalk connections in the assistant settings",
            ));
        }
        primary["dingTalkConnectionMode"] = json!("confirmed");
        primary.as_object_mut().unwrap().remove("delegation");
        for source in primary["connections"]
            .as_array_mut()
            .into_iter()
            .flatten()
            .filter(|source| source_provider(source) == DINGTALK_PROVIDER)
        {
            source["policy"]["askBeforeAct"] = json!(true);
            if !previously_confirmed {
                let was_paused = source["paused"] == true
                    || (previous["paused"] == true
                        && stand_in_connection(previous_primary, source)
                            .is_some_and(|saved| saved["delegated"] == true));
                if was_paused {
                    source["policy"]["automatic"] = json!(false);
                }
                source["enabledAfter"] = json!(now());
            }
        }
        return Ok(());
    }
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
    let preparing = action == "prepare";
    let binding = if preparing { &requested } else { previous };
    let (profile, account) = selected_account(primary, binding)?;
    if preparing
        && (profile != requested["profile"]
            || account != requested["accountId"]
            || !valid_account_field(&profile, 512)
            || !valid_account_field(&account, 256))
    {
        return Err(invalid("Prepare scope for one verified DingTalk account"));
    }
    if verified_account.is_some_and(|identity| {
        identity["profile"] != profile
            || identity["accountId"] != account
            || !valid_account_field(&identity["organizationId"], 512)
    }) {
        return Err(invalid(
            "The selected DingTalk account changed during verification",
        ));
    }
    let same_account = previous["profile"] == profile && previous["accountId"] == account;
    let was_authorized = same_account && previous["authorized"] == true;
    let has_sources = dingtalk_sources(primary).any(|source| source["paused"] != true);
    let enabled = primary["enabled"] == true;
    let (authorized, paused) = match action {
        "" => (
            was_authorized,
            !was_authorized || previous["paused"] != false || !has_sources || !enabled,
        ),
        "prepare" => (was_authorized, true),
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
    let metadata = verified_account.unwrap_or(if same_account { previous } else { &Value::Null });
    let mut account_metadata = serde_json::Map::new();
    for field in ACCOUNT_METADATA {
        if let Some(value) = metadata.get(field).filter(|value| !value.is_null()) {
            if !valid_account_field(value, 512) {
                return Err(invalid("Invalid DingTalk account metadata"));
            }
            account_metadata.insert(field.into(), value.clone());
        }
    }
    stamp_delegated_sources(
        primary,
        previous_primary,
        same_account,
        carry_boundaries,
        if authorized { &boundary } else { &Value::Null },
        account_metadata.get("organizationId"),
    );
    let changed = !same_account
        || previous["authorized"] != authorized
        || previous["paused"] != paused
        || previous["templates"] != template_settings
        || account_metadata.get("organizationId") != previous.get("organizationId")
        || source_scope(primary) != source_scope(previous_primary);
    let delegation_boundary_changed =
        !same_account || previous["authorized"] != authorized || previous["paused"] != paused;
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
    // An ordinary settings save can carry the legacy boundaries into a versioned policy.
    let legacy_boundary = (carry_boundaries && previous["version"] == 1)
        .then(|| earliest_enabled_source_boundary(previous_primary))
        .flatten();
    let effective_after = if !authorized {
        &Value::Null
    } else if delegation_boundary_changed {
        &boundary
    } else if let Some(cutoff) = previous.get("effectiveAfter") {
        cutoff
    } else if previous["version"] == 1 {
        legacy_boundary.unwrap_or(&boundary)
    } else {
        &Value::Null
    };
    let previous_cutoffs = previous.get("templateEnabledAfter");
    let cutoffs = TEMPLATES
        .into_iter()
        .filter(|template| authorized && template_settings[*template] == true)
        .map(|template| {
            let cutoff = if carry_boundaries && previous["templates"][template] == true {
                match previous_cutoffs.and_then(|cutoffs| cutoffs.get(template)) {
                    Some(cutoff) if timestamp(cutoff).is_some() => cutoff,
                    None if previous_cutoffs.map_or(true, Value::is_object) => {
                        legacy_boundary.unwrap_or(&boundary)
                    }
                    _ => &boundary,
                }
            } else {
                &boundary
            };
            (template.to_owned(), cutoff.clone())
        })
        .collect::<serde_json::Map<String, Value>>();
    primary["delegation"] = json!({
        "version": version, "profile": profile, "accountId": account, "authorized": authorized,
        "paused": paused, "templates": template_settings, "templateEnabledAfter": cutoffs,
        "accountInvalidated": !preparing && previous["accountInvalidated"] == true && !authorized,
        "effectiveAfter": effective_after
    });
    primary["delegation"]
        .as_object_mut()
        .expect("delegation settings are an object")
        .extend(account_metadata);
    Ok(())
}

fn valid_account_field(value: &Value, max_len: usize) -> bool {
    value.as_str().is_some_and(|text| {
        !text.trim().is_empty() && text.len() <= max_len && !text.chars().any(char::is_control)
    })
}

fn stamp_delegated_sources(
    primary: &mut Value,
    previous: &Value,
    same_account: bool,
    carry_boundaries: bool,
    boundary: &Value,
    organization_id: Option<&Value>,
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
        if let Some(organization_id) = organization_id {
            source["organizationId"] = organization_id.clone();
        }
        source["paused"] = json!(paused);
        source["policy"]["automatic"] = json!(true);
        source["policy"]["askBeforeAct"] = json!(false);
        source["policy"]["immediate"] = json!(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirmed_connection_replaces_delegation_only_through_direct_save() {
        let previous = json!({
            "id": "@primary",
            "enabled": true,
            "delegation": { "version": 2, "authorized": true, "paused": false },
            "connections": [],
        });
        let mut primary = json!({
            "id": "@primary",
            "enabled": true,
            "dingTalkConnectionMode": "confirmed",
            "delegation": previous["delegation"],
            "connections": [{
                "providerId": DINGTALK_PROVIDER,
                "kind": "group",
                "profile": "chosen-account",
                "id": "*",
                "scope": "all",
                "delegated": true,
                "policy": { "automatic": true, "askBeforeAct": false },
            }],
        });
        assert!(requires_dingtalk_delegation(
            &previous,
            &primary["connections"][0]
        ));
        assert!(save_delegation(&mut primary.clone(), &previous, false, None).is_err());
        save_delegation(&mut primary, &previous, true, None).unwrap();
        let source = &primary["connections"][0];
        assert!(primary.get("delegation").is_none());
        assert!(source.get("delegated").is_none());
        assert_eq!(source["scope"], "all");
        assert_eq!(source["profile"], "chosen-account");
        assert_eq!(source["policy"]["askBeforeAct"], true);
        assert!(timestamp(&source["enabledAfter"]).is_some());
        assert!(!requires_dingtalk_delegation(&primary, source));
        assert!(active_delegated_source(&primary, source).is_none());

        let mut expanded = primary.clone();
        expanded["connections"][0]["profile"] = json!("different-account");
        assert!(save_delegation(&mut expanded, &primary, false, None).is_err());
    }
}
