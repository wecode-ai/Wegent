# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge base meta prompt formatter (Backend-only).

This module formats the knowledge base metadata prompt that is injected via Chat Shell's
`dynamic_context` mechanism as a **human message** (not system prompt).

Design goals:
- Keep this module PURE: it MUST NOT query the database.
- Callers (e.g. chat preprocessing) should assemble the KB meta list based on the
  current request's resolved KB IDs and priority rules, then call `format_kb_meta_prompt`.

All comments must be written in English.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Threshold above which short summaries are preferred over long summaries to
# reduce token usage when many KBs are included in the meta prompt.
SHORT_SUMMARY_THRESHOLD = 3
SAFE_IDENTIFIER_MAX_LEN = 120
SAFE_ROUTING_HINT_MAX_LEN = 200
SAFE_ROUTING_TOPIC_MAX_LEN = 48
MAX_ROUTING_TOPICS = 5
UNSAFE_IDENTIFIER_TRANSLATION = str.maketrans({char: " " for char in "{}[]<>`%"})


def sanitize_prompt_text(value: Any, fallback: str = "", max_len: int = 120) -> str:
    """Sanitize prompt text before formatting."""
    text = str(value).translate(UNSAFE_IDENTIFIER_TRANSLATION)
    text = "".join(
        ch if ch.isprintable() and ch not in "\r\n\t" else " " for ch in text
    )
    text = " ".join(text.split())
    if not text:
        return fallback
    return text[:max_len].rstrip()


def sanitize_prompt_identifier(value: Any, fallback: str) -> str:
    """Sanitize minimal prompt identifiers before formatting."""
    return sanitize_prompt_text(
        value, fallback=fallback, max_len=SAFE_IDENTIFIER_MAX_LEN
    )


def select_kb_summary_text(summary_data: dict[str, Any], kb_count: int) -> str:
    """Select summary text based on KB count.

    - For 1-2 KBs: prefer long_summary.
    - For 3+ KBs: prefer short_summary to save tokens.

    Args:
        summary_data: The `spec.summary` object from a KnowledgeBase Kind.
        kb_count: Total KB count in the current meta list.

    Returns:
        Summary text or empty string.
    """

    use_short = kb_count >= SHORT_SUMMARY_THRESHOLD

    if use_short:
        summary_text = summary_data.get("short_summary") or summary_data.get(
            "long_summary"
        )
    else:
        summary_text = summary_data.get("long_summary") or summary_data.get(
            "short_summary"
        )

    return summary_text or ""


def _format_duckdb_schema_section(duckdb_files: list[dict] | None) -> str:
    """Format DuckDB schema section appended to the KB meta prompt.

    This section tells the Agent *what* data is available (schema, row count,
    label distribution, filter suggestions). The query instructions (how to
    connect and run SQL) are injected separately via prompt_enrichment.

    Args:
        duckdb_files: List of duckdb file metadata dicts, each containing
            doc_id, kb_id, table_name, embedding_model, embedding_dim,
            schema_description (optional), row_count (optional),
            label_column (optional), label_distribution (optional).

    Returns:
        Formatted schema section string, or empty string if no DuckDB files.
    """
    if not duckdb_files:
        return ""

    lines: list[str] = ["\n\nDuckDB Schema Information:"]

    # Group files by kb_id for cleaner output
    kb_files: dict[int, list[dict]] = {}
    for f in duckdb_files:
        kb_id = int(f.get("kb_id", 0))
        kb_files.setdefault(kb_id, []).append(f)

    for kb_id, files in kb_files.items():
        if len(files) == 1:
            f = files[0]
            lines.append(f"- DuckDB (KB ID: {kb_id}, doc_id: {f.get('doc_id')}):")
            _append_duckdb_file_details(lines, f, indent="  ")
        else:
            lines.append(f"- DuckDB files (KB ID: {kb_id}):")
            for idx, f in enumerate(files, 1):
                lines.append(f"  - File {idx} (doc_id: {f.get('doc_id')}):")
                _append_duckdb_file_details(lines, f, indent="    ")

    return "\n".join(lines)


def _append_duckdb_file_details(lines: list[str], f: dict, indent: str = "  ") -> None:
    """Append per-file DuckDB detail lines to the lines list.

    Args:
        lines: Output list to append to.
        f: Single duckdb file metadata dict.
        indent: Indentation prefix string.
    """
    table_name = f.get("table_name", "raw_data")
    row_count = f.get("row_count")
    schema_description = f.get("schema_description", "")
    embedding_model = f.get("embedding_model", "")
    embedding_dim = f.get("embedding_dim", 0)
    label_column = f.get("label_column", "")
    label_distribution = f.get("label_distribution", "")

    row_info = f" ({row_count:,} rows)" if row_count else ""
    lines.append(f"{indent}- Table: {table_name}{row_info}")

    if schema_description:
        lines.append(f"{indent}- Schema: {schema_description}")

    if label_column:
        dist_note = f": {label_distribution}" if label_distribution else ""
        lines.append(f"{indent}- Filter column: {label_column}{dist_note}")
        lines.append(
            f"{indent}- Suggestion: filter by {label_column} before semantic search"
            " to reduce noise"
        )

    if embedding_model and embedding_dim:
        lines.append(f"{indent}- Embedding: {embedding_model} {embedding_dim}d")


