// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `tools/list` and `tools/call` for the Wegent knowledge MCP server
//! (`app/mcp_server/tools/knowledge.py`).
//!
//! Every tool is declared with `@mcp_tool`, so the listing's description and
//! input schema come from the decorator's parameter metadata (see
//! [`super::tools`]). The calls mirror the source tool bodies: a token-less
//! invocation returns the wrapper's `{"error": "Authentication required"}`
//! payload, `read_document_content` resolves the effective reader through
//! `KnowledgeService.resolve_read_user_for_knowledge_base` and then runs
//! `KnowledgeOrchestrator.read_document_content`, and a `ValueError` from the
//! orchestrator is returned as `{"error": <message>}`.
//!
//! Tools whose service layer is not yet migrated are not advertised as
//! callable: `tools/call` answers them with the protocol's `Unknown tool`
//! error instead of inventing a result.

use serde_json::{Value, json};

use crate::knowledge_documents_content::access;
use crate::knowledge_documents_content::read_document_content;
use crate::state::AppState;
use crate::task_token;

use super::protocol;
use super::tools::{Literal, Param, ParamKind, Tool};

/// `DEFAULT_KNOWLEDGE_LIST_LIMIT` (`app.services.knowledge.orchestrator`).
const DEFAULT_KNOWLEDGE_LIST_LIMIT: i64 = 50;
/// `MAX_DOCUMENT_READ_LIMIT` (`app.services.knowledge.orchestrator`).
const MAX_DOCUMENT_READ_LIMIT: i64 = 100_000;

static SEARCH_PARAMS: &[Param] = &[
    Param {
        name: "knowledge_base_id",
        kind: ParamKind::Int,
        description: "Knowledge base ID to search",
        required: true,
        default: None,
    },
    Param {
        name: "query",
        kind: ParamKind::Str,
        description: "Search query text",
        required: true,
        default: None,
    },
    Param {
        name: "search_hints",
        kind: ParamKind::Model("SearchHints"),
        description: "Optional query plan. Allowed fields only: semantic_query (string), keywords (string array), and phrases (string array of exact multi-word matches).",
        required: false,
        default: None,
    },
    Param {
        name: "max_results",
        kind: ParamKind::Int,
        description: "Maximum number of results to return (default: 10, max: 50)",
        required: false,
        default: Some(Literal::Int(10)),
    },
    Param {
        name: "document_ids",
        kind: ParamKind::ListOfInt,
        description: "Optional list of document IDs to restrict search scope",
        required: false,
        default: None,
    },
    Param {
        name: "folder_ids",
        kind: ParamKind::ListOfInt,
        description: "Optional list of folder IDs to restrict search scope",
        required: false,
        default: None,
    },
    Param {
        name: "include_subfolders",
        kind: ParamKind::Bool,
        description: "Whether folder_ids include descendant folders",
        required: false,
        default: Some(Literal::Bool(true)),
    },
];

static LIST_KNOWLEDGE_BASE_PARAMS: &[Param] = &[
    Param {
        name: "scope",
        kind: ParamKind::Str,
        description: "Resource scope - 'all', 'personal', or 'group'",
        required: false,
        default: Some(Literal::Str("all")),
    },
    Param {
        name: "group_name",
        kind: ParamKind::Str,
        description: "Group name (required when scope='group')",
        required: false,
        default: None,
    },
    Param {
        name: "limit",
        kind: ParamKind::Int,
        description: "Maximum number of knowledge bases to return",
        required: false,
        default: Some(Literal::Int(DEFAULT_KNOWLEDGE_LIST_LIMIT)),
    },
    Param {
        name: "offset",
        kind: ParamKind::Int,
        description: "Start offset for paginated listing",
        required: false,
        default: Some(Literal::Int(0)),
    },
];

