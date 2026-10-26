// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! MCP tool-surface modeling shared by the Wegent MCP servers.
//!
//! The source registers each server's tools through the `@mcp_tool` decorator
//! (`app/mcp_server/tools/decorator.py`), which stores a parameter definition
//! list, and then through `register_tools_to_server`
//! (`app/mcp_server/tool_registry.py`), which rewrites the wrapper signature
//! and docstring before handing it to FastMCP. `tools/list` therefore has two
//! source-generated surfaces:
//!
//! - the description, produced by `generate_tool_docstring`
//!   (`app/mcp_server/schema_extractor.py`) from the decorator's parameter
//!   definitions;
//! - the `inputSchema`, produced by FastMCP from the rewritten signature
//!   through pydantic's `model_json_schema` (title-cased property titles,
//!   `anyOf` plus `default: null` for optional parameters), and the
//!   `outputSchema`, produced from the `-> str` return annotation.
//!
//! This module renders both surfaces from one tool definition so a tool's
//! name, parameters, defaults, and descriptions stay the single source of
//! truth for the protocol replies and for `tools/call` argument handling.

use serde_json::{Map, Value, json};

/// One parameter as the `@mcp_tool` decorator describes it.
pub(crate) struct Param {
    pub(crate) name: &'static str,
    /// The JSON type name used in the generated docstring (`_python_type_to_json_schema`
    /// `type`).
    pub(crate) kind: ParamKind,
    /// The decorator's `param_descriptions` entry; empty when absent.
    pub(crate) description: &'static str,
    /// `required` is `not has_default`.
    pub(crate) required: bool,
    /// The decorator's stored `default`, omitted for `None` defaults
    /// (`if has_default and param.default is not None`). A `Some(Null)` value
    /// cannot occur; optional parameters without a concrete default store
    /// `None` here while FastMCP's schema still renders `"default": null`.
    pub(crate) default: Option<Literal>,
}

/// The parameter's signature annotation, which decides both the docstring
/// type name and the schema member FastMCP emits for it.
#[derive(Clone, Copy)]
pub(crate) enum ParamKind {
    Str,
    Int,
    Bool,
    /// `list[int]`
    ListOfInt,
    /// A pydantic model annotation (`python_type` in the decorator entry).
    Model(&'static str),
    /// `list[<pydantic model>]`.
    ListOfModel(&'static str),
    /// `dict[str, Any]`, which pydantic renders with
    /// `additionalProperties: true`.
    Object,
}

impl ParamKind {
    /// `_python_type_to_json_schema`'s `type` value for the docstring.
    fn docstring_type(self) -> &'static str {
        match self {
            Self::Str => "string",
            Self::Int => "integer",
            Self::Bool => "boolean",
            Self::ListOfInt | Self::ListOfModel(_) => "array",
            Self::Model(_) | Self::Object => "object",
        }
    }

    /// The JSON schema FastMCP emits for the non-null member.
    fn schema(self) -> Value {
        match self {
            Self::Str => json!({ "type": "string" }),
            Self::Int => json!({ "type": "integer" }),
            Self::Bool => json!({ "type": "boolean" }),
            // pydantic emits `items` before `type` for array members.
            Self::ListOfInt => json!({ "items": { "type": "integer" }, "type": "array" }),
            Self::ListOfModel(name) => {
                json!({ "items": { "$ref": format!("#/$defs/{name}") }, "type": "array" })
            }
            Self::Model(name) => json!({ "$ref": format!("#/$defs/{name}") }),
            Self::Object => json!({ "additionalProperties": true, "type": "object" }),
        }
    }
}

/// A parameter default stored by the decorator (`param_def["default"]`).
#[derive(Clone, Copy)]
pub(crate) enum Literal {
    Bool(bool),
    Int(i64),
    Str(&'static str),
}

impl Literal {
    /// `str(default)` as used by the generated docstring.
    fn docstring(self) -> String {
        match self {
            Self::Bool(value) => (if value { "True" } else { "False" }).to_string(),
            Self::Int(value) => value.to_string(),
            Self::Str(value) => value.to_string(),
        }
    }

