# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Compile the supported metadata condition into Milvus filter expressions.

The vocabulary is the smallest one the business needs: a flat ``and`` over the
metadata keys ingestion actually writes, with ``eq`` and ``in``. Every clause
compiles against the row's JSON metadata column, so the server applies the
condition before the ``top_k`` cut instead of the adapter dropping candidates
afterwards.

The row's own identity is not filterable: ``knowledge_id`` is forced by the
adapter, and ``doc_ref`` is only accepted where the read path has no
``RetrievalScope`` to express the document scope with. A nested condition,
another combination, another operator or a key outside the whitelist fails
loudly, so an unsupported request can never be dropped or widened into a full
knowledge base read.

One condition carries no constraint in the shared flat-condition contract when
it has no key or no value; that shape is skipped rather than rejected, because
callers already send it for "no filter on this field".
"""

from __future__ import annotations

import math
from typing import Any, Dict, List

from knowledge_engine.retrieval.filters import (
    iter_valid_conditions,
    normalize_metadata_operator,
)
from knowledge_engine.storage.milvus_native import (
    DOC_REF_KEY,
    ID_FIELD,
    KNOWLEDGE_ID_KEY,
    metadata_path,
    sanitize_filter_value,
)

# The metadata keys ingestion writes onto a chunk and the business may filter
# on: the file metadata whitelist, the chunk fields every backend stores, and
# the keys written by parsing and splitting. Nothing else reaches a stored row,
# so a condition on anything else can only match nothing.
METADATA_KEY_WHITELIST = frozenset(
    {
        "source",
        "filename",
        "file_path",
        "file_name",
        "file_type",
        "file_size",
        "creation_date",
        "last_modified_date",
        "page_label",
        "page_number",
        "sheet_name",
        "source_file",
        "created_at",
        "chunk_index",
        "heading_path",
        "chunk_strategy",
        "format_enhancement",
        "parser_subtype",
        "node_role",
    }
)

# Identity and scope are owned by the adapter. A caller cannot pin the
# knowledge base or fake the row's primary key through a metadata condition.
INTERNAL_FILTER_KEYS = frozenset({ID_FIELD, KNOWLEDGE_ID_KEY})

SUPPORTED_OPERATORS = ("eq", "in")


def compile_metadata_conditions(
    metadata_condition: Dict[str, Any] | None,
    *,
    allow_document_scope: bool = False,
) -> List[str]:
    """Compile the supported flat metadata condition into Milvus filters.

    The result is composed with the mandatory scope filter by the caller, so a
    metadata condition can only narrow the knowledge base and document scope -
    never widen it.

    ``allow_document_scope`` exists for the reading paths: they take no
    separate document scope, so a ``doc_ref`` condition narrows the same query
    instead of being rejected. Retrieval keeps rejecting it, because there the
    document scope is an explicit input that a condition must not impersonate.
    """
    if not metadata_condition:
        return []

    conditions = _require_flat_conditions(metadata_condition)
    operator = _resolve_combination(metadata_condition, conditions)
    if operator != "and":
        raise ValueError(
            f"metadata_condition operator '{operator}' is not supported; "
            "only a flat 'and' is."
        )

    terms = [
        _compile_condition(condition, allow_document_scope=allow_document_scope)
        for condition in iter_valid_conditions(metadata_condition)
    ]
    if not terms:
        return []
    if len(terms) == 1:
        return terms
    return [f"({' and '.join(terms)})"]


def _resolve_combination(
    metadata_condition: Dict[str, Any], conditions: List[Dict[str, Any]]
) -> str:
    """Read the combination operator, refusing a condition without a list."""
    if not conditions and any(
        key not in {"operator", "conditions"} for key in metadata_condition
    ):
        raise ValueError(
            "metadata_condition must be a flat condition object carrying a "
            "'conditions' list."
        )
    operator = metadata_condition.get("operator")
    return "and" if operator is None else str(operator).strip().lower()


def _require_flat_conditions(
    metadata_condition: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """Return the condition list, refusing anything that nests one inside it."""
    conditions = metadata_condition.get("conditions")
    if conditions is None:
        return []
    if not isinstance(conditions, (list, tuple)):
        raise ValueError("metadata_condition 'conditions' must be a list.")
    for condition in conditions:
        if not isinstance(condition, dict):
            raise ValueError("metadata_condition conditions must be objects.")
        if "conditions" in condition:
            raise ValueError("Nested metadata conditions are not supported.")
    return list(conditions)


def _compile_condition(condition: Dict[str, Any], *, allow_document_scope: bool) -> str:
    """Compile one supported condition into a single metadata comparison."""
    key = str(condition.get("key"))
    field = _condition_field(key, allow_document_scope=allow_document_scope)
    operator = normalize_metadata_operator(condition.get("operator"))
    value = condition.get("value")

    if operator == "eq":
        return f"{field} == {_literal(key, value)}"
    if operator == "in":
        return f"{field} in [{', '.join(_members(key, value))}]"
    raise ValueError(
        f"metadata_condition operator '{operator}' is not supported; "
        f"supported operators: {', '.join(SUPPORTED_OPERATORS)}."
    )


def _condition_field(key: str, *, allow_document_scope: bool) -> str:
    """Resolve one condition key to the metadata path it is compiled against."""
    if key == DOC_REF_KEY:
        if allow_document_scope:
            return metadata_path(DOC_REF_KEY)
        raise ValueError(
            "Document scope must use document_ids or "
            "RetrievalScope.document_ids, not metadata_condition doc_ref."
        )
    if key in INTERNAL_FILTER_KEYS:
        raise ValueError(
            f"metadata_condition must not filter the internal field '{key}'."
        )
    if key not in METADATA_KEY_WHITELIST:
        raise ValueError(
            f"metadata_condition key '{key}' is not filterable; supported keys: "
            f"{', '.join(sorted(METADATA_KEY_WHITELIST))}."
        )
    return metadata_path(key)


def _literal(key: str, value: Any) -> str:
    """Encode one comparison value by the JSON type the caller passed."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        if not math.isfinite(float(value)):
            raise ValueError(f"metadata_condition '{key}' requires a finite number.")
        return str(value)
    if isinstance(value, str):
        return f'"{sanitize_filter_value(value)}"'
    raise ValueError(
        f"metadata_condition '{key}' requires a string, number or boolean "
        "value; only 'in' accepts a list."
    )


def _members(key: str, value: Any) -> List[str]:
    """Encode the value of an ``in`` condition as a list of literals."""
    if not isinstance(value, (list, tuple, set)):
        raise ValueError(f"metadata_condition '{key}' 'in' requires a list value.")
    return [_literal(key, item) for item in value]
