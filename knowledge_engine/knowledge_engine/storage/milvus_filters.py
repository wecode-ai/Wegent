# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Compile the shared metadata condition contract into Milvus expressions.

The adapter above this module owns retrieval modes; this module owns one
concern: turning the flat Dify-style ``and``/``or`` condition tree shared with
the other backends into a Milvus filter expression. Every key compiles against
the native JSON metadata column, so the server applies the condition before the
``top_k`` cut instead of the adapter dropping candidates afterwards; a chunk
field only differs in that its value is encoded as the type the row layout
stored it with.

Recorded semantics of the compiled contract:

- A missing JSON key matches nothing for ``eq``/``gt``/``gte``/``lt``/``lte``/
  ``contains``/``text_match`` and satisfies ``ne``/``nin``, which is what the
  Elasticsearch backend does for an absent field.
- ``contains`` and ``text_match`` are both case-sensitive substring matches:
  Milvus 2.5.4 cannot run an analyzed ``TEXT_MATCH`` against a JSON path. For a
  JSON key the value matches by element with its own type (``contains 2026``
  hits the number ``2026`` but not the string ``"2026"``) or as a substring
  (``contains 2026`` also hits the text ``"release2026"``). Milvus has no way
  to escape its ``like`` wildcards, so a literal ``%`` or ``_`` in the value is
  rejected instead of silently widening the match.
- A condition without a key or with a null value carries no constraint in the
  shared contract and is skipped, exactly as the Elasticsearch backend does.
- A nested condition, an unsupported operator, a non-scalar value outside
  ``in``/``nin``, or a condition on an internal identity field fails loudly.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Literal, Tuple

from knowledge_engine.retrieval.filters import (
    iter_valid_conditions,
    normalize_metadata_operator,
    validate_metadata_condition,
)
from knowledge_engine.storage.milvus_native import (
    CHUNK_METADATA_KEYS,
    DOC_REF_FIELD,
    ID_FIELD,
    NUMERIC_CHUNK_KEYS,
    metadata_path,
    sanitize_filter_value,
)

# Row identity is owned by the write path. It is never readable as a metadata
# condition, so a caller cannot pin or fake it.
INTERNAL_FILTER_FIELDS = frozenset({ID_FIELD})

LiteralKind = Literal["numeric", "text", "json"]


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

    validate_metadata_condition(
        metadata_condition,
        reject_document_scope=not allow_document_scope,
    )
    operator = str(metadata_condition.get("operator") or "and").strip().lower()
    if operator not in {"and", "or"}:
        raise ValueError(f"metadata_condition operator '{operator}' is not supported.")

    terms = [
        _compile_condition(condition, allow_document_scope=allow_document_scope)
        for condition in iter_valid_conditions(metadata_condition)
    ]
    if not terms:
        return []
    if len(terms) == 1:
        return terms
    joined = " or ".join(terms) if operator == "or" else " and ".join(terms)
    return [f"({joined})"]


def _compile_condition(
    condition: Dict[str, Any], *, allow_document_scope: bool = False
) -> str:
    key = str(condition.get("key"))
    field, literal_kind = _condition_target(
        key, allow_document_scope=allow_document_scope
    )
    operator = normalize_metadata_operator(condition.get("operator"))
    value = condition.get("value")

    if operator in {"eq", "ne"}:
        comparison = "==" if operator == "eq" else "!="
        return f"{field} {comparison} {_literal(key, literal_kind, value)}"
    comparisons = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}
    if operator in comparisons:
        literal = _literal(key, literal_kind, value)
        return f"{field} {comparisons[operator]} {literal}"
    if operator in {"in", "nin"}:
        if not isinstance(value, (list, tuple, set)):
            raise ValueError(f"metadata_condition '{operator}' requires a list value.")
        items = ", ".join(_literal(key, literal_kind, item) for item in value)
        keyword = "in" if operator == "in" else "not in"
        return f"{field} {keyword} [{items}]"
    if operator in {"contains", "text_match"}:
        return _compile_text_condition(key, field, literal_kind, value)
    raise ValueError(f"metadata_condition operator '{operator}' is not supported.")


