use serde_json::{json, Map, Value};

pub(crate) fn tools() -> Vec<Value> {
    vec![
        tool(
            "browser_open",
            "Open or navigate the Wework built-in browser to a URL.",
            &["url"],
        ),
        tool(
            "browser_inspect",
            "Return a compact structured page tree with numbered elements. Reuse known targets and inspect again only after page changes, unknown/stale targets, or for a final-page summary.",
            &[],
        ),
        tool(
            "browser_navigate",
            "Alias of browser_open for opening pages in Wegent's Wework desktop app.",
            &["url"],
        ),
        tool(
            "browser_open_and_inspect",
            "Open a URL, wait for page readiness, then return structured page inspection.",
            &["url"],
        ),
        tool(
            "browser_snapshot",
            "Deprecated text-only page read. Use browser_inspect for structured page inspection and browser_take_screenshot for screenshots.",
            &[],
        ),
        tool(
            "browser_click",
            "Click an element by inspect index/ref or a specific CSS selector. A requested click is complete only when this action succeeds.",
            &[],
        ),
        tool(
            "browser_click_coordinates",
            "Click viewport coordinates. Prefer an inspected index/ref when available.",
            &["x", "y"],
        ),
        tool(
            "browser_type",
            "Append text to an editable element by inspect index/ref or CSS selector.",
            &["text"],
        ),
        tool(
            "browser_fill",
            "Replace an editable element's value by inspect index/ref or CSS selector. Continue any separately requested click or submit action after filling.",
            &["text"],
        ),
        tool(
            "browser_click_and_inspect",
            "Click an element, wait for page stability, then return structured page inspection.",
            &[],
        ),
        tool(
            "browser_fill_and_inspect",
            "Fill an editable element, wait for page stability, then return structured page inspection.",
            &["text"],
        ),
        tool(
            "browser_type_and_inspect",
            "Type into an editable element, wait for page stability, then return structured page inspection.",
            &["text"],
        ),
        tool(
            "browser_fill_form",
            "Deprecated for WKWebView. Use browser_fill once per inspected field.",
            &["fields"],
        ),
        tool(
            "browser_press_key",
            "Press a keyboard key on the target or focused element.",
            &["key"],
        ),
        tool("browser_hover", "Hover an element.", &[]),
        tool("browser_focus", "Focus an element.", &[]),
        tool("browser_scroll", "Scroll the current page.", &[]),
        tool(
            "browser_scroll_into_view",
            "Scroll an element into view.",
            &[],
        ),
        tool("browser_select_option", "Select option values.", &[]),
        tool("browser_set_checked", "Set checkbox or radio checked state.", &[]),
        tool("browser_drag", "Drag between two elements.", &[]),
        tool("browser_wait_for", "Wait for page state.", &[]),
        tool(
            "browser_wait_and_inspect",
            "Wait for page state, then return structured page inspection.",
            &[],
        ),
        tool(
            "browser_resize",
            "Resize the embedded browser viewport.",
            &[],
        ),
        tool(
            "browser_take_screenshot",
            "Capture a screenshot only when the user explicitly requests one.",
            &[],
        ),
        tool(
            "browser_capabilities",
            "Report current embedded WKWebView browser capabilities and limits.",
            &[],
        ),
        tool(
            "browser_native_input_probe",
            "Probe AppKit native input availability for the embedded browser.",
            &[],
        ),
        tool(
            "browser_ax_probe",
            "Probe macOS accessibility-tree availability for the embedded browser.",
            &[],
        ),
        tool(
            "browser_present_probe",
            "Report panel/popout WebView presentation and reparent capability.",
            &[],
        ),
        tool(
            "browser_evaluate",
            "Evaluate read-only JavaScript for diagnostics. Use dedicated tools for page actions.",
            &[],
        ),
        tool(
            "browser_tab_list",
            "List browser tabs in Wegent's Wework desktop app.",
            &[],
        ),
        tool(
            "browser_tab_new",
            "Open a URL in the browser tab.",
            &["url"],
        ),
        tool("browser_tab_select", "Focus the embedded browser tab.", &[]),
        tool("browser_tab_close", "Close an embedded browser tab.", &[]),
    ]
}

fn tool(name: &str, description: &str, required: &[&str]) -> Value {
    let mut properties = Map::new();
    for key in [
        "url",
        "ref",
        "element",
        "text",
        "value",
        "key",
        "selector",
        "expression",
        "function",
        "fn",
        "kind",
        "screenshotId",
        "inspectId",
        "waitUntil",
        "urlIncludes",
        "urlMatches",
        "titleIncludes",
        "mode",
        "by",
        "direction",
        "startRef",
        "endRef",
    ] {
        properties.insert(key.to_owned(), json!({ "type": "string" }));
    }
    properties.insert(
        "ref".to_owned(),
        json!({
            "type": "string",
            "description": "Opaque element ref from browser_inspect, preferred for action targets."
        }),
    );
    properties.insert(
        "selector".to_owned(),
        json!({
            "type": "string",
            "description": "CSS selector target. Prefer inspect ref or index; use a specific selector with the same action tool when a fresh ref/index is unavailable or resolves the wrong element."
        }),
    );
    properties.insert(
        "text".to_owned(),
        json!({
            "type": "string",
            "description": "Text to type or fill into the target element."
        }),
    );
    properties.insert(
        "value".to_owned(),
        json!({
            "type": "string",
            "description": "Alternative text/value argument for fill/select tools."
        }),
    );
    for key in [
        "x",
        "y",
        "amount",
        "time",
        "timeMs",
        "timeoutMs",
        "width",
        "height",
    ] {
        properties.insert(key.to_owned(), json!({ "type": "number" }));
    }
    properties.insert(
        "index".to_owned(),
        json!({
            "type": "integer",
            "minimum": 0,
            "description": "Element index from the latest browser_inspect result, for example 0 for [0] textbox."
        }),
    );
    properties.insert("fields".to_owned(), json!({ "type": "array" }));
    properties.insert("condition".to_owned(), json!({ "type": "object" }));
    properties.insert("inspectOptions".to_owned(), json!({ "type": "object" }));
    for key in [
        "interactiveOnly",
        "includeTextBlocks",
        "includeHidden",
        "checked",
    ] {
        properties.insert(key.to_owned(), json!({ "type": "boolean" }));
    }
    properties.insert(
        "values".to_owned(),
        json!({ "type": "array", "items": { "type": "string" } }),
    );
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": true
        }
    })
}
