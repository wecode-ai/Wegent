//! Composer options reuse the versioned producer contract, excluding transport authority.
use serde_json::{json, Value};

pub(super) fn creation_properties() -> Value {
    let contract: Value = serde_json::from_str(include_str!(
        "../../../shared/protocol/runtime_task_create_request_v2.schema.json"
    ))
    .expect("checked-in creation contract");
    let mut options = expand_refs(&contract, &contract);
    options.as_object_mut().unwrap().remove("required");
    let properties = options["properties"].as_object_mut().unwrap();
    for key in [
        "schemaVersion",
        "taskId",
        "message",
        "title",
        "workspacePath",
        "bot",
        "clientUserMessageId",
        "origin",
        "cloudProjectId",
        "deliveryId",
        "friendlyTitle",
    ] {
        properties.remove(key);
    }
    properties["initialSupervisor"]["properties"]
        .as_object_mut()
        .unwrap()
        .remove("modelConfig");
    // Thread identity comes from an authorized conversation reference, never a raw handle.
    properties.remove("sideSource");
    properties.remove("workspaceSourceTask");
    properties.insert("execution".into(), json!({"type":"object","properties":{
        "workspace":{"type":"object","properties":{
            "source":{"enum":["local_path","git_worktree"]},"path":{"type":"string","minLength":1},
            "branch":{"type":"string","minLength":1},"createBranch":{"type":"boolean","description":"Create and switch to a new branch in local_path mode."}
        },"required":["source"],"additionalProperties":false},
        "environment":{"type":"object"}
    },"additionalProperties":false}));
    options["description"] = json!("Wework composer options using RuntimeTaskCreateRequest V2 field names. Omitted runtime/model inherit the caller on this device; remote creation requires an explicit modelSelection. Project bindings and references use the separate fields below.");
    json!({
        "message":{"type":"string","minLength":1},
        "title":{"type":"string","minLength":1},
        "workspace_path":{"type":"string","minLength":1},
        "options":options,
        "reference_conversation_id":{"type":"string","minLength":1,"description":"Reference an authorized Codex conversation using the same side-conversation fork flow as the composer."},
        "project_space":{"type":"object","properties":{
            "space_id":{"type":"string","minLength":1},
            "item_id":{"type":"string","minLength":1},
            "store":{"enum":["local","cloud"]}
        },"required":["space_id","store"],"additionalProperties":false}
    })
}

fn expand_refs(value: &Value, root: &Value) -> Value {
    if let Some(reference) = value["$ref"].as_str() {
        return expand_refs(
            root.pointer(reference.strip_prefix('#').unwrap()).unwrap(),
            root,
        );
    }
    match value {
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .filter(|(key, _)| !matches!(key.as_str(), "$schema" | "$id" | "$defs"))
                .map(|(key, child)| (key.clone(), expand_refs(child, root)))
                .collect(),
        ),
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| expand_refs(item, root)).collect())
        }
        _ => value.clone(),
    }
}
