# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Metadata filtering helpers for retrieval and direct-injection paths."""

from typing import Any, Callable, Dict, List, Optional

from llama_index.core.vector_stores import (
    ExactMatchFilter,
    FilterOperator,
    MetadataFilter,
    MetadataFilters,
)


def parse_metadata_filters(
    knowledge_id: str, metadata_condition: Optional[Dict[str, Any]] = None
) -> MetadataFilters:
    """
    Parse Dify-style metadata condition into LlamaIndex MetadataFilters.

    Args:
        knowledge_id: Knowledge base ID (always filtered)
        metadata_condition: Optional metadata conditions in Dify-style format:
            {
                "operator": "and" | "or",
                "conditions": [
                    {"key": "field_name", "operator": "eq", "value": "value"},
                    {"key": "year", "operator": "gte", "value": 2020},
                    {"key": "status", "operator": "in", "value": ["active", "pending"]}
                ]
            }

    Returns:
        MetadataFilters object compatible with LlamaIndex

    Examples:
        >>> # Simple equality filter
        >>> parse_metadata_filters("kb_123", {
        ...     "operator": "and",
        ...     "conditions": [
        ...         {"key": "category", "operator": "eq", "value": "tech"}
        ...     ]
        ... })

        >>> # Multiple conditions
        >>> parse_metadata_filters("kb_123", {
        ...     "operator": "and",
        ...     "conditions": [
        ...         {"key": "year", "operator": "gte", "value": 2020},
        ...         {"key": "status", "operator": "in", "value": ["active", "pending"]}
        ...     ]
        ... })
    """
    # Operator mapping from Dify-style to LlamaIndex FilterOperator
    OPERATOR_MAP = {
        "eq": FilterOperator.EQ,
        "ne": FilterOperator.NE,
        "gt": FilterOperator.GT,
        "gte": FilterOperator.GTE,
        "lt": FilterOperator.LT,
        "lte": FilterOperator.LTE,
        "in": FilterOperator.IN,
        "nin": FilterOperator.NIN,
        "contains": FilterOperator.CONTAINS,
        "text_match": FilterOperator.TEXT_MATCH,
    }

    # Always filter by knowledge_id
    filters = [ExactMatchFilter(key="knowledge_id", value=knowledge_id)]

    # Parse additional metadata conditions
    if metadata_condition and "conditions" in metadata_condition:
        for cond in _iter_valid_conditions(metadata_condition):
            key = cond.get("key")
            value = cond.get("value")

            # Map operator string to FilterOperator enum
            filter_op = OPERATOR_MAP.get(
                _normalize_operator(cond.get("operator")), FilterOperator.EQ
            )

            # Create MetadataFilter using LlamaIndex's built-in class
            filters.append(MetadataFilter(key=key, value=value, operator=filter_op))

    # Determine condition type (AND/OR)
    condition = "and"
    if metadata_condition:
        condition = metadata_condition.get("operator", "and").lower()

    return MetadataFilters(filters=filters, condition=condition)


def build_elasticsearch_filters(
    knowledge_id: str, metadata_condition: Optional[Dict[str, Any]] = None
) -> List[Dict[str, Any]]:
    """
    Build Elasticsearch filter clauses for hybrid search (direct ES queries).

    Args:
        knowledge_id: Knowledge base ID
        metadata_condition: Optional metadata conditions in Dify-style format

    Returns:
        List of Elasticsearch filter clauses for use in ES query DSL
    """
    filters = [{"term": {"metadata.knowledge_id.keyword": knowledge_id}}]

    if not metadata_condition or "conditions" not in metadata_condition:
        return filters

    for cond in _iter_valid_conditions(metadata_condition):
        key = cond.get("key")
        operator = _normalize_operator(cond.get("operator"))
        value = cond.get("value")

        field_name = f"metadata.{key}.keyword"

        # Build Elasticsearch filter based on operator
        if operator == "eq":
            filters.append({"term": {field_name: value}})
        elif operator == "ne":
            filters.append({"bool": {"must_not": {"term": {field_name: value}}}})
        elif operator == "in":
            filters.append({"terms": {field_name: value}})
        elif operator == "nin":
            filters.append({"bool": {"must_not": {"terms": {field_name: value}}}})
        elif operator in ["gt", "gte", "lt", "lte"]:
            filters.append({"range": {field_name: {operator: value}}})
        elif operator == "contains":
            filters.append({"wildcard": {field_name: f"*{value}*"}})
        elif operator == "text_match":
            filters.append({"match": {f"metadata.{key}": value}})

    return filters


def chunk_matches_metadata_condition(
    metadata: Optional[Dict[str, Any]],
    metadata_condition: Optional[Dict[str, Any]] = None,
) -> bool:
    """Return whether chunk metadata satisfies a Dify-style condition tree."""

    if not metadata_condition or "conditions" not in metadata_condition:
        return True

    conditions = _iter_valid_conditions(metadata_condition)
    if not conditions:
        return True

    operator = str(metadata_condition.get("operator", "and")).lower()
    evaluations = [
        _evaluate_single_condition(metadata or {}, condition)
        for condition in conditions
    ]

    if operator == "or":
        return any(evaluations)
    return all(evaluations)


def filter_chunk_records(
    chunks: List[Dict[str, Any]],
    metadata_condition: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """Filter normalized chunk records using the same metadata condition contract."""

    if not metadata_condition:
        return chunks

    return [
        chunk
        for chunk in chunks
        if chunk_matches_metadata_condition(chunk.get("metadata"), metadata_condition)
    ]


def _evaluate_single_condition(
    metadata: Dict[str, Any],
    condition: Dict[str, Any],
) -> bool:
    key = condition.get("key")
    if not key:
        return True

    operator = _normalize_operator(condition.get("operator"))
    value = condition.get("value")
    actual = metadata.get(key)

    if operator == "eq":
        return actual == value
    if operator == "ne":
        return actual != value
    if operator == "gt":
        return _compare(actual, value, lambda left, right: left > right)
    if operator == "gte":
        return _compare(actual, value, lambda left, right: left >= right)
    if operator == "lt":
        return _compare(actual, value, lambda left, right: left < right)
    if operator == "lte":
        return _compare(actual, value, lambda left, right: left <= right)
    if operator == "in":
        return actual in (value or [])
    if operator == "nin":
        return actual not in (value or [])
    if operator == "contains":
        if actual is None:
            return False
        if isinstance(actual, (list, tuple, set)):
            return value in actual
        return str(value) in str(actual)
    if operator == "text_match":
        if actual is None:
            return False
        return str(value).lower() in str(actual).lower()
    return actual == value


def _normalize_operator(raw_operator: Any) -> str:
    operator = "eq" if raw_operator is None else str(raw_operator).strip().lower()
    return {"==": "eq", "!=": "ne"}.get(operator, operator)


def _iter_valid_conditions(metadata_condition: Dict[str, Any]) -> List[Dict[str, Any]]:
    conditions = metadata_condition.get("conditions") or []
    return [
        condition
        for condition in conditions
        if condition.get("key") and condition.get("value") is not None
    ]


def _compare(
    actual: Any,
    expected: Any,
    comparator: Callable[[Any, Any], bool],
) -> bool:
    if actual is None or expected is None:
        return False
    try:
        return comparator(actual, expected)
    except TypeError:
        return False
