use serde_json::{json, Map, Value};

pub(crate) fn tools() -> Vec<Value> {
    vec![
        tool(
            "browser_open",
            "Open or navigate the Wework built-in browser to a URL.",
            &["url"],
            &["url"],
        ),
        tool(
            "browser_inspect",
            "Return a compact structured page tree with numbered elements. Reuse known targets and inspect again only after page changes, unknown/stale targets, or for a final-page summary.",
            &[
                "mode",
                "interactiveOnly",
                "includeTextBlocks",
                "includeHidden",
                "maxNodes",
                "maxTextChars",
                "maxNameChars",
                "maxValueChars",
                "viewportMargin",
                "timeoutMs",
                "includeJson",
            ],
            &[],
        ),
        tool(
            "browser_navigate",
            "Alias of browser_open for opening pages in Wegent's Wework desktop app.",
            &["url"],
            &["url"],
        ),
        tool(
            "browser_open_and_inspect",
            "Open a URL, wait for page readiness, then return structured page inspection.",
            &[
                "url",
                "condition",
                "pollMs",
                "quietMs",
                "timeoutMs",
                "inspectOptions",
                "inspectTimeoutMs",
                "includeJson",
            ],
            &["url"],
        ),
        tool(
            "browser_snapshot",
            "Deprecated text-only page read. Use browser_inspect for structured page inspection and browser_take_screenshot for screenshots.",
            &["includeJson"],
            &[],
        ),
        tool(
            "browser_click",
            "Click an element by inspect index/ref or a specific CSS selector. A requested click is complete only when this action succeeds.",
            &["ref", "index", "inspectId", "selector", "timeoutMs", "includeJson"],
            &[],
        ),
        tool(
            "browser_click_coordinates",
            "Click viewport coordinates. Prefer an inspected index/ref when available.",
            &["x", "y", "includeJson"],
            &["x", "y"],
        ),
        tool(
            "browser_type",
            "Append text to an editable element by inspect index/ref or CSS selector.",
            &[
                "ref",
                "index",
                "inspectId",
                "selector",
                "text",
                "timeoutMs",
                "includeJson",
            ],
            &["text"],
        ),
        tool(
            "browser_fill",
            "Replace an editable element's value by inspect index/ref or CSS selector. Continue any separately requested click or submit action after filling.",
            &[
                "ref",
                "index",
                "inspectId",
                "selector",
                "text",
                "timeoutMs",
                "includeJson",
            ],
            &["text"],
        ),
        combined_target_tool(
            "browser_click_and_inspect",
            "Click an element, wait for page stability, then return structured page inspection.",
            &[],
        ),
        combined_target_tool(
            "browser_fill_and_inspect",
            "Fill an editable element, wait for page stability, then return structured page inspection.",
            &["text"],
        ),
        combined_target_tool(
            "browser_type_and_inspect",
            "Type into an editable element, wait for page stability, then return structured page inspection.",
            &["text"],
        ),
        tool(
            "browser_press_key",
            "Press a keyboard key on the target or focused element.",
            &[
                "ref",
                "index",
                "inspectId",
                "selector",
                "key",
                "timeoutMs",
                "includeJson",
            ],
            &["key"],
        ),
        target_tool("browser_hover", "Hover an element."),
        target_tool("browser_focus", "Focus an element."),
        tool(
            "browser_scroll",
            "Scroll the current page.",
            &[
                "x",
                "y",
                "direction",
                "amount",
                "mode",
                "timeoutMs",
                "includeJson",
            ],
            &[],
        ),
        target_tool(
            "browser_scroll_into_view",
            "Scroll an element into view.",
        ),
        tool(
            "browser_select_option",
            "Select option values.",
            &[
                "ref",
                "index",
                "inspectId",
                "selector",
                "value",
                "values",
                "by",
                "timeoutMs",
                "includeJson",
            ],
            &[],
        ),
        tool(
            "browser_set_checked",
            "Set checkbox or radio checked state.",
            &[
                "ref",
                "index",
                "inspectId",
                "selector",
                "checked",
                "timeoutMs",
                "includeJson",
            ],
            &["checked"],
        ),
        tool(
            "browser_wait_for",
            "Wait for page state.",
            &[
                "text",
                "selector",
                "url",
                "urlIncludes",
                "urlMatches",
                "titleIncludes",
                "expression",
                "waitUntil",
                "condition",
                "pollMs",
                "quietMs",
                "timeoutMs",
                "includeJson",
            ],
            &[],
        ),
        tool(
            "browser_wait_and_inspect",
            "Wait for page state, then return structured page inspection.",
            &[
                "text",
                "selector",
                "url",
                "urlIncludes",
                "urlMatches",
                "titleIncludes",
                "expression",
                "waitUntil",
                "condition",
                "pollMs",
                "quietMs",
                "timeoutMs",
                "inspectOptions",
                "inspectTimeoutMs",
                "includeJson",
            ],
            &[],
        ),
        tool(
            "browser_resize",
            "Resize the embedded browser viewport.",
            &[],
            &[],
        ),
        tool(
            "browser_take_screenshot",
            "Capture a screenshot only when the user explicitly requests one.",
            &[],
            &[],
        ),
        tool(
            "browser_capabilities",
            "Report current embedded WKWebView browser capabilities and limits.",
            &["includeJson"],
            &[],
        ),
        tool(
            "browser_native_input_probe",
            "Probe AppKit native input availability for the embedded browser.",
            &["x", "y", "key", "text", "kind", "screenshotId", "includeJson"],
            &[],
        ),
        tool(
            "browser_ax_probe",
            "Probe macOS accessibility-tree availability for the embedded browser.",
            &["mode", "maxNodes", "includeJson"],
            &[],
        ),
        tool(
            "browser_present_probe",
            "Report panel/popout WebView presentation and reparent capability.",
            &["includeJson"],
            &[],
        ),
        tool(
            "browser_evaluate",
            "Evaluate read-only JavaScript for diagnostics. Use dedicated tools for page actions.",
            &["expression", "includeJson"],
            &["expression"],
        ),
    ]
}

