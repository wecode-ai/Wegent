// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

pub(crate) fn is_codex_tool_item_type(item_type: &str) -> bool {
    matches!(
        item_type,
        "commandexecution"
            | "autoapprovalreview"
            | "shellcall"
            | "localshellcall"
            | "functioncall"
            | "customtoolcall"
            | "dynamictoolcall"
            | "mcptoolcall"
            | "mcpcall"
            | "toolsearchcall"
            | "websearchcall"
            | "websearch"
            | "imagegeneration"
            | "imageview"
            | "sleep"
    )
}

pub(crate) fn is_codex_tool_output_item_type(item_type: &str) -> bool {
    matches!(
        item_type,
        "functioncalloutput" | "customtoolcalloutput" | "toolsearchoutput" | "execcommandend"
    )
}

pub(crate) fn is_likely_codex_tool_item_type(item_type: &str) -> bool {
    is_codex_tool_item_type(item_type)
        || is_codex_tool_output_item_type(item_type)
        || item_type.contains("tool")
        || item_type.contains("command")
        || item_type.contains("exec")
        || item_type.contains("mcp")
        || item_type.contains("function")
}

pub(crate) fn is_likely_codex_tool_output_item_type(item_type: &str) -> bool {
    is_codex_tool_output_item_type(item_type)
        || (is_likely_codex_tool_item_type(item_type)
            && (item_type.ends_with("end")
                || item_type.ends_with("output")
                || item_type.ends_with("result")
                || item_type.contains("complete")))
}

pub(crate) fn is_codex_context_compaction_item_type(item_type: &str) -> bool {
    matches!(item_type, "contextcompaction" | "contextcompacted")
}

/// Whether an item makes preceding unphased assistant text a progress message.
pub(crate) fn is_substantive_process_item_type(item_type: &str) -> bool {
    is_likely_codex_tool_item_type(item_type)
        || matches!(
            item_type,
            "reasoning" | "plan" | "filechange" | "patchapplyend"
        )
        || is_codex_context_compaction_item_type(item_type)
}