static LIST_DOCUMENT_PARAMS: &[Param] = &[
    Param {
        name: "knowledge_base_id",
        kind: ParamKind::Int,
        description: "Knowledge base ID to list documents from",
        required: true,
        default: None,
    },
    Param {
        name: "folder_id",
        kind: ParamKind::Int,
        description: "Optional folder ID to filter documents by (0 or omit for root/all documents)",
        required: false,
        default: None,
    },
    Param {
        name: "include_subfolders",
        kind: ParamKind::Bool,
        description: "Whether folder_id includes descendant folders (default: true)",
        required: false,
        default: Some(Literal::Bool(true)),
    },
    Param {
        name: "keyword",
        kind: ParamKind::Str,
        description: "Optional keyword to search document names",
        required: false,
        default: None,
    },
    Param {
        name: "sort_by",
        kind: ParamKind::Str,
        description: "Sort field: name, size, createdAt, or updatedAt",
        required: false,
        default: Some(Literal::Str("createdAt")),
    },
    Param {
        name: "sort_order",
        kind: ParamKind::Str,
        description: "Sort order: asc or desc",
        required: false,
        default: Some(Literal::Str("desc")),
    },
    Param {
        name: "limit",
        kind: ParamKind::Int,
        description: "Maximum number of documents to return",
        required: false,
        default: Some(Literal::Int(DEFAULT_KNOWLEDGE_LIST_LIMIT)),
    },
    Param {
        name: "offset",
        kind: ParamKind::Int,
        description: "Start offset for paginated listing",
        required: false,
        default: Some(Literal::Int(0)),
    },
];

static CREATE_KNOWLEDGE_BASE_PARAMS: &[Param] = &[
    Param {
        name: "name",
        kind: ParamKind::Str,
        description: "Knowledge base name",
        required: true,
        default: None,
    },
    Param {
        name: "description",
        kind: ParamKind::Str,
        description: "Optional description for the knowledge base",
        required: false,
        default: None,
    },
    Param {
        name: "namespace",
        kind: ParamKind::Str,
        description: "Namespace ('default' for personal, group name for group)",
        required: false,
        default: Some(Literal::Str("default")),
    },
    Param {
        name: "kb_type",
        kind: ParamKind::Str,
        description: "Type of knowledge base ('notebook' or 'classic')",
        required: false,
        default: Some(Literal::Str("notebook")),
    },
    Param {
        name: "summary_enabled",
        kind: ParamKind::Bool,
        description: "Whether to enable summary generation",
        required: false,
        default: Some(Literal::Bool(true)),
    },
];

static CREATE_DOCUMENT_PARAMS: &[Param] = &[
    Param {
        name: "knowledge_base_id",
        kind: ParamKind::Int,
        description: "Target knowledge base ID",
        required: true,
        default: None,
    },
    Param {
        name: "name",
        kind: ParamKind::Str,
        description: "Document name",
        required: true,
        default: None,
    },
    Param {
        name: "source_type",
        kind: ParamKind::Str,
        description: "Source type: 'text', 'file', 'web', or 'attachment'. Use 'attachment' for inbox messages (see contentAttachmentIds in inbox context).",
        required: true,
        default: None,
    },
    Param {
        name: "folder_id",
        kind: ParamKind::Int,
        description: "Optional folder ID to place the document in (0 or omit for root folder)",
        required: false,
        default: Some(Literal::Int(0)),
    },
    Param {
        name: "content",
        kind: ParamKind::Str,
        description: "Text content (for source_type='text'). Avoid for large content - use 'attachment' instead.",
        required: false,
        default: None,
    },
    Param {
        name: "file_base64",
        kind: ParamKind::Str,
        description: "Base64-encoded file content (for source_type='file')",
        required: false,
        default: None,
    },
    Param {
        name: "file_extension",
        kind: ParamKind::Str,
        description: "File extension like 'txt', 'md', 'pdf' (for source_type='file')",
        required: false,
        default: None,
    },
    Param {
        name: "url",
        kind: ParamKind::Str,
        description: "URL to scrape (for source_type='web')",
        required: false,
        default: None,
    },
    Param {
        name: "attachment_id",
        kind: ParamKind::Int,
        description: "Existing attachment context ID (for source_type='attachment'). For inbox messages: use a value from contentAttachmentIds in the inbox context. This is the PREFERRED method - content is read directly from storage without passing through the model output window.",
        required: false,
        default: None,
    },
    Param {
        name: "trigger_indexing",
        kind: ParamKind::Bool,
        description: "Whether to trigger RAG indexing (default: True)",
        required: false,
        default: Some(Literal::Bool(true)),
    },
    Param {
        name: "trigger_summary",
        kind: ParamKind::Bool,
        description: "Whether to trigger summary generation (default: True)",
        required: false,
        default: Some(Literal::Bool(true)),
    },
];

static READ_DOCUMENT_PARAMS: &[Param] = &[
    Param {
        name: "document_id",
        kind: ParamKind::Int,
        description: "Document ID to read",
        required: true,
        default: None,
    },
    Param {
        name: "offset",
        kind: ParamKind::Int,
        description: "Character offset to start reading from",
        required: false,
        default: Some(Literal::Int(0)),
    },
    Param {
        name: "limit",
        kind: ParamKind::Int,
        description: "Maximum number of characters to return",
        required: false,
        default: Some(Literal::Int(MAX_DOCUMENT_READ_LIMIT)),
    },
];