    fn json(self) -> Value {
        match self {
            Self::Bool(value) => json!(value),
            Self::Int(value) => json!(value),
            Self::Str(value) => json!(value),
        }
    }
}

/// One `$defs` schema builder: `(definition name, schema constructor)`.
pub(crate) type DefBuilder = (&'static str, fn() -> Value);

/// One registered MCP tool.
pub(crate) struct Tool {
    pub(crate) name: &'static str,
    /// The decorator `description` argument (not the generated docstring).
    pub(crate) description: &'static str,
    pub(crate) params: &'static [Param],
    /// `$defs` referenced by [`ParamKind::Model`] annotations, in schema order.
    pub(crate) defs: &'static [DefBuilder],
    /// Whether the description is the generated `@mcp_tool` docstring. A tool
    /// registered directly with `FastMCP.tool()` publishes its own docstring
    /// verbatim instead (`app/mcp_server/tools/knowledge_external.py`).
    pub(crate) generated_docstring: bool,
}

impl Tool {
    /// The docstring `register_tools_to_server` attaches before FastMCP reads
    /// it: `generate_tool_docstring` with the default `{"type": "object"}`
    /// response schema.
    pub(crate) fn docstring(&self) -> String {
        if !self.generated_docstring {
            return self.description.to_string();
        }
        let mut lines = vec![
            format!("Tool: {}", self.name),
            String::new(),
            self.description.to_string(),
            String::new(),
        ];
        if !self.params.is_empty() {
            lines.push("Args:".to_string());
            for param in self.params {
                let mut line = format!(
                    "    {} ({}, {})",
                    param.name,
                    param.kind.docstring_type(),
                    if param.required {
                        "required"
                    } else {
                        "optional"
                    }
                );
                if let Some(default) = param.default {
                    line.push_str(&format!(" [default: {}]", default.docstring()));
                }
                if !param.description.is_empty() {
                    line.push_str(&format!(": {}", param.description));
                }
                lines.push(line);
            }
            lines.push(String::new());
        }
        lines.push("Returns:".to_string());
        lines.push("    JSON string with the following structure:".to_string());
        lines.join("\n")
    }

    /// The `inputSchema` FastMCP publishes for the rewritten wrapper
    /// signature.
    pub(crate) fn input_schema(&self) -> Value {
        let mut properties = Map::new();
        let mut required = Vec::new();
        for param in self.params {
            if param.required {
                required.push(Value::String(param.name.to_string()));
                let mut property = match param.kind.schema() {
                    Value::Object(map) => map,
                    other => panic!("schema member must be an object: {other}"),
                };
                property.insert("title".to_string(), json!(title_case(param.name)));
                properties.insert(param.name.to_string(), sorted_value(property));
                continue;
            }
            let mut property = match (param.default, param.kind) {
                // A concrete default keeps the plain annotation
                // (`limit: int = 50`).
                (Some(_), _) => match param.kind.schema() {
                    Value::Object(map) => map,
                    other => panic!("schema member must be an object: {other}"),
                },
                // `Optional[T] = None` renders `anyOf [T, null]`.
                (None, kind) => {
                    let mut map = Map::new();
                    map.insert(
                        "anyOf".to_string(),
                        json!([kind.schema(), { "type": "null" }]),
                    );
                    map.insert("default".to_string(), Value::Null);
                    map
                }
            };
            if let Some(default) = param.default {
                property.insert("default".to_string(), default.json());
            }
            // A pydantic model annotation loses the per-parameter title
            // because FastMCP receives the model type directly.
            if !matches!(param.kind, ParamKind::Model(_)) {
                property.insert("title".to_string(), json!(title_case(param.name)));
            }
            properties.insert(param.name.to_string(), sorted_value(property));
        }
        let mut schema = Map::new();
        if !self.defs.is_empty() {
            let mut defs = Map::new();
            for (name, build) in self.defs {
                defs.insert((*name).to_string(), build());
            }
            schema.insert("$defs".to_string(), Value::Object(defs));
        }
        schema.insert("properties".to_string(), Value::Object(properties));
        if !required.is_empty() {
            schema.insert("required".to_string(), Value::Array(required));
        }
        schema.insert(
            "title".to_string(),
            json!(format!("{}Arguments", self.name)),
        );
        schema.insert("type".to_string(), json!("object"));
        Value::Object(schema)
    }

    /// The `outputSchema` FastMCP derives from the `-> str` return
    /// annotation.
    fn output_schema(&self) -> Value {
        json!({
            "properties": { "result": { "title": "Result", "type": "string" } },
            "required": ["result"],
            "title": format!("{}Output", self.name),
            "type": "object",
        })
    }

    /// The `tools/list` entry (`mcp.types.Tool` with `exclude_none=True`).
    pub(crate) fn listing(&self) -> Value {
        json!({
            "name": self.name,
            "description": self.docstring(),
            "inputSchema": self.input_schema(),
            "outputSchema": self.output_schema(),
        })
    }
}

/// pydantic renders schema mappings with alphabetically ordered keys; sort a
/// freshly built member the same way so byte-compatible replies stay stable.
fn sorted_map(map: Map<String, Value>) -> Map<String, Value> {
    let mut entries: Vec<(String, Value)> = map.into_iter().collect();
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    entries.into_iter().collect()
}

fn sorted_value(map: Map<String, Value>) -> Value {
    Value::Object(sorted_map(map))
}

/// `pydantic`'s field title: split on underscores and capitalize each word
/// (`knowledge_base_id` -> `Knowledge Base Id`).
fn title_case(name: &str) -> String {
    name.split('_')
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().chain(chars).collect::<String>(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The successful `CallToolResult` for a tool that returns a JSON string:
/// `content`, `structuredContent`, and `isError`.
///
/// FastMCP wraps a `str` tool result in one `TextContent` item and mirrors the
/// same payload in `structuredContent` as `{"result": <text>}`
/// (`FastMCP.call_tool`).
pub(crate) fn text_result(text: String) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": { "result": text },
        "isError": false,
    })
}

/// `tools/list` result body.
pub(crate) fn tool_listing(tools: &[Tool]) -> Value {
    json!({ "tools": tools.iter().map(Tool::listing).collect::<Vec<_>>() })
}

#[cfg(test)]
mod tests {
    use super::*;

