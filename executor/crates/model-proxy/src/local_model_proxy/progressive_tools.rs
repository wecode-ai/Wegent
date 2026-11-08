//! Model-facing discovery guidance for the native Code Mode runtime.
//! Tool registration, ALL_TOOLS, execution, permissions and results remain native.
use serde_json::Value;

const DISCOVERY_INSTRUCTIONS: &str =
    include_str!("../../../../../shared/assets/codexDiscoveryInstructions.md");

pub(super) fn prepare(body: &[u8]) -> Result<Vec<u8>, serde_json::Error> {
    let mut value: Value = serde_json::from_slice(body)?;
    if apply(&mut value) {
        serde_json::to_vec(&value)
    } else {
        Ok(body.to_vec())
    }
}

fn apply(body: &mut Value) -> bool {
    let mut changed = false;
    if let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) {
        changed |= apply_declarations(tools);
    }
    for item in body
        .get_mut("input")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        if item["type"] == "additional_tools" {
            if let Some(tools) = item.get_mut("tools").and_then(Value::as_array_mut) {
                changed |= apply_declarations(tools);
            }
        }
    }
    changed
}

fn apply_declarations(tools: &mut [Value]) -> bool {
    let mut changed = false;
    for tool in tools {
        if tool["type"] == "namespace" && tool["name"] == "functions" {
            if let Some(members) = tool.get_mut("tools").and_then(Value::as_array_mut) {
                changed |= apply_declarations(members);
            }
        } else if tool["type"] == "custom"
            && tool["name"] == "exec"
            && tool["description"].as_str() != Some(DISCOVERY_INSTRUCTIONS)
        {
            changed = true;
            tool["description"] = Value::String(DISCOVERY_INSTRUCTIONS.to_owned());
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn changes_only_native_exec_guidance_in_both_wire_forms() {
        let exec = json!({"type":"custom","name":"exec","description":"Expanded catalog","format":{"type":"grammar","syntax":"lark","definition":"native"}});
        let other = json!({"type":"namespace","name":"app","tools":[exec.clone()]});
        for lite in [false, true] {
            let declarations = json!([{"type":"namespace","name":"functions","tools":[exec.clone()]},other.clone()]);
            let mut body = if lite {
                json!({"input":[{"type":"additional_tools","tools":declarations}]})
            } else {
                json!({"tools":declarations})
            };
            body = serde_json::from_slice(&prepare(&serde_json::to_vec(&body).unwrap()).unwrap())
                .unwrap();
            let tools = if lite {
                &body["input"][0]["tools"]
            } else {
                &body["tools"]
            };
            assert_eq!(tools[0]["tools"][0]["format"], exec["format"]);
            assert!(tools[0]["tools"][0]["description"]
                .as_str()
                .unwrap()
                .contains("ALL_TOOLS"));
            assert_eq!(tools[1], other);
        }
    }
}
