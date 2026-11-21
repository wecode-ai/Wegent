// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The `interactive_form_question` tool surface
//! (`app/mcp_server/tools/interactive_form_question.py`): the pydantic
//! `InteractiveFormOption` / `InteractiveFormQuestionItem` `$defs`, the
//! decorator parameter list, and the generated `tools/list` entry.

use serde_json::{Map, Value, json};

use super::super::tools::{self, Param, ParamKind, Tool};

/// `InteractiveFormOption`.
fn interactive_form_option_schema() -> Value {
    let mut properties = Map::new();
    properties.insert(
        "label".to_string(),
        json!({ "title": "Label", "type": "string" }),
    );
    properties.insert(
        "value".to_string(),
        json!({ "title": "Value", "type": "string" }),
    );
    properties.insert(
        "recommended".to_string(),
        json!({ "default": false, "title": "Recommended", "type": "boolean" }),
    );
    json!({
        "description": "A single selectable option in an interactive form question.",
        "properties": properties,
        "required": ["label", "value"],
        "title": "InteractiveFormOption",
        "type": "object",
    })
}

/// `InteractiveFormQuestionItem`.
fn interactive_form_question_schema() -> Value {
    let mut properties = Map::new();
    properties.insert(
        "default".to_string(),
        json!({
            "anyOf": [
                { "items": { "type": "string" }, "type": "array" },
                { "type": "string" },
                { "type": "null" }
            ],
            "default": null,
            "title": "Default"
        }),
    );
    properties.insert("id".to_string(), json!({ "title": "Id", "type": "string" }));
    properties.insert(
        "input_type".to_string(),
        json!({ "default": "choice", "title": "Input Type", "type": "string" }),
    );
    properties.insert(
        "multi_select".to_string(),
        json!({ "default": false, "title": "Multi Select", "type": "boolean" }),
    );
    properties.insert(
        "options".to_string(),
        json!({
            "anyOf": [
                {
                    "items": { "$ref": "#/$defs/InteractiveFormOption" },
                    "type": "array"
                },
                { "type": "null" }
            ],
            "default": null,
            "title": "Options"
        }),
    );
    properties.insert(
        "placeholder".to_string(),
        json!({
            "anyOf": [{ "type": "string" }, { "type": "null" }],
            "default": null,
            "title": "Placeholder"
        }),
    );
    properties.insert(
        "question".to_string(),
        json!({ "title": "Question", "type": "string" }),
    );
    properties.insert(
        "required".to_string(),
        json!({ "default": true, "title": "Required", "type": "boolean" }),
    );
    json!({
        "description": "A model-provided question payload accepted by the MCP tool.",
        "properties": properties,
        "required": ["id", "question"],
        "title": "InteractiveFormQuestionItem",
        "type": "object",
    })
}

/// The schema builders `questions` references, in `$defs` order.
pub(super) static FORM_DEFS_LIST: [tools::DefBuilder; 2] = [
    ("InteractiveFormOption", interactive_form_option_schema),
    (
        "InteractiveFormQuestionItem",
        interactive_form_question_schema,
    ),
];

static INTERACTIVE_FORM_PARAMS: &[Param] = &[Param {
    name: "questions",
    kind: ParamKind::ListOfModel("InteractiveFormQuestionItem"),
    description: "List of questions to render in the form. Use a single item for a single-question form. Each question is an object with fields: 'id', 'question', 'input_type', 'options', 'multi_select', 'required', 'default', and 'placeholder'. 'input_type' accepts text aliases (text, textarea, long_text, short_text, string, input, free_text), single-choice aliases (choice, single_select, select, dropdown, radio, radio_group, enum, option), and multi-choice aliases (multi_select, multiple_select, multiselect, multi_choice, multiple_choice, checkbox, checkboxes, checkbox_group). For choice questions, 'options' should be a list of {label, value, recommended?} objects.",
    required: true,
    default: None,
}];

/// `interactive_form_question_mcp_server`'s registered tools.
pub(super) static INTERACTIVE_FORM_TOOLS: &[Tool] = &[Tool {
    name: "interactive_form_question",
    description: "Ask the user one or more questions and display an interactive form. Pass all questions via the 'questions' array. A single-question form is represented by one item in that array. IMPORTANT: Calling this tool only renders the form UI - it does NOT collect the answer. After calling this tool you MUST immediately end the current conversation turn and wait for the user to submit their answer as a new message. Do NOT continue processing or call any other tools after this one.",
    params: INTERACTIVE_FORM_PARAMS,
    defs: &FORM_DEFS_LIST,
    generated_docstring: true,
}];
