// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::collections::HashSet;

use brz_http_server::StatusCode;
use serde_json::{Map, Value};

use crate::http_compat::FastApiError;

fn invalid(path: &str) -> FastApiError {
    FastApiError::detail(
        StatusCode::UNPROCESSABLE_ENTITY,
        format!("Invalid collaboration template: {path}"),
    )
}

fn object<'a>(
    value: &'a Value,
    keys: &[&str],
    path: &str,
) -> Result<&'a Map<String, Value>, FastApiError> {
    let result = value.as_object().ok_or_else(|| invalid(path))?;
    if result.keys().any(|key| !keys.contains(&key.as_str()))
        || keys.iter().any(|key| !result.contains_key(*key))
    {
        return Err(invalid(path));
    }
    Ok(result)
}

fn text<'a>(
    value: &'a Value,
    path: &str,
    required: bool,
    max: usize,
) -> Result<&'a str, FastApiError> {
    let result = value.as_str().ok_or_else(|| invalid(path))?;
    if result.chars().count() > max || (required && result.trim().is_empty()) {
        return Err(invalid(path));
    }
    Ok(result)
}

pub(super) fn identity(value: &Value, path: &str) -> Result<String, FastApiError> {
    let name = text(value, path, true, 100)?;
    if !name.as_bytes()[0].is_ascii_alphanumeric()
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    {
        return Err(invalid(path));
    }
    Ok(name.to_owned())
}

fn array<'a>(value: &'a Value, path: &str, max: usize) -> Result<&'a Vec<Value>, FastApiError> {
    let result = value.as_array().ok_or_else(|| invalid(path))?;
    if result.len() > max {
        return Err(invalid(path));
    }
    Ok(result)
}

fn validate_group(value: &Value) -> Result<(String, String), FastApiError> {
    object(
        value,
        &[
            "key",
            "name",
            "description",
            "instructions",
            "leaderRole",
            "roles",
            "stages",
            "executionRequirements",
        ],
        "group",
    )?;
    let group_key = identity(&value["key"], "group.key")?;
    let name = text(&value["name"], "group.name", true, 200)?.to_owned();
    for field in ["description", "instructions"] {
        text(&value[field], field, false, 20000)?;
    }
    let roles = array(&value["roles"], "roles", 50)?;
    if roles.is_empty() {
        return Err(invalid("roles"));
    }
    let mut role_keys = HashSet::new();
    for role in roles {
        object(role, &["key", "name", "responsibility"], "role")?;
        if !role_keys.insert(identity(&role["key"], "role.key")?) {
            return Err(invalid("roles.key"));
        }
        text(&role["name"], "role.name", true, 200)?;
        text(&role["responsibility"], "role.responsibility", false, 20000)?;
    }
    let leader = identity(&value["leaderRole"], "leaderRole")?;
    if !role_keys.contains(&leader) {
        return Err(invalid("leaderRole"));
    }
    let mut stage_keys = HashSet::new();
    for stage in array(&value["stages"], "stages", 100)? {
        object(
            stage,
            &[
                "key",
                "name",
                "description",
                "ownerRole",
                "deliverables",
                "acceptance",
            ],
            "stage",
        )?;
        if !stage_keys.insert(identity(&stage["key"], "stage.key")?) {
            return Err(invalid("stages.key"));
        }
        text(&stage["name"], "stage.name", true, 200)?;
        for field in ["description", "acceptance"] {
            text(&stage[field], field, false, 20000)?;
        }
        if !stage["ownerRole"].is_null() {
            let owner = identity(&stage["ownerRole"], "stage.ownerRole")?;
            if owner == leader || !role_keys.contains(&owner) {
                return Err(invalid("stage.ownerRole"));
            }
        }
        for deliverable in array(&stage["deliverables"], "deliverables", 30)? {
            text(deliverable, "deliverable", true, 2000)?;
        }
    }
    object(
        &value["executionRequirements"],
        &["requiredTags"],
        "executionRequirements",
    )?;
    for tag in array(
        &value["executionRequirements"]["requiredTags"],
        "requiredTags",
        30,
    )? {
        text(tag, "requiredTag", true, 100)?;
    }
    Ok((group_key, name))
}

pub(super) fn validate(value: &Value) -> Result<(), FastApiError> {
    if value.to_string().len() > 1024 * 1024 {
        return Err(invalid("file_size"));
    }
    object(
        value,
        &["apiVersion", "kind", "metadata", "spec"],
        "document",
    )?;
    if value["apiVersion"] != "agent.wecode.io/v1" || value["kind"] != "Template" {
        return Err(invalid("apiVersion/kind"));
    }
    object(&value["metadata"], &["name", "namespace"], "metadata")?;
    identity(&value["metadata"]["name"], "metadata.name")?;
    identity(&value["metadata"]["namespace"], "metadata.namespace")?;
    let spec = &value["spec"];
    object(
        spec,
        &[
            "category",
            "displayName",
            "description",
            "version",
            "resources",
        ],
        "spec",
    )?;
    if spec["category"] != "collaboration" {
        return Err(invalid("spec.category"));
    }
    text(&spec["displayName"], "displayName", true, 200)?;
    text(&spec["description"], "description", false, 20000)?;
    identity(&spec["version"], "version")?;
    object(&spec["resources"], &["collaboration"], "resources")?;
    let collaboration = &spec["resources"]["collaboration"];
    object(collaboration, &["project", "groups"], "collaboration")?;
    object(
        &collaboration["project"],
        &["name", "description"],
        "project",
    )?;
    text(&collaboration["project"]["name"], "project.name", true, 200)?;
    text(
        &collaboration["project"]["description"],
        "project.description",
        false,
        20000,
    )?;
    let mut keys = HashSet::new();
    let mut names = HashSet::new();
    for group in array(&collaboration["groups"], "groups", 10)? {
        let (key, name) = validate_group(group)?;
        if !keys.insert(key) || !names.insert(name) {
            return Err(invalid("groups"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn builtin() -> Value {
        serde_json::from_str::<Vec<Value>>(include_str!(
            "../../../shared/data/collaboration-templates.json"
        ))
        .unwrap()
        .remove(0)
    }

    #[test]
    fn builtin_packages_use_the_portable_schema() {
        for value in serde_json::from_str::<Vec<Value>>(include_str!(
            "../../../shared/data/collaboration-templates.json"
        ))
        .unwrap()
        {
            validate(&value).unwrap();
        }
    }

    #[test]
    fn rejects_ownership_credentials_and_unknown_role_references() {
        let mut value = builtin();
        value["metadata"]["user_id"] = 99.into();
        assert!(validate(&value).is_err());
        let mut value = builtin();
        value["spec"]["resources"]["collaboration"]["groups"][0]["roles"][0]["token"] =
            "secret".into();
        assert!(validate(&value).is_err());
        let mut value = builtin();
        value["spec"]["resources"]["collaboration"]["groups"][0]["stages"][0]["ownerRole"] =
            "missing".into();
        assert!(validate(&value).is_err());
    }

    #[test]
    fn rejects_duplicate_groups_and_inbox_templates() {
        let mut value = builtin();
        value["spec"]["category"] = "inbox".into();
        assert!(validate(&value).is_err());
        let mut value = builtin();
        let group = value["spec"]["resources"]["collaboration"]["groups"][0].clone();
        value["spec"]["resources"]["collaboration"]["groups"]
            .as_array_mut()
            .unwrap()
            .push(group);
        assert!(validate(&value).is_err());
    }
}
