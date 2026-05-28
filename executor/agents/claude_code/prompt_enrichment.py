# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Prompt enrichment helpers for Claude Code requests."""

from typing import Any, Union

from executor.agents.claude_code.multimodal_prompt import append_text_to_vision_prompt

PromptType = Union[str, list[dict[str, Any]]]


def inject_kb_meta_prompt(
    prompt: PromptType,
    kb_meta_prompt: str,
    *,
    executor_mode: str,
    is_user_selected_kb: bool,
) -> PromptType:
    """Prepend KB metadata context for local executor requests only."""
    if executor_mode != "local" or not kb_meta_prompt:
        return prompt

    kb_priority = ""
    if is_user_selected_kb:
        kb_priority = (
            "<knowledge_base_priority>\n"
            "Use the selected knowledge base first for this request.\n"
            "- Use selected knowledge base tools and skills before web search or external lookup.\n"
            "- When you need to identify which document matters, call `wegent_kb_list_documents` first.\n"
            "- When you need the content of a specific knowledge base document, call\n"
            "  `wegent_kb_read_document_content` with `document_id` and optional `offset`/`limit`.\n"
            "- Pass `knowledge_base_id` when calling `wegent_kb_list_documents`.\n"
            "- Do not construct MCP resource URIs manually.\n"
            "- Use web search only if the user explicitly asks for external or current web information,\n"
            "  or if knowledge base retrieval cannot answer the request.\n"
            "</knowledge_base_priority>\n"
        )

    kb_context = (
        f"{kb_priority}<knowledge_base_context>\n"
        f"{kb_meta_prompt}\n"
        "</knowledge_base_context>"
    )
    if isinstance(prompt, list):
        return append_text_to_vision_prompt(prompt, kb_context, prepend=True)
    return f"{kb_context}\n\n{prompt}"


def inject_duckdb_instructions(
    prompt: PromptType,
    duckdb_local_files: list[dict[str, Any]],
) -> PromptType:
    """Append DuckDB query instructions with local file paths to the prompt.

    This function tells the Agent *how* to query DuckDB files. It is complementary
    to the schema information already injected via kb_meta_prompt (which tells the
    Agent *what* data is available).

    The instructions include:
    - Local paths to downloaded .duckdb files
    - Python connection pattern (duckdb + VSS extension)
    - How to use fastembed for local embedding generation
    - Reference to schema info already in kb_meta_prompt

    Args:
        prompt: Current prompt (string or vision content list).
        duckdb_local_files: List of duckdb file info dicts, each with at least
            'local_path', 'doc_id', 'kb_id', 'table_name', 'embedding_model',
            'embedding_dim'.

    Returns:
        Prompt with DuckDB instructions appended.
    """
    if not duckdb_local_files:
        return prompt

    # Build file listing
    file_lines = []
    for f in duckdb_local_files:
        local_path = f.get("local_path", "")
        kb_id = f.get("kb_id", "?")
        doc_id = f.get("doc_id", "?")
        table_name = f.get("table_name", "raw_data")
        embedding_dim = f.get("embedding_dim", 0)
        row_count = f.get("row_count")
        row_info = f" ({row_count:,} rows)" if row_count else ""
        file_lines.append(
            f"- {local_path} (KB ID: {kb_id}, doc_id: {doc_id}, "
            f"table: {table_name}{row_info}, embedding_dim: {embedding_dim})"
        )
    files_str = "\n".join(file_lines)

    # Use the first file's embedding config as representative
    first = duckdb_local_files[0]
    sample_path = first.get("local_path", "/tmp/kb_doc.duckdb")
    embedding_dim = first.get("embedding_dim", 512)

    instructions = (
        "\n<knowledge_base_duckdb>\n"
        "DuckDB files are pre-downloaded. Use the Python `duckdb` library to query them.\n"
        "\n"
        "Available files:\n"
        f"{files_str}\n"
        "\n"
        "Query pattern:\n"
        "```python\n"
        "import duckdb\n"
        f"con = duckdb.connect('{sample_path}', read_only=True)\n"
        'con.execute("INSTALL vss"); con.execute("LOAD vss")\n'
        "\n"
        "# Pure SQL query:\n"
        'result = con.execute("SELECT * FROM raw_data WHERE ... LIMIT 10").fetchdf()\n'
        "\n"
        "# Semantic (vector) search — generate embedding locally:\n"
        "from fastembed import TextEmbedding\n"
        'embed_model = TextEmbedding("BAAI/bge-small-zh-v1.5")\n'
        'emb = list(embed_model.embed(["<your query text>"]))[0].tolist()\n'
        'result = con.execute(f"""\n'
        "    SELECT *, array_cosine_similarity(embedding, {{emb}}::FLOAT"
        f"[{embedding_dim}])"
        " AS score\n"
        "    FROM raw_data\n"
        "    WHERE embedding IS NOT NULL\n"
        "    ORDER BY score DESC LIMIT 10\n"
        '""").fetchdf()\n'
        "```\n"
        "\n"
        "Refer to the DuckDB Schema Information in the knowledge_base_context above\n"
        "for column names, row counts, and filter suggestions.\n"
        "</knowledge_base_duckdb>"
    )

    if isinstance(prompt, list):
        return append_text_to_vision_prompt(prompt, instructions, prepend=False)
    return prompt + instructions
