//! A business-independent HTML delivery surface using the existing MCP Apps host.
use crate::local::app_ipc::AppIpcError;
use serde_json::{json, Value};

pub(crate) const INTERACTION_URI: &str = "ui://wework-control/interaction.html";

pub(super) fn tool_metadata(name: &str) -> Value {
    let mut ui = json!({"visibility":["model"]});
    if name == "present_interaction" {
        ui["resourceUri"] = json!(INTERACTION_URI);
    } else if super::capabilities()
        .iter()
        .any(|tool| tool["name"] == name)
    {
        ui["visibility"] = json!(["model", "app"]);
    }
    json!({"ui":ui})
}

pub(crate) fn present(arguments: Value) -> Result<Value, AppIpcError> {
    let html = arguments["html"].as_str().unwrap_or_default();
    let tools = arguments["tools"].as_array().cloned().unwrap_or_default();
    let catalog = super::capabilities();
    if html.len() > 1024 * 1024
        || tools.iter().any(|name| {
            name == "present_interaction" || !catalog.iter().any(|tool| tool["name"] == *name)
        })
    {
        return Err(AppIpcError::new(
            "bad_request",
            "Invalid interaction document or tool binding",
        ));
    }
    let bound: Vec<_> = catalog
        .into_iter()
        .filter(|tool| tools.contains(&tool["name"]))
        .collect();
    Ok(
        json!({"title":arguments["title"],"_meta":{"ui":{"resourceUri":INTERACTION_URI,"html":html,"tools":bound}}}),
    )
}

pub(crate) fn resources() -> Vec<Value> {
    vec![json!({"uri":INTERACTION_URI,"name":"Wework interaction",
        "description":"Host dynamically generated HTML with real tools and native navigation",
        "mimeType":"text/html;profile=mcp-app"})]
}

pub(crate) fn read_resource(uri: &str) -> Option<Value> {
    if uri != INTERACTION_URI {
        return None;
    }
    let html = include_str!("apps/interaction.html")
        .replace("__STYLES__", include_str!("apps/interaction.css"))
        .replace("__SCRIPT__", include_str!("apps/interaction.js"));
    Some(
        json!({"contents":[{"uri":uri,"mimeType":"text/html;profile=mcp-app","text":html,
        "_meta":{"ui":{"csp":{"connectDomains":[],"resourceDomains":[]}},
        "openai/ui":{"availableDisplayModes":["inline","fullscreen"],"preferredDisplayMode":"inline"}}}]}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_interactions_bind_real_capabilities_without_business_templates() {
        let catalog = super::super::capabilities();
        for tool in super::super::tools() {
            let name = tool["name"].as_str().unwrap();
            assert_eq!(
                tool["_meta"]["ui"]["resourceUri"].is_string(),
                name == "present_interaction"
            );
            let callable =
                name != "present_interaction" && catalog.iter().any(|item| item["name"] == name);
            assert_eq!(
                tool["_meta"]["ui"]["visibility"],
                if callable {
                    json!(["model", "app"])
                } else {
                    json!(["model"])
                }
            );
        }
        for capability in catalog
            .iter()
            .filter(|item| item["name"] != "present_interaction")
        {
            let presented =
                present(json!({"html":"<button>Execute</button>","tools":[capability["name"]]}))
                    .unwrap();
            assert_eq!(presented["_meta"]["ui"]["tools"], json!([capability]));
        }
        assert!(present(json!({"html":"Hi","tools":["unregistered_capability"]})).is_err());
        assert!(present(json!({"html":"Hi","tools":["invoke_capability"]})).is_err());
        assert!(present(json!({"html":"Hi","tools":["present_interaction"]})).is_err());
        assert!(read_resource("file:///etc/passwd").is_none());
        assert_eq!(resources().len(), 1);
        let resource = read_resource(INTERACTION_URI).unwrap();
        assert_eq!(
            resource["contents"][0]["_meta"]["openai/ui"]["preferredDisplayMode"],
            "inline"
        );
        let html = resource["contents"][0]["text"].as_str().unwrap();
        assert!(!html.contains("__SCRIPT__"));
        assert!(!html.contains("__STYLES__"));
    }
}
