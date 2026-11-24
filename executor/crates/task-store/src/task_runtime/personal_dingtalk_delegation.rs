//! Explicit, account-scoped DingTalk intake configured by the primary assistant owner.
use super::*;

pub fn is_dingtalk_delegation_source(source: &Value) -> bool {
    source_provider(source) == DINGTALK_PROVIDER && source["dingtalkAccount"].is_object()
}

pub fn dingtalk_delegation_account_matches(left: &Value, right: &Value) -> bool {
    left["accountId"].is_string()
        && left["organizationId"].is_string()
        && left["accountId"] == right["accountId"]
        && left["organizationId"] == right["organizationId"]
}

pub(in crate::task_runtime) fn matching_source_accounts(left: &Value, right: &Value) -> bool {
    let left = &left["dingtalkAccount"];
    let right = &right["dingtalkAccount"];
    (left.is_null() && right.is_null()) || dingtalk_delegation_account_matches(left, right)
}

pub fn dingtalk_delegation_source_active(source: &Value) -> bool {
    !is_dingtalk_delegation_source(source) || source["enabledAfter"].is_string()
}

pub(in crate::task_runtime) fn work_visible(delegation: &Value, work: &Value) -> bool {
    let source = &work["source"];
    if is_dingtalk_delegation_source(source) {
        return dingtalk_delegation_account_matches(
            &delegation["account"],
            &source["dingtalkAccount"],
        );
    }
    // Legacy primary DingTalk work does not establish the selected account and organization.
    !(delegation.is_object()
        && work["roleId"] == "@primary"
        && source_provider(source) == DINGTALK_PROVIDER)
}

