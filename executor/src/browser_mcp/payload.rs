use serde_json::{json, Map, Value};

pub(crate) fn string_arg(value: &Value, key: &str) -> String {
    optional_string_arg(value, key).unwrap_or_default()
}

pub(crate) fn optional_string_arg(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

pub(crate) fn number_arg(value: &Value, key: &str) -> f64 {
    optional_number_arg(value, key).unwrap_or(0.0)
}

pub(crate) fn optional_number_arg(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

pub(crate) fn optional_u64_arg(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(|value| {
        value.as_u64().or_else(|| {
            value
                .as_f64()
                .filter(|number| *number >= 0.0)
                .map(|number| number as u64)
        })
    })
}

pub(crate) fn optional_bool_arg(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
}

pub(crate) fn evaluate_expression(value: &Value) -> String {
    optional_string_arg(value, "expression")
        .or_else(|| optional_string_arg(value, "function"))
        .or_else(|| optional_string_arg(value, "fn"))
        .unwrap_or_default()
}

pub(crate) fn evaluate_action_violation(expression: &str) -> Option<&'static str> {
    let compact = expression
        .to_ascii_lowercase()
        .chars()
        .filter(|character| !character.is_ascii_whitespace())
        .collect::<String>();
    const DISALLOWED: &[(&str, &str)] = &[
        (".click(", "click invocation"),
        (".submit(", "form submission"),
        (".requestsubmit(", "form submission"),
        (".dispatchevent(", "synthetic event dispatch"),
        (".setattribute(", "DOM mutation"),
        (".removeattribute(", "DOM mutation"),
        (".appendchild(", "DOM mutation"),
        (".removechild(", "DOM mutation"),
        (".insertadjacent", "DOM mutation"),
        (".value=", "input value assignment"),
        (".checked=", "control state assignment"),
        (".innerhtml=", "DOM mutation"),
        (".outerhtml=", "DOM mutation"),
        (".textcontent=", "DOM mutation"),
        ("location.href=", "navigation"),
        ("location.assign(", "navigation"),
        ("location.replace(", "navigation"),
        ("window.open(", "navigation"),
        ("history.pushstate(", "navigation"),
        ("history.replacestate(", "navigation"),
    ];
    DISALLOWED
        .iter()
        .find_map(|(pattern, reason)| compact.contains(pattern).then_some(*reason))
}

pub(crate) fn inspect_payload(value: &Value) -> Value {
    json!({
        "action": "inspect",
        "options": {
            "mode": optional_string_arg(value, "mode").unwrap_or_else(|| "compact".to_owned()),
            "interactiveOnly": optional_bool_arg(value, "interactiveOnly").unwrap_or(false),
            "includeTextBlocks": optional_bool_arg(value, "includeTextBlocks").unwrap_or(true),
            "includeHidden": optional_bool_arg(value, "includeHidden").unwrap_or(false),
            "maxNodes": optional_number_arg(value, "maxNodes").unwrap_or(800.0),
            "maxTextChars": optional_number_arg(value, "maxTextChars").unwrap_or(12000.0),
            "maxNameChars": optional_number_arg(value, "maxNameChars").unwrap_or(120.0),
            "maxValueChars": optional_number_arg(value, "maxValueChars").unwrap_or(120.0),
            "viewportMargin": optional_number_arg(value, "viewportMargin").unwrap_or(600.0),
        },
        "timeoutMs": optional_u64_arg(value, "timeoutMs").unwrap_or(3000)
    })
}

pub(crate) fn action_target_payload(action: &str, value: &Value) -> Value {
    let mut payload = Map::new();
    payload.insert("action".to_owned(), Value::String(action.to_owned()));
    let mut options = Map::new();
    if let Some(text) =
        optional_string_arg(value, "text").or_else(|| optional_string_arg(value, "value"))
    {
        payload.insert("text".to_owned(), Value::String(text));
    }
    if let Some(key) = optional_string_arg(value, "key") {
        payload.insert("key".to_owned(), Value::String(key));
    }
    if let Some(ref_value) = optional_string_arg(value, "ref") {
        payload.insert("ref".to_owned(), Value::String(ref_value));
    }
    if let Some(inspect_id) = optional_string_arg(value, "inspectId") {
        payload.insert("inspectId".to_owned(), Value::String(inspect_id));
    }
    if let Some(index) = optional_u64_arg(value, "index") {
        payload.insert("index".to_owned(), json!(index));
    }
    if let Some(selector) =
        optional_string_arg(value, "selector").or_else(|| optional_string_arg(value, "element"))
    {
        payload.insert(
            "selector".to_owned(),
            Value::String(
                selector
                    .strip_prefix("css=")
                    .unwrap_or(&selector)
                    .to_owned(),
            ),
        );
    }
    if let Some(timeout_ms) = optional_u64_arg(value, "timeoutMs") {
        payload.insert("timeoutMs".to_owned(), json!(timeout_ms));
    }
    if let Some(values) = value.get("values").filter(|value| value.is_array()) {
        options.insert("values".to_owned(), values.clone());
    } else if let Some(value_arg) = optional_string_arg(value, "value") {
        options.insert("value".to_owned(), Value::String(value_arg));
    }
    if let Some(by) = optional_string_arg(value, "by") {
        options.insert("by".to_owned(), Value::String(by));
    }
    if let Some(checked) = optional_bool_arg(value, "checked") {
        options.insert("checked".to_owned(), Value::Bool(checked));
    }
    if let Some(direction) = optional_string_arg(value, "direction") {
        options.insert("direction".to_owned(), Value::String(direction));
    }
    if let Some(amount) = optional_number_arg(value, "amount") {
        options.insert("amount".to_owned(), json!(amount));
    }
    if let Some(mode) = optional_string_arg(value, "mode") {
        options.insert("mode".to_owned(), Value::String(mode));
    }
    if !options.is_empty() {
        payload.insert("options".to_owned(), Value::Object(options));
    }
    Value::Object(payload)
}

pub(crate) fn combined_action_payload(name: &str, arguments: &Value) -> Option<Value> {
    match name {
        "browser_open_and_inspect" => Some(json!({
            "action": "open",
            "url": string_arg(arguments, "url"),
            "timeoutMs": optional_u64_arg(arguments, "timeoutMs")
        })),
        "browser_click_and_inspect" => Some(action_target_payload("click", arguments)),
        "browser_fill_and_inspect" => Some(action_target_payload("fill", arguments)),
        "browser_type_and_inspect" => Some(action_target_payload("typeText", arguments)),
        "browser_wait_and_inspect" => None,
        _ => None,
    }
}

pub(crate) fn wait_payload(name: &str, arguments: &Value) -> Value {
    let mut payload = Map::new();
    payload.insert("action".to_owned(), Value::String("waitFor".to_owned()));
    if let Some(timeout_ms) = optional_u64_arg(arguments, "timeoutMs") {
        payload.insert("timeoutMs".to_owned(), json!(timeout_ms));
    }
    let allow_flat_wait_target = name == "browser_wait_and_inspect";
    apply_wait_condition(
        &mut payload,
        arguments,
        WaitConditionOptions {
            allow_flat_text: name == "browser_wait_and_inspect",
            allow_flat_selector: name == "browser_wait_and_inspect",
            allow_flat_url: allow_flat_wait_target,
        },
    );
    payload.insert(
        "options".to_owned(),
        wait_options(
            arguments,
            WaitConditionOptions {
                allow_flat_text: name == "browser_wait_and_inspect",
                allow_flat_selector: name == "browser_wait_and_inspect",
                allow_flat_url: allow_flat_wait_target,
            },
        ),
    );
    if !payload.contains_key("text")
        && !payload.contains_key("selector")
        && !payload.contains_key("url")
        && !payload.contains_key("expression")
    {
        payload.insert(
            "expression".to_owned(),
            Value::String(
                "document.readyState === 'interactive' || document.readyState === 'complete'"
                    .to_owned(),
            ),
        );
    }
    Value::Object(payload)
}

pub(crate) fn wait_options(arguments: &Value, options: WaitConditionOptions) -> Value {
    let mut condition = arguments
        .get("condition")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if options.allow_flat_text {
        if let Some(text) = optional_string_arg(arguments, "text") {
            condition
                .entry("textVisible".to_owned())
                .or_insert(Value::String(text));
        }
    }
    if options.allow_flat_selector {
        if let Some(selector) = optional_string_arg(arguments, "selector") {
            condition
                .entry("selectorAttached".to_owned())
                .or_insert(Value::String(selector));
        }
    }
    if options.allow_flat_url {
        if let Some(url) = optional_string_arg(arguments, "url") {
            condition
                .entry("urlIncludes".to_owned())
                .or_insert(Value::String(url));
        }
    }
    if let Some(url) = optional_string_arg(arguments, "urlIncludes") {
        condition
            .entry("urlIncludes".to_owned())
            .or_insert(Value::String(url));
    }
    if let Some(pattern) = optional_string_arg(arguments, "urlMatches") {
        condition
            .entry("urlMatches".to_owned())
            .or_insert(Value::String(pattern));
    }
    if let Some(title) = optional_string_arg(arguments, "titleIncludes") {
        condition
            .entry("titleIncludes".to_owned())
            .or_insert(Value::String(title));
    }
    if let Some(expression) = optional_string_arg(arguments, "fn")
        .or_else(|| optional_string_arg(arguments, "expression"))
        .or_else(|| optional_string_arg(arguments, "function"))
    {
        condition
            .entry("expression".to_owned())
            .or_insert(Value::String(expression));
    }
    if let Some(wait_until) = optional_string_arg(arguments, "waitUntil") {
        condition
            .entry("waitUntil".to_owned())
            .or_insert(Value::String(wait_until));
    }
    if condition.is_empty() {
        condition.insert(
            "waitUntil".to_owned(),
            Value::String("pageStable".to_owned()),
        );
    }

    let mut options_map = Map::new();
    options_map.insert("condition".to_owned(), Value::Object(condition));
    if let Some(poll_ms) = optional_u64_arg(arguments, "pollMs") {
        options_map.insert("pollMs".to_owned(), json!(poll_ms));
    }
    if let Some(quiet_ms) = optional_u64_arg(arguments, "quietMs") {
        options_map.insert("quietMs".to_owned(), json!(quiet_ms));
    }
    Value::Object(options_map)
}

fn apply_wait_condition(
    payload: &mut Map<String, Value>,
    arguments: &Value,
    options: WaitConditionOptions,
) {
    let condition = arguments
        .get("condition")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let flat_text = options
        .allow_flat_text
        .then(|| optional_string_arg(arguments, "text"))
        .flatten();
    if let Some(text) = flat_text.or_else(|| condition_string(&condition, "textVisible")) {
        payload.insert("text".to_owned(), Value::String(text));
    }
    let flat_selector = options
        .allow_flat_selector
        .then(|| optional_string_arg(arguments, "selector"))
        .flatten();
    if let Some(selector) = flat_selector
        .or_else(|| condition_string(&condition, "selectorVisible"))
        .or_else(|| condition_string(&condition, "selectorAttached"))
    {
        payload.insert("selector".to_owned(), Value::String(selector));
    }
    let flat_url = options
        .allow_flat_url
        .then(|| optional_string_arg(arguments, "url"))
        .flatten();
    if let Some(url) = optional_string_arg(arguments, "urlIncludes")
        .or(flat_url)
        .or_else(|| condition_string(&condition, "urlIncludes"))
    {
        payload.insert("url".to_owned(), Value::String(url));
    }
    if let Some(expression) = optional_string_arg(arguments, "fn")
        .or_else(|| optional_string_arg(arguments, "expression"))
        .or_else(|| optional_string_arg(arguments, "function"))
    {
        payload.insert("expression".to_owned(), Value::String(expression));
    } else if let Some(pattern) = optional_string_arg(arguments, "urlMatches")
        .or_else(|| condition_string(&condition, "urlMatches"))
    {
        payload.insert(
            "expression".to_owned(),
            Value::String(format!(
                "new RegExp({}).test(location.href)",
                serde_json::to_string(&pattern).unwrap_or_else(|_| "\"\"".to_owned())
            )),
        );
    } else if let Some(title) = optional_string_arg(arguments, "titleIncludes")
        .or_else(|| condition_string(&condition, "titleIncludes"))
    {
        payload.insert(
            "expression".to_owned(),
            Value::String(format!(
                "document.title.includes({})",
                serde_json::to_string(&title).unwrap_or_else(|_| "\"\"".to_owned())
            )),
        );
    }
}

#[derive(Clone, Copy)]
pub(crate) struct WaitConditionOptions {
    pub(crate) allow_flat_text: bool,
    pub(crate) allow_flat_selector: bool,
    pub(crate) allow_flat_url: bool,
}

fn condition_string(condition: &Map<String, Value>, key: &str) -> Option<String> {
    condition
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
}

pub(crate) fn normalize_wait_result(
    arguments: &Value,
    value: &Value,
    options: WaitConditionOptions,
) -> Value {
    let ok = value.get("ok").and_then(Value::as_bool).unwrap_or(true);
    json!({
        "ok": ok,
        "reason": if ok { wait_success_reason(arguments, options) } else { "timeout" },
        "elapsedMs": value.get("elapsedMs").cloned().unwrap_or_else(|| json!(0)),
        "observed": value.get("observed").cloned().unwrap_or_else(|| json!({})),
        "warnings": value.get("warnings").cloned().unwrap_or_else(|| json!([])),
        "error": value.get("error").cloned()
            .or_else(|| value.get("errorCode").map(|code| json!({ "code": code })))
    })
}

fn wait_success_reason(arguments: &Value, options: WaitConditionOptions) -> &'static str {
    let condition = arguments.get("condition").and_then(Value::as_object);
    if (options.allow_flat_text && optional_string_arg(arguments, "text").is_some())
        || condition
            .and_then(|value| value.get("textVisible"))
            .is_some()
    {
        return "text_visible";
    }
    if (options.allow_flat_selector && optional_string_arg(arguments, "selector").is_some())
        || condition
            .and_then(|value| value.get("selectorVisible"))
            .is_some()
    {
        return "selector_visible";
    }
    if (options.allow_flat_url && optional_string_arg(arguments, "url").is_some())
        || optional_string_arg(arguments, "urlIncludes").is_some()
        || optional_string_arg(arguments, "urlMatches").is_some()
        || condition
            .and_then(|value| value.get("urlIncludes"))
            .is_some()
        || condition
            .and_then(|value| value.get("urlMatches"))
            .is_some()
    {
        return "url_matched";
    }
    if optional_string_arg(arguments, "waitUntil").as_deref() == Some("domStable") {
        return "dom_stable";
    }
    "load_finished"
}

pub(crate) fn combined_inspect_payload(arguments: &Value) -> Value {
    if let Some(options) = arguments
        .get("inspectOptions")
        .filter(|value| value.is_object())
    {
        let mut options = options.clone();
        if let Some(timeout_ms) = optional_u64_arg(arguments, "inspectTimeoutMs")
            .or_else(|| optional_u64_arg(arguments, "timeoutMs"))
        {
            if let Some(object) = options.as_object_mut() {
                object.insert("timeoutMs".to_owned(), json!(timeout_ms));
            }
        }
        return inspect_payload(&options);
    }
    inspect_payload(arguments)
}

pub(crate) fn collect_warnings(target: &mut Vec<Value>, warnings: Option<&Value>) {
    if let Some(items) = warnings.and_then(Value::as_array) {
        target.extend(items.iter().cloned());
    }
}
