# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Compile the shared metadata condition into Milvus filter expressions.

The vocabulary is the one every storage backend shares (``retrieval.filters``):
the same validation, and the same rule that a condition without a value carries
no constraint. This module owns only the last mile - checking that every
condition carries a key and an operator it can compile, then turning them into
expressions against the row's JSON metadata column, so the server applies the
condition before the ``top_k`` cut instead of the adapter dropping candidates
afterwards.

The knowledge base is forced by the adapter: every expression is ANDed with that
scope, so a condition naming ``knowledge_id`` can only narrow the query and
never widen it. ``doc_ref`` is accepted only where the read path has no
``RetrievalScope`` to express the document scope with. A nested condition,
another combination or another operator fails loudly, so an unsupported request
can never be dropped or widened into a full knowledge base read.

A key no row carries needs no list to reject it: Milvus answers an unknown JSON
path with an empty result rather than an error (verified against the pinned
2.5.4 contract fixture), so this adapter keeps no per-backend key list that
ingestion would have to stay in sync with.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List

from knowledge_engine.retrieval.filters import (
    normalize_metadata_operator,
    validate_metadata_condition,
)
from knowledge_engine.storage.milvus.native import (
    metadata_path,
    sanitize_filter_value,
)

SUPPORTED_OPERATORS = ("eq", "in")


def compile_metadata_conditions(
    metadata_condition: Dict[str, Any] | None,
    *,
    allow_document_scope: bool = False,
) -> List[str]:
    """Compile the shared flat metadata condition into Milvus filters.

    The result is composed with the mandatory scope filter by the caller, so a
    metadata condition can only narrow the knowledge base and document scope -
    never widen it.

    ``allow_document_scope`` exists for the reading paths: they take no
    separate document scope, so a ``doc_ref`` condition narrows the same query
    instead of being rejected. Retrieval keeps rejecting it, because there the
    document scope is an explicit input that a condition must not impersonate.
    """
    if metadata_condition is None:
        return []
    validate_metadata_condition(
        metadata_condition, reject_document_scope=not allow_document_scope
    )
    _require_flat_and(metadata_condition)

    terms: List[str] = []
    for condition in metadata_condition.get("conditions") or []:
        # The key and the operator are settled before the value is looked at, so
        # a condition this adapter cannot compile never disappears behind an
        # absent value and silently widens the read.
        key = _condition_key(condition)
        operator = _condition_operator(condition)
        value = condition.get("value")
        if value is None:
            continue
        terms.append(_compile_condition(key, operator, value))

    if not terms:
        return []
    if len(terms) == 1:
        return terms
    return [f"({' and '.join(terms)})"]


def _require_flat_and(metadata_condition: Dict[str, Any]) -> None:
    """Refuse a combination this adapter does not compile.

    ``retrieval.filters`` owns the set of combination operators the shared
    contract accepts; this adapter compiles only the flat ``and`` it has been
    verified to serve.
    """
    operator = metadata_condition.get("operator")
    normalized = "and" if operator is None else str(operator).strip().lower()
    if normalized != "and":
        raise ValueError(
            f"metadata_condition operator '{normalized}' is not supported; "
            "only a flat 'and' is."
        )


def _condition_key(condition: Dict[str, Any]) -> str:
    """The key one condition filters on."""
    key = condition.get("key")
    if not isinstance(key, str) or not key:
        raise ValueError(
            "metadata_condition conditions require a non-empty string key."
        )
    return key


def _condition_operator(condition: Dict[str, Any]) -> str:
    """The operator one condition asks for, refusing the ones not compiled."""
    operator = normalize_metadata_operator(condition.get("operator"))
    if operator not in SUPPORTED_OPERATORS:
        raise ValueError(
            f"metadata_condition operator '{operator}' is not supported; "
            f"supported operators: {', '.join(SUPPORTED_OPERATORS)}."
        )
    return operator


def _compile_condition(key: str, operator: str, value: Any) -> str:
    """Compile one validated condition into a Milvus expression."""
    field = metadata_path(key)
    if operator == "eq":
        return f"{field} == {_literal(key, value)}"
    return f"{field} in [{', '.join(_members(key, value))}]"


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