static DOWNLOAD_PARAMS: &[Param] = &[
    Param {
        name: "document_id",
        kind: ParamKind::Int,
        description: "Document ID to download",
        required: true,
        default: None,
    },
    Param {
        name: "disposition",
        kind: ParamKind::Str,
        description: "Download disposition: 'attachment' for saving the source file, or 'inline' for previewable files",
        required: false,
        default: Some(Literal::Str("attachment")),
    },
];

static UPDATE_DOCUMENT_PARAMS: &[Param] = &[
    Param {
        name: "document_id",
        kind: ParamKind::Int,
        description: "Document ID to update",
        required: true,
        default: None,
    },
    Param {
        name: "content",
        kind: ParamKind::Str,
        description: "New content for the document",
        required: true,
        default: None,
    },
    Param {
        name: "trigger_reindex",
        kind: ParamKind::Bool,
        description: "Whether to trigger RAG re-indexing (default: True)",
        required: false,
        default: Some(Literal::Bool(true)),
    },
];

/// `SearchHints.model_json_schema()` (`shared.knowledge_contracts.search_hints`):
/// `extra="forbid"`, a 2000-character semantic query, and at most 20 keywords
/// and 10 phrases.
fn search_hints_schema() -> Value {
    json!({
        "additionalProperties": false,
        "description": "Optional retrieval hints produced by an upstream planner or LLM.",
        "properties": {
            "semantic_query": {
                "anyOf": [{ "maxLength": 2000, "type": "string" }, { "type": "null" }],
                "default": null,
                "title": "Semantic Query",
            },
            "keywords": {
                "anyOf": [
                    { "items": { "type": "string" }, "maxItems": 20, "type": "array" },
                    { "type": "null" },
                ],
                "default": null,
                "title": "Keywords",
            },
            "phrases": {
                "anyOf": [
                    { "items": { "type": "string" }, "maxItems": 10, "type": "array" },
                    { "type": "null" },
                ],
                "default": null,
                "title": "Phrases",
            },
        },
        "title": "SearchHints",
        "type": "object",
    })
}

/// The knowledge server's registered tool surface, in decorator registration
/// order (`app/mcp_server/tools/knowledge.py`).
pub(crate) static KNOWLEDGE_TOOLS: &[Tool] = &[
    Tool {
        name: "wegent_kb_search_knowledge_base",
        description: "Search documents in a knowledge base using RAG retrieval. Returns relevant chunks with source references. The knowledge base must have a retriever configured.",
        params: SEARCH_PARAMS,
        defs: &[("SearchHints", search_hints_schema)],
        generated_docstring: true,
    },
    Tool {
        name: "wegent_kb_list_knowledge_bases",
        description: "List all knowledge bases accessible to the current user.",
        params: LIST_KNOWLEDGE_BASE_PARAMS,
        defs: &[],
        generated_docstring: true,
    },
    Tool {
        name: "wegent_kb_list_documents",
        description: "List all documents in a knowledge base, optionally filtered by folder.",
        params: LIST_DOCUMENT_PARAMS,
        defs: &[],
        generated_docstring: true,
    },
    Tool {
        name: "wegent_kb_create_knowledge_base",
        description: "Create a new knowledge base with auto-configuration for retriever, embedding, and summary model.",
        params: CREATE_KNOWLEDGE_BASE_PARAMS,
        defs: &[],
        generated_docstring: true,
    },
    Tool {
        name: "wegent_kb_create_document",
        description: "Create a document in a knowledge base. Supports text content, base64-encoded files, URL scraping, or existing attachment reference.\n\nIMPORTANT for inbox message processing: When the inbox context contains 'contentAttachmentIds', ALWAYS use source_type='attachment' with one of those IDs instead of source_type='text'. This avoids re-outputting the full content through the model output window, which is critical for large documents.\n\nExample for inbox: wegent_kb_create_document(knowledge_base_id=1, name='Article', source_type='attachment', attachment_id=<contentAttachmentIds[0]>)",
        params: CREATE_DOCUMENT_PARAMS,
        defs: &[],
        generated_docstring: true,
    },
    Tool {
        name: "wegent_kb_read_document_content",
        description: "Read document content with offset/limit pagination.",
        params: READ_DOCUMENT_PARAMS,
        defs: &[],
        generated_docstring: true,
    },
    Tool {
        name: "wegent_kb_get_document_download",
        description: "Get a short-lived original source-file download credential for an accessible knowledge document. Use it when exact spreadsheet, binary file, or full-file analysis is needed instead of RAG snippets.",
        params: DOWNLOAD_PARAMS,
        defs: &[],
        generated_docstring: true,
    },
    Tool {
        name: "wegent_kb_update_document_content",
        description: "Update document content for text documents and editable plain-text files such as code files, configs, and markup documents.",
        params: UPDATE_DOCUMENT_PARAMS,
        defs: &[],
        generated_docstring: true,
    },
];