    static PARAMS: &[Param] = &[
        Param {
            name: "name",
            kind: ParamKind::Str,
            description: "Name text",
            required: true,
            default: None,
        },
        Param {
            name: "limit",
            kind: ParamKind::Int,
            description: "Maximum count",
            required: false,
            default: Some(Literal::Int(10)),
        },
        Param {
            name: "flag",
            kind: ParamKind::Bool,
            description: "",
            required: false,
            default: None,
        },
    ];

    static TOOL: Tool = Tool {
        name: "example_tool",
        description: "Example description.",
        params: PARAMS,
        defs: &[],
        generated_docstring: true,
    };

    #[test]
    fn docstring_matches_the_source_template() {
        assert_eq!(
            TOOL.docstring(),
            "Tool: example_tool\n\nExample description.\n\nArgs:\n    \
             name (string, required): Name text\n    \
             limit (integer, optional) [default: 10]: Maximum count\n    \
             flag (boolean, optional)\n\n\
             Returns:\n    JSON string with the following structure:"
        );
    }

    #[test]
    fn schema_keeps_required_and_optional_shapes() {
        let schema = TOOL.input_schema();
        assert_eq!(
            schema["properties"]["name"],
            json!({ "title": "Name", "type": "string" })
        );
        assert_eq!(
            schema["properties"]["limit"],
            json!({ "default": 10, "title": "Limit", "type": "integer" })
        );
        assert_eq!(
            schema["properties"]["flag"],
            json!({
                "anyOf": [{ "type": "boolean" }, { "type": "null" }],
                "default": null,
                "title": "Flag"
            })
        );
        assert_eq!(schema["required"], json!(["name"]));
        assert_eq!(schema["title"], "example_toolArguments");
        assert_eq!(schema["type"], "object");
    }

    #[test]
    fn listing_carries_name_description_and_schemas() {
        let listing = TOOL.listing();
        assert_eq!(listing["name"], "example_tool");
        assert_eq!(listing["description"], TOOL.docstring());
        assert_eq!(
            listing["outputSchema"],
            json!({
                "properties": { "result": { "title": "Result", "type": "string" } },
                "required": ["result"],
                "title": "example_toolOutput",
                "type": "object"
            })
        );
    }

    #[test]
    fn text_result_mirrors_the_payload() {
        assert_eq!(
            text_result("{\"a\": 1}".to_string()),
            json!({
                "content": [{ "type": "text", "text": "{\"a\": 1}" }],
                "structuredContent": { "result": "{\"a\": 1}" },
                "isError": false
            })
        );
    }

    #[test]
    fn title_case_splits_snake_case_words() {
        assert_eq!(title_case("knowledge_base_id"), "Knowledge Base Id");
        assert_eq!(title_case("url"), "Url");
        assert_eq!(title_case("file_base64"), "File Base64");
    }
}