fn target_tool(name: &str, description: &str) -> Value {
    tool(
        name,
        description,
        &[
            "ref",
            "index",
            "inspectId",
            "selector",
            "timeoutMs",
            "includeJson",
        ],
        &[],
    )
}

fn combined_target_tool(name: &str, description: &str, required: &[&str]) -> Value {
    tool(
        name,
        description,
        &[
            "ref",
            "index",
            "inspectId",
            "selector",
            "text",
            "condition",
            "pollMs",
            "quietMs",
            "timeoutMs",
            "inspectOptions",
            "inspectTimeoutMs",
            "includeJson",
        ],
        required,
    )
}

fn tool(name: &str, description: &str, properties: &[&str], required: &[&str]) -> Value {
    let properties = properties
        .iter()
        .map(|name| ((*name).to_owned(), property_schema(name)))
        .collect::<Map<String, Value>>();
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false
        }
    })
}

fn property_schema(name: &str) -> Value {
    match name {
        "ref" => json!({
            "type": "string",
            "description": "Opaque element ref from browser_inspect."
        }),
        "index" => json!({
            "type": "integer",
            "minimum": 0,
            "description": "Element index from the latest browser_inspect result."
        }),
        "selector" => json!({
            "type": "string",
            "description": "CSS selector when no fresh inspect ref/index is available; use it with the same action tool."
        }),
        "text" => json!({ "type": "string" }),
        "value" => json!({ "type": "string" }),
        "values" => json!({ "type": "array", "items": { "type": "string" } }),
        "checked" | "interactiveOnly" | "includeTextBlocks" | "includeHidden" | "includeJson" => {
            json!({ "type": "boolean" })
        }
        "x" | "y" | "amount" | "maxNodes" | "maxTextChars" | "maxNameChars" | "maxValueChars"
        | "viewportMargin" | "pollMs" | "quietMs" | "timeoutMs" | "inspectTimeoutMs" => {
            json!({ "type": "number" })
        }
        "condition" | "inspectOptions" => json!({ "type": "object" }),
        _ => json!({ "type": "string" }),
    }
}