def format_kb_meta_prompt(
    kb_meta_list: list[dict[str, Any]],
    duckdb_files: list[dict] | None = None,
) -> str:
    """Format KB meta list into a dynamic_context prompt string.

    Expected item keys:
    - kb_id: int | str
    - kb_name: str
    - summary_text: optional str
    - topics: optional list[str]

    Args:
        kb_meta_list: Pre-assembled KB meta list.
        duckdb_files: Optional list of DuckDB file metadata dicts. Each entry should
            contain: doc_id, kb_id, table_name, embedding_model, embedding_dim,
            schema_description (optional), row_count (optional),
            label_column (optional), label_distribution (optional).

    Returns:
        A single string for dynamic_context injection, or empty string.
    """

    if not kb_meta_list:
        return ""

    kb_lines: list[str] = []

    for kb_meta in kb_meta_list:
        kb_name = sanitize_prompt_identifier(
            kb_meta.get("kb_name", "Unknown"), "Unknown"
        )
        kb_id = sanitize_prompt_identifier(kb_meta.get("kb_id", "N/A"), "N/A")
        search_available = (
            "available" if kb_meta.get("search_available") else "unavailable"
        )
        total_document_count = int(kb_meta.get("total_document_count", 0) or 0)
        searchable_document_count = int(
            kb_meta.get("searchable_document_count", 0) or 0
        )
        spreadsheet_document_count = int(
            kb_meta.get("spreadsheet_document_count", 0) or 0
        )

        kb_lines.append(
            f"- KB Name: {kb_name}, KB ID: {kb_id}, "
            f"Search: {search_available}, "
            f"Total Docs: {total_document_count}, "
            f"Searchable Docs: {searchable_document_count}, "
            f"Spreadsheets: {spreadsheet_document_count}"
        )

        summary_text = kb_meta.get("summary_text") or ""
        topics = kb_meta.get("topics") or []

        if summary_text:
            kb_lines.append(f"  - Summary: {summary_text}")
        if topics:
            kb_lines.append(f"  - Topics: {', '.join(topics)}")

    kb_list_str = "\n".join(kb_lines)

    target_kb_note = ""
    if len(kb_meta_list) == 1:
        selected_kb = kb_meta_list[0]
        kb_name = sanitize_prompt_identifier(
            selected_kb.get("kb_name", "Unknown"), "Unknown"
        )
        kb_id = sanitize_prompt_identifier(selected_kb.get("kb_id", "N/A"), "N/A")
        target_kb_note = (
            "\nCurrent Target KB:\n" f"- KB Name: {kb_name}\n" f"- KB ID: {kb_id}\n"
        )

    return (
        "Knowledge Bases In Scope:\n"
        f"{kb_list_str}\n"
        f"{target_kb_note}\n"
        "Note:\n"
        "- This block is request-scoped metadata only.\n"
        "- Use KB tools to retrieve actual content when needed."
    ) + _format_duckdb_schema_section(duckdb_files)


def format_restricted_kb_meta_prompt(kb_meta_list: list[dict[str, Any]]) -> str:
    """Format a restricted KB meta prompt with safe routing hints."""

    if not kb_meta_list:
        return ""

    kb_lines: list[str] = []
    for kb_meta in kb_meta_list:
        kb_name = sanitize_prompt_identifier(
            kb_meta.get("kb_name", "Unknown"), "Unknown"
        )
        kb_id = sanitize_prompt_identifier(kb_meta.get("kb_id", "N/A"), "N/A")
        kb_lines.append(f"- KB Name: {kb_name}, KB ID: {kb_id}")

        summary_text = sanitize_prompt_text(
            kb_meta.get("summary_text") or "",
            max_len=SAFE_ROUTING_HINT_MAX_LEN,
        )
        topics = [
            sanitize_prompt_text(topic, max_len=SAFE_ROUTING_TOPIC_MAX_LEN)
            for topic in (kb_meta.get("topics") or [])[:MAX_ROUTING_TOPICS]
        ]
        topics = [topic for topic in topics if topic]

        if summary_text:
            kb_lines.append(f"  - Routing Hint: {summary_text}")
        if topics:
            kb_lines.append(f"  - Routing Keywords: {', '.join(topics)}")

    kb_list_str = "\n".join(kb_lines)

    return (
        "Restricted Knowledge Bases In Scope:\n"
        f"{kb_list_str}\n\n"
        "Note:\n"
        "- These routing hints are for retrieval guidance only.\n"
        "- Do not use them as final answer content."
    )
