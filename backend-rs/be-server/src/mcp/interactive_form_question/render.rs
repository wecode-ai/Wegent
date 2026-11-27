// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `build_render_payload_from_tool_input`: tolerant question normalization
//! and the strict `RenderedInteractiveForm` validation
//! (`app/mcp_server/tools/interactive_form_question.py`).

use serde_json::{Map, Value, json};

use super::InteractiveFormRegistry;

/// Text-typed aliases (`TEXT_INPUT_TYPE_ALIASES`).
const TEXT_INPUT_TYPE_ALIASES: [&str; 8] = [
    "text",
    "text_input",
    "textarea",
    "long_text",
    "short_text",
    "string",
    "input",
    "free_text",
];
/// `SINGLE_CHOICE_INPUT_TYPE_ALIASES`.
const SINGLE_CHOICE_INPUT_TYPE_ALIASES: [&str; 10] = [
    "choice",
    "single_choice",
    "single_select",
    "select",
    "dropdown",
    "radio",
    "radio_group",
    "enum",
    "option",
    "",
];
/// `MULTI_CHOICE_INPUT_TYPE_ALIASES`.
const MULTI_CHOICE_INPUT_TYPE_ALIASES: [&str; 9] = [
    "multi_select",
    "multiple_select",
    "multiselect",
    "multi_choice",
    "multiple_choice",
    "checkbox",
    "checkboxes",
    "checkbox_group",
    "",
];
/// `QUESTION_TEXT_KEYS`.
const QUESTION_TEXT_KEYS: [&str; 5] = ["question", "title", "prompt", "label", "text"];
/// `INPUT_TYPE_KEYS`.
const INPUT_TYPE_KEYS: [&str; 4] = ["input_type", "inputType", "question_type", "questionType"];
/// `MULTI_SELECT_KEYS`.
const MULTI_SELECT_KEYS: [&str; 4] = ["multi_select", "multiSelect", "multiple", "multi"];

/// `_has_interactive_form_payload`: the block's `render_payload` parses as a
/// `RenderedInteractiveForm`.
pub(super) fn valid_render_payload(block: &Map<String, Value>) -> bool {
    let Some(render_payload) = parse_record(block.get("render_payload")) else {
        return false;
    };
    validate_rendered_form(&render_payload)
}

/// `_parse_record`: a dict, or a JSON string that decodes to a dict.
fn parse_record(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(Value::Object(_)) => value.cloned(),
        Some(Value::String(text)) => serde_json::from_str::<Value>(text).ok(),
        _ => None,
    }
}

/// `RenderedInteractiveForm.model_validate` (shape checks only; the renderer
/// consumes the payload, so any invalid form is ignored by the duplicate
/// check).
pub(super) fn validate_rendered_form(value: &Value) -> bool {
    let Some(form) = value.as_object() else {
        return false;
    };
    if form.get("type").and_then(Value::as_str) != Some("interactive_form_question") {
        return false;
    }
    if form.get("task_id").and_then(Value::as_i64).is_none()
        || form.get("subtask_id").and_then(Value::as_i64).is_none()
    {
        return false;
    }
    let Some(questions) = form.get("questions").and_then(Value::as_array) else {
        return false;
    };
    !questions.is_empty() && questions.iter().all(validate_rendered_question)
}

/// `RenderedInteractiveFormQuestion.model_validate`.
fn validate_rendered_question(value: &Value) -> bool {
    let Some(question) = value.as_object() else {
        return false;
    };
    let non_empty = |key: &str| {
        question
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty())
    };
    if !non_empty("id") || !non_empty("question") {
        return false;
    }
    let options = question.get("options");
    let has_options = options.is_some_and(|value| !value.is_null());
    match question.get("input_type").and_then(Value::as_str) {
        Some("choice") => {
            let Some(Value::Array(items)) = options else {
                return false;
            };
            if items.is_empty() {
                return false;
            }
        }
        Some("text") => {
            if has_options {
                return false;
            }
            if question
                .get("multi_select")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return false;
            }
        }
        _ => return false,
    }
    true
}