/// The `tools/call` reply: either a JSON-RPC error or the tool result payload.
pub(crate) enum CallReply {
    Error { code: i64, message: String },
    Result(Value),
}

/// `ToolsCallRequest` handling after the transport accepted the message.
pub(crate) async fn call(
    state: &AppState,
    authorization: Option<&str>,
    params: Option<&Value>,
) -> CallReply {
    let Some(object) = params.and_then(Value::as_object) else {
        return invalid_arguments(None);
    };
    let Some(name) = object.get("name").and_then(Value::as_str) else {
        return invalid_arguments(None);
    };
    let Some(tool) = KNOWLEDGE_TOOLS.iter().find(|tool| tool.name == name) else {
        return CallReply::Error {
            code: protocol::INVALID_PARAMS,
            message: format!("Unknown tool: {name}"),
        };
    };
    let empty = serde_json::Map::new();
    let arguments = object
        .get("arguments")
        .and_then(Value::as_object)
        .unwrap_or(&empty);

    match tool.name {
        "wegent_kb_read_document_content" => {
            read_document_call(state, authorization, arguments).await
        }
        _ => CallReply::Error {
            code: protocol::INVALID_PARAMS,
            message: format!("Unknown tool: {name}"),
        },
    }
}

fn invalid_arguments(name: Option<&str>) -> CallReply {
    CallReply::Error {
        code: protocol::INVALID_PARAMS,
        message: match name {
            Some(name) => format!("Invalid arguments for tool: {name}"),
            None => "Invalid arguments".to_string(),
        },
    }
}

/// `wegent_kb_read_document_content`: resolve the effective reader, then run
/// the shared read pipeline.
async fn read_document_call(
    state: &AppState,
    authorization: Option<&str>,
    arguments: &serde_json::Map<String, Value>,
) -> CallReply {
    // `tool_wrapper`: without an authenticated identity the source returns
    // this payload as an ordinary (non-error) tool result.
    let Some(identity) = task_token::verify(&state.auth, authorization) else {
        return CallReply::Result(super::tools::text_result(json_error(
            "Authentication required",
        )));
    };
    let Some(document_id) = integer_argument(arguments, "document_id") else {
        return invalid_arguments(Some("wegent_kb_read_document_content"));
    };
    let offset = integer_argument(arguments, "offset").unwrap_or(0);
    let limit = integer_argument(arguments, "limit").unwrap_or(MAX_DOCUMENT_READ_LIMIT);

    let Some(user_id) = resolve_read_user(state, identity.user_id, document_id).await else {
        return CallReply::Result(super::tools::text_result(json_error("User not found")));
    };

    match read_document_content(state, user_id, document_id, offset, limit).await {
        Ok(result) => match serde_json::to_value(&result) {
            Ok(value) => CallReply::Result(super::tools::text_result(python_json(&value))),
            Err(error) => {
                CallReply::Result(super::tools::text_result(json_error(&error.to_string())))
            }
        },
        Err(error) => CallReply::Result(super::tools::text_result(json_error(error.detail()))),
    }
}

/// `_get_read_user_for_knowledge_base` ->
/// `KnowledgeService.resolve_read_user_for_knowledge_base`:
///
/// 1. the user row by id (`db.query(User).filter(User.id == user_id)`) —
///    absent means "no reader";
/// 2. with a task-scoped token, `can_directly_access_knowledge_base`
///    (the `kinds.is_active IS true` record plus the ACL chain) keeps the
///    same user when it grants direct access.
///
/// The task-default knowledge-base fallback for a caller without direct
/// access is not migrated; such a call is reported as "User not found" rather
/// than being granted the knowledge-base owner's identity.
async fn resolve_read_user(state: &AppState, user_id: i64, document_id: i64) -> Option<i64> {
    access::user_by_id(&state.mysql, user_id).await.ok()??;
    let knowledge_base_id = document_knowledge_base_id(state, document_id).await?;
    let kb = access::permission_kb_record(&state.mysql, knowledge_base_id)
        .await
        .ok()??;
    let granted = access::knowledge_base_access(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        &kb,
        user_id,
    )
    .await
    .ok()?;
    granted.then_some(user_id)
}