def _condition_target(
    key: str, *, allow_document_scope: bool = False
) -> Tuple[str, LiteralKind]:
    """Resolve one condition key to its field expression and literal type.

    Every key is addressed through the metadata JSON column. The literal type
    decides how a value is encoded: a condition on a chunk field is compared as
    the type the row layout stored there, a condition on a user key by the type
    of the value the caller passed.
    """
    if key == DOC_REF_FIELD:
        if allow_document_scope:
            return metadata_path(DOC_REF_FIELD), "text"
        raise ValueError(
            "Document scope must use document_ids or "
            "RetrievalScope.document_ids, not metadata_condition doc_ref."
        )
    if key in INTERNAL_FILTER_FIELDS:
        raise ValueError(
            f"metadata_condition must not filter the internal field '{key}'."
        )
    if key in CHUNK_METADATA_KEYS:
        kind: LiteralKind = "numeric" if key in NUMERIC_CHUNK_KEYS else "text"
    else:
        kind = "json"
    return metadata_path(key), kind


def _literal(key: str, literal_kind: LiteralKind, value: Any) -> str:
    """Encode one comparison value by the type of the field it is compared to."""
    if literal_kind == "numeric":
        return _numeric_literal(key, value)
    if literal_kind == "text":
        return f'"{sanitize_filter_value(_scalar_value(key, value))}"'
    return _json_literal(key, value)


def _compile_text_condition(
    key: str, field: str, literal_kind: LiteralKind, value: Any
) -> str:
    """Compile a substring condition, including JSON array membership.

    A user key keeps both ways the shared contract can match: the typed element
    match (``contains 2026`` matches the number ``2026`` even inside an array)
    and the string substring match (``contains 2026`` also matches the text
    ``"release2026"``). A chunk field keeps the substring match alone, exactly
    as the typed column it used to be compared against was read. Milvus only
    ever treats ``%`` and ``_`` as ``like`` wildcards and cannot escape them, so
    a value that contains one is rejected instead of widening the condition.
    """
    scalar = _scalar_value(key, value)
    pattern = _literal_pattern(key, _json_text(key, scalar))
    substring = f'{field} like "%{pattern}%"'
    if literal_kind != "json":
        return substring
    membership = _json_literal(key, scalar)
    return f"(json_contains({field}, {membership}) or {substring})"


def _json_text(key: str, value: Any) -> str:
    """Lexical form of a scalar, used for the substring alternative."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _numeric_literal(key, value)
    return str(value)


def _literal_pattern(key: str, value: Any) -> str:
    """Escape a literal substring, rejecting the unescapeable LIKE wildcards."""
    text = str(value)
    wildcard = next((character for character in ("%", "_") if character in text), None)
    if wildcard is not None:
        raise ValueError(
            f"metadata_condition '{key}' cannot match {text!r} literally: "
            "Milvus only supports '%' and '_' as like wildcards and cannot "
            "escape them."
        )
    return sanitize_filter_value(text)


def _scalar_value(key: str, value: Any) -> Any:
    if isinstance(value, (list, tuple, set, dict)):
        raise ValueError(
            f"metadata_condition '{key}' requires a scalar value; only the "
            "in/nin operators accept a list."
        )
    return value


def _numeric_literal(key: str, value: Any) -> str:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"metadata_condition '{key}' requires a numeric value.")
    if not math.isfinite(float(value)):
        raise ValueError(f"metadata_condition '{key}' requires a finite numeric value.")
    return str(value)


def _json_literal(key: str, value: Any) -> str:
    """Encode one JSON-column comparison value by its Python type."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _numeric_literal(key, value)
    return f'"{sanitize_filter_value(_scalar_value(key, value))}"'