/// `build_render_payload_from_tool_input`: normalize the model's questions and
/// build the strict frontend render payload.
pub(super) async fn build_render_payload(
    registry: &InteractiveFormRegistry,
    task_id: i64,
    subtask_id: i64,
    value: Option<&Value>,
) -> Option<Value> {
    let raw = value.and_then(Value::as_array)?;
    if raw.is_empty() {
        return None;
    }
    let questions = registry.normalize(task_id, raw.clone()).await;
    let mut normalized = Vec::with_capacity(questions.len());
    for raw_question in &questions {
        let parsed = parse_question(raw_question)?;
        let has_options = !parsed.options.is_empty();
        let (input_type, multi_select) =
            normalize_input_type(&parsed.input_type, has_options, parsed.multi_select);
        let mut question = Map::new();
        question.insert("id".into(), json!(parsed.id));
        question.insert("question".into(), json!(parsed.question));
        question.insert("input_type".into(), json!(input_type));
        question.insert(
            "options".into(),
            if has_options {
                Value::Array(parsed.options.iter().map(option_payload).collect())
            } else {
                Value::Null
            },
        );
        question.insert(
            "multi_select".into(),
            json!(if has_options { multi_select } else { false }),
        );
        question.insert("required".into(), json!(parsed.required));
        question.insert(
            "default".into(),
            match parsed.default {
                Some(values) => Value::Array(values.into_iter().map(Value::String).collect()),
                None => Value::Null,
            },
        );
        question.insert(
            "placeholder".into(),
            parsed.placeholder.map(Value::String).unwrap_or(Value::Null),
        );
        normalized.push(Value::Object(question));
    }
    let form = json!({
        "type": "interactive_form_question",
        "task_id": task_id,
        "subtask_id": subtask_id,
        "questions": normalized,
    });
    validate_rendered_form(&form).then_some(form)
}

/// One parsed `InteractiveFormOption`.
struct ParsedOption {
    label: String,
    value: String,
    recommended: bool,
}

fn option_payload(option: &ParsedOption) -> Value {
    json!({
        "label": option.label,
        "value": option.value,
        "recommended": option.recommended,
    })
}

/// One normalized `InteractiveFormQuestionItem`.
struct ParsedQuestion {
    id: String,
    question: String,
    input_type: String,
    options: Vec<ParsedOption>,
    multi_select: bool,
    required: bool,
    default: Option<Vec<String>>,
    placeholder: Option<String>,
}

/// `_normalize_question_payload` + `InteractiveFormQuestionItem.model_validate`.
fn parse_question(raw: &Value) -> Option<ParsedQuestion> {
    let object = raw.as_object()?;
    let mut normalized = object.clone();

    if !python_truthy(normalized.get("question")) {
        for key in QUESTION_TEXT_KEYS {
            if let Some(Value::String(text)) = normalized.get(key)
                && !text.trim().is_empty()
            {
                normalized.insert("question".into(), json!(text));
                break;
            }
        }
    }
    if !python_truthy(normalized.get("input_type")) {
        for key in INPUT_TYPE_KEYS {
            if let Some(Value::String(text)) = normalized.get(key)
                && !text.trim().is_empty()
            {
                normalized.insert("input_type".into(), json!(text));
                break;
            }
        }
    }
    let input_type = match normalized.get("input_type") {
        None => "choice".to_string(),
        Some(Value::String(text)) => text.clone(),
        // A non-string `input_type` fails model validation.
        Some(_) => return None,
    };
    let (clean_input_type, embedded_question) =
        extract_input_type_and_embedded_question(&input_type);
    normalized.insert("input_type".into(), json!(clean_input_type));
    if let Some(embedded) = embedded_question
        && !python_truthy(normalized.get("question"))
    {
        normalized.insert("question".into(), json!(embedded));
    }
    if !normalized.contains_key("multi_select") {
        for key in MULTI_SELECT_KEYS {
            if let Some(value) = normalized.get(key)
                && !value.is_null()
            {
                normalized.insert("multi_select".into(), value.clone());
                break;
            }
        }
    }
    if let Some(Value::Array(options)) = normalized.get("options") {
        let options: Vec<Value> = options.iter().map(normalize_option_payload).collect();
        normalized.insert("options".into(), Value::Array(options));
    }

    let id = normalized.get("id")?.as_str()?.trim().to_string();
    if id.is_empty() {
        return None;
    }
    let question = normalized.get("question")?.as_str()?.trim().to_string();
    if question.is_empty() {
        return None;
    }
    let input_type = normalized.get("input_type")?.as_str()?.trim().to_string();
    if input_type.is_empty() {
        return None;
    }
    let options = match normalized.get("options") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => {
            let mut parsed = Vec::with_capacity(items.len());
            for item in items {
                parsed.push(parse_option(item)?);
            }
            parsed
        }
        Some(_) => return None,
    };
    let multi_select = bool_or_default(normalized.get("multi_select"), false);
    let required = bool_or_default(normalized.get("required"), true);
    let default = match normalized.get("default") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(vec![text.clone()]),
        Some(Value::Array(items)) => {
            let mut values = Vec::with_capacity(items.len());
            for item in items {
                values.push(item.as_str()?.to_string());
            }
            Some(values)
        }
        Some(_) => return None,
    };
    let placeholder = match normalized.get("placeholder") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(_) => return None,
    };
    Some(ParsedQuestion {
        id,
        question,
        input_type,
        options,
        multi_select,
        required,
        default,
        placeholder,
    })
}