/// `db.query(KnowledgeDocument.kind_id).filter(KnowledgeDocument.id ==
/// document_id).scalar()`.
async fn document_knowledge_base_id(state: &AppState, document_id: i64) -> Option<i64> {
    #[derive(Debug, brz_mysql::FromMysqlRow)]
    struct Row {
        knowledge_documents_kind_id: i64,
    }
    let row: Option<Row> = state
        .mysql
        .fetch_optional(
            "SELECT knowledge_documents.kind_id AS knowledge_documents_kind_id \
             FROM knowledge_documents WHERE knowledge_documents.id = ?",
            (document_id,),
        )
        .await
        .ok()?;
    row.map(|row| row.knowledge_documents_kind_id)
}

fn integer_argument(arguments: &serde_json::Map<String, Value>, name: &str) -> Option<i64> {
    arguments.get(name).and_then(Value::as_i64)
}

/// `json.dumps({"error": message}, ensure_ascii=False)`.
fn json_error(message: &str) -> String {
    python_json(&json!({ "error": message }))
}

/// `json.dumps(value, ensure_ascii=False, default=str)`: the default
/// `", "` / `": "` separators with raw non-ASCII text.
pub(crate) fn python_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(true) => "true".to_string(),
        Value::Bool(false) => "false".to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => python_string(text),
        Value::Array(items) => {
            let rendered: Vec<String> = items.iter().map(python_json).collect();
            format!("[{}]", rendered.join(", "))
        }
        Value::Object(map) => {
            let rendered: Vec<String> = map
                .iter()
                .map(|(key, value)| format!("{}: {}", python_string(key), python_json(value)))
                .collect();
            format!("{{{}}}", rendered.join(", "))
        }
    }
}

/// `json.dumps` string rendering with `ensure_ascii=False`.
fn python_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            control if (control as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", control as u32));
            }
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_source_tool_is_declared() {
        let names: Vec<&str> = KNOWLEDGE_TOOLS.iter().map(|tool| tool.name).collect();
        assert_eq!(
            names,
            [
                "wegent_kb_search_knowledge_base",
                "wegent_kb_list_knowledge_bases",
                "wegent_kb_list_documents",
                "wegent_kb_create_knowledge_base",
                "wegent_kb_create_document",
                "wegent_kb_read_document_content",
                "wegent_kb_get_document_download",
                "wegent_kb_update_document_content",
            ]
        );
    }

    #[test]
    fn read_document_listing_carries_the_generated_docstring_and_schema() {
        let tool = KNOWLEDGE_TOOLS
            .iter()
            .find(|tool| tool.name == "wegent_kb_read_document_content")
            .expect("declared");
        assert_eq!(
            tool.docstring(),
            "Tool: wegent_kb_read_document_content\n\n\
             Read document content with offset/limit pagination.\n\n\
             Args:\n    \
             document_id (integer, required): Document ID to read\n    \
             offset (integer, optional) [default: 0]: Character offset to start reading from\n    \
             limit (integer, optional) [default: 100000]: Maximum number of characters to return\n\n\
             Returns:\n    JSON string with the following structure:"
        );
        let listing = tool.listing();
        assert_eq!(listing["inputSchema"]["required"], json!(["document_id"]));
        assert_eq!(
            listing["outputSchema"]["title"],
            "wegent_kb_read_document_contentOutput"
        );
    }

    #[test]
    fn search_hints_keeps_its_model_reference() {
        let tool = KNOWLEDGE_TOOLS
            .iter()
            .find(|tool| tool.name == "wegent_kb_search_knowledge_base")
            .expect("declared");
        let schema = tool.input_schema();
        assert_eq!(
            schema["properties"]["search_hints"],
            json!({
                "anyOf": [{ "$ref": "#/$defs/SearchHints" }, { "type": "null" }],
                "default": null
            })
        );
        assert_eq!(
            schema["$defs"]["SearchHints"]["additionalProperties"],
            false
        );
    }

    #[test]
    fn python_json_uses_source_separators_and_raw_text() {
        assert_eq!(
            python_json(&json!({ "document_id": 30829, "name": "文件" })),
            "{\"document_id\": 30829, \"name\": \"文件\"}"
        );
        assert_eq!(
            python_json(&json!({ "error": "未知" })),
            "{\"error\": \"未知\"}"
        );
    }
}