pub(super) fn bind_sources(primary: &mut Value) {
    let delegation = &primary["dingtalkDelegation"];
    let Some(sources) = delegation["sources"].as_array() else {
        return;
    };
    let mut connections = primary["connections"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    connections.retain(|source| source_provider(source) != DINGTALK_PROVIDER);
    connections.extend(sources.iter().map(|source| {
        let mut source = source.clone();
        source["dingtalkAccount"] = delegation["account"].clone();
        source["dingtalkDelegationVersion"] = delegation["version"].clone();
        source["enabledAfter"] = delegation["enabledAfter"].clone();
        source
    }));
    primary["connections"] = json!(connections);
}

pub(in crate::task_runtime) fn stamp(
    primary: &mut Value,
    previous: &Value,
) -> Result<(), TaskRuntimeError> {
    let Some(delegation) = primary.get("dingtalkDelegation") else {
        if previous["dingtalkDelegation"].is_object() {
            return Err(invalid("Preserve the saved DingTalk delegation"));
        }
        return Ok(());
    };
    let before = &previous["dingtalkDelegation"];
    let account = normalize_account(&delegation["account"])?;
    let requested_enabled = delegation["enabled"]
        .as_bool()
        .ok_or_else(|| invalid("DingTalk delegation state is required"))?;
    if requested_enabled && primary["enabled"] != true && before["enabled"] != true {
        return Err(invalid(
            "Enable your personal assistant before resuming DingTalk",
        ));
    }
    let enabled = requested_enabled && primary["enabled"] == true;
    let sources = normalize_sources(&delegation["sources"], &account)?;
    let templates = normalize_templates(&delegation["templates"])?;
    let same_scope = before["account"]["profile"] == account["profile"]
        && dingtalk_delegation_account_matches(&before["account"], &account)
        && before["sources"]
            .as_array()
            .is_some_and(|before| source_scope(before) == source_scope(&sources))
        && before["templates"] == templates
        && previous["model"] == primary["model"]
        && previous["executionDeviceId"] == primary["executionDeviceId"];
    if enabled && (!same_scope || sources.is_empty() || !primary["model"].is_object()) {
        return Err(invalid(
            "Save the scope and select an available model before enabling the DingTalk delegation",
        ));
    }
    let unchanged = same_scope && before["enabled"] == enabled;
    let version = before["version"].as_u64().unwrap_or(0);
    let enabled_after = if unchanged {
        before["enabledAfter"].clone()
    } else if enabled {
        json!(now())
    } else {
        Value::Null
    };
    primary["dingtalkDelegation"] = json!({
        "account": account,
        "enabled": enabled,
        "sources": sources,
        "templates": templates,
        "version": if unchanged { version } else { version + 1 },
        "enabledAfter": enabled_after,
    });
    Ok(())
}

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str, TaskRuntimeError> {
    value[key]
        .as_str()
        .filter(|text| {
            !text.trim().is_empty() && text.len() <= 512 && !text.chars().any(char::is_control)
        })
        .ok_or_else(|| invalid(&format!("Invalid DingTalk {key}")))
}

fn normalize_account(value: &Value) -> Result<Value, TaskRuntimeError> {
    let mut account = json!({
        "accountId": field(value, "accountId")?,
        "organizationId": field(value, "organizationId")?,
        "profile": field(value, "profile")?,
    });
    for key in ["accountName", "organizationName"] {
        if value.get(key).is_some() {
            account[key] = json!(field(value, key)?);
        }
    }
    Ok(account)
}

fn normalize_sources(sources: &Value, account: &Value) -> Result<Vec<Value>, TaskRuntimeError> {
    let rows = sources
        .as_array()
        .filter(|rows| rows.len() <= 1000)
        .ok_or_else(|| invalid("Invalid DingTalk delegation sources"))?;
    let mut ids = HashSet::new();
    rows.iter()
        .map(|row| {
            let kind = field(row, "kind")?;
            let id = field(row, "id")?;
            if !matches!(kind, "group" | "direct")
                || id == "*"
                || row["profile"] != account["profile"]
                || row["providerId"] != DINGTALK_PROVIDER
                || !ids.insert((kind, id))
            {
                return Err(invalid("DingTalk sources must belong to the selected account"));
            }
            Ok(json!({
                "providerId": DINGTALK_PROVIDER,
                "profile": account["profile"],
                "id": id,
                "kind": kind,
                "name": field(row, "name")?,
                "policy": {"automatic": false, "askBeforeAct": true, "immediate": false, "sessionStrategy": "independent"},
            }))
        })
        .collect()
}

fn source_scope(sources: &[Value]) -> std::collections::BTreeSet<(&str, &str)> {
    sources
        .iter()
        .filter_map(|row| Some((row["kind"].as_str()?, row["id"].as_str()?)))
        .collect()
}

fn normalize_templates(templates: &Value) -> Result<Value, TaskRuntimeError> {
    let mut result = json!({});
    for key in ["documentLink", "timeLocation", "standardProcess"] {
        result[key] = json!(templates[key]
            .as_bool()
            .ok_or_else(|| invalid("Select the allowed DingTalk reply templates"))?);
    }
    Ok(result)
}

pub(in crate::task_runtime) fn current_grant(
    delegation: &Value,
    role: &str,
    source: &Value,
) -> bool {
    if role != "@primary"
        || delegation["enabled"] != true
        || !dingtalk_delegation_account_matches(&delegation["account"], &source["dingtalkAccount"])
        || delegation["account"]["profile"] != source["profile"]
        || delegation["version"] != source["dingtalkDelegationVersion"]
        || delegation["enabledAfter"] != source["enabledAfter"]
    {
        return false;
    }
    delegation["sources"].as_array().is_some_and(|rows| {
        rows.iter()
            .any(|row| row["id"] == source["id"] && row["kind"] == source["kind"])
    })
}

pub fn after_dingtalk_delegation_boundary(source: &Value, message: &Value) -> bool {
    let parse = |value: &Value| {
        value
            .as_str()
            .and_then(crate::store::connection_message_millis)
    };
    parse(&source["enabledAfter"])
        .zip(parse(&message["at"]))
        .is_some_and(|(since, at)| at > since)
}

fn invalid(message: &str) -> TaskRuntimeError {
    TaskRuntimeError::Invalid(message.into())
}