/// CPython truthiness for the JSON values the normalization reads
/// (`if not normalized.get(...)`).
fn python_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|value| value != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(map)) => !map.is_empty(),
    }
}

fn bool_or_default(value: Option<&Value>, fallback: bool) -> bool {
    value.and_then(Value::as_bool).unwrap_or(fallback)
}

/// `_normalize_option_payload`: tolerate string and alternate key shorthands.
fn normalize_option_payload(option: &Value) -> Value {
    match option {
        Value::String(text) => json!({ "label": text.trim(), "value": text.trim() }),
        Value::Object(object) => {
            let mut normalized = object.clone();
            if !normalized.contains_key("label") {
                for key in ["name", "text", "title"] {
                    if let Some(Value::String(text)) = normalized.get(key)
                        && !text.trim().is_empty()
                    {
                        normalized.insert("label".into(), json!(text));
                        break;
                    }
                }
            }
            if !normalized.contains_key("value")
                && let Some(Value::String(label)) = normalized.get("label")
                && !label.trim().is_empty()
            {
                normalized.insert("value".into(), json!(label));
            }
            Value::Object(normalized)
        }
        other => other.clone(),
    }
}

/// `InteractiveFormOption.model_validate`.
fn parse_option(value: &Value) -> Option<ParsedOption> {
    let object = value.as_object()?;
    let label = object.get("label")?.as_str()?.trim().to_string();
    if label.is_empty() {
        return None;
    }
    let value_text = object.get("value")?.as_str()?.trim().to_string();
    if value_text.is_empty() {
        return None;
    }
    Some(ParsedOption {
        label,
        value: value_text,
        recommended: object
            .get("recommended")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

/// `_normalize_input_type`: map aliases, choosing text when there are no
/// options.
fn normalize_input_type(
    input_type: &str,
    has_options: bool,
    explicit_multi_select: bool,
) -> (&'static str, bool) {
    let normalized = input_type.trim().to_lowercase().replace(['-', ' '], "_");
    if TEXT_INPUT_TYPE_ALIASES.contains(&normalized.as_str()) {
        return ("text", false);
    }
    if MULTI_CHOICE_INPUT_TYPE_ALIASES.contains(&normalized.as_str()) {
        return if has_options {
            ("choice", true)
        } else {
            ("text", false)
        };
    }
    if SINGLE_CHOICE_INPUT_TYPE_ALIASES.contains(&normalized.as_str()) {
        return if has_options {
            ("choice", explicit_multi_select)
        } else {
            ("text", false)
        };
    }
    if explicit_multi_select && has_options {
        return ("choice", true);
    }
    if has_options {
        return ("choice", false);
    }
    ("text", false)
}

/// `_extract_input_type_and_embedded_question`: recover the question text from
/// malformed values like `choice(question(...))`
/// (`EMBEDDED_QUESTION_PATTERN`).
fn extract_input_type_and_embedded_question(input_type: &str) -> (String, Option<String>) {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        regex::Regex::new(r"(?i)(?P<input_type>[a-zA-Z0-9_\-\s]+)\s*\(\s*question\s*\(")
            .expect("static embedded-question pattern")
    });
    let Some(captures) = pattern.captures(input_type) else {
        return (input_type.to_string(), None);
    };
    let kind = captures
        .name("input_type")
        .map(|matched| matched.as_str().trim().to_string())
        .unwrap_or_default();
    let Some(whole) = captures.get(0) else {
        return (input_type.to_string(), None);
    };
    let mut embedded = input_type[whole.end()..].trim().to_string();
    let mut closers = 2;
    while closers > 0 && embedded.ends_with(')') {
        embedded.pop();
        embedded = embedded.trim().to_string();
        closers -= 1;
    }
    (kind, (!embedded.is_empty()).then_some(embedded))
}
