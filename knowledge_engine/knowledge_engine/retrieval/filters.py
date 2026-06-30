# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Metadata filtering helpers for retrieval and direct-injection paths."""

from typing import Any, Callable, Dict, List, Optional

from llama_index.core.vector_stores import (
    ExactMatchFilter,
    FilterCondition,
    FilterOperator,
    MetadataFilter,
    MetadataFilters,
)

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
    validate_metadata_condition(metadata_condition, reject_document_scope=True)

    filters: List[MetadataFilter | MetadataFilters] = [
        ExactMatchFilter(key="knowledge_id", value=knowledge_id)
    ]
    user_filters = _build_user_metadata_filters(metadata_condition)
    if user_filters is not None:
        filters.append(user_filters)

    return MetadataFilters(filters=filters, condition=FilterCondition.AND)


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
    validate_metadata_condition(metadata_condition, reject_document_scope=True)

    filters: List[Dict[str, Any]] = [
        {"term": {"metadata.knowledge_id.keyword": knowledge_id}}
    ]

    if not metadata_condition or "conditions" not in metadata_condition:
        return filters

    condition_filters = [
        condition_filter
        for condition_filter in (
            _build_elasticsearch_condition_filter(condition)
            for condition in _iter_valid_conditions(metadata_condition)
        )
        if condition_filter is not None
    ]
    if not condition_filters:
        return filters

    condition = _normalize_filter_condition(metadata_condition.get("operator"))
    if condition == FilterCondition.OR:
        filters.append(
            {
                "bool": {
                    "should": condition_filters,
                    "minimum_should_match": 1,
                }
            }
        )
    else:
        filters.extend(condition_filters)

    return filters


def chunk_matches_metadata_condition(
    metadata: Optional[Dict[str, Any]],
    metadata_condition: Optional[Dict[str, Any]] = None,
) -> bool:
    """Return whether chunk metadata satisfies a Dify-style condition tree."""

    validate_metadata_condition(metadata_condition)

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

    validate_metadata_condition(metadata_condition)

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


def _normalize_filter_condition(raw_condition: Any) -> FilterCondition:
    condition = "and" if raw_condition is None else str(raw_condition).strip().lower()
    if condition == "or":
        return FilterCondition.OR
    return FilterCondition.AND


def _build_user_metadata_filters(
    metadata_condition: Optional[Dict[str, Any]],
) -> MetadataFilters | None:
    if not metadata_condition or "conditions" not in metadata_condition:
        return None

    filters = [
        _build_metadata_filter(condition)
        for condition in _iter_valid_conditions(metadata_condition)
    ]
    if not filters:
        return None

    return MetadataFilters(
        filters=filters,
        condition=_normalize_filter_condition(metadata_condition.get("operator")),
    )


def _build_metadata_filter(condition: Dict[str, Any]) -> MetadataFilter:
    filter_op = OPERATOR_MAP.get(
        _normalize_operator(condition.get("operator")),
        FilterOperator.EQ,
    )
    return MetadataFilter(
        key=condition.get("key"),
        value=condition.get("value"),
        operator=filter_op,
    )


def _build_elasticsearch_condition_filter(
    condition: Dict[str, Any],
) -> Dict[str, Any] | None:
    key = condition.get("key")
    operator = _normalize_operator(condition.get("operator"))
    value = condition.get("value")
    field_name = f"metadata.{key}.keyword"

    if operator == "eq":
        return {"term": {field_name: value}}
    if operator == "ne":
        return {"bool": {"must_not": {"term": {field_name: value}}}}
    if operator == "in":
        return {"terms": {field_name: value}}
    if operator == "nin":
        return {"bool": {"must_not": {"terms": {field_name: value}}}}
    if operator in ["gt", "gte", "lt", "lte"]:
        return {"range": {field_name: {operator: value}}}
    if operator == "contains":
        return {"wildcard": {field_name: f"*{value}*"}}
    if operator == "text_match":
        return {"match": {f"metadata.{key}": value}}
    return {"term": {field_name: value}}


def validate_metadata_condition(
    metadata_condition: Optional[Dict[str, Any]],
    *,
    reject_document_scope: bool = False,
) -> None:
    """Validate the supported flat metadata condition contract."""

    if not metadata_condition:
        return

    if _normalize_condition_operator(metadata_condition.get("operator")) == "not":
        raise ValueError("metadata_condition operator 'not' is not supported.")

    for condition in metadata_condition.get("conditions") or []:
        if not isinstance(condition, dict):
            continue
        if "conditions" in condition:
            raise ValueError("Nested metadata conditions are not supported.")
        if reject_document_scope and condition.get("key") == "doc_ref":
            raise ValueError(
                "Document scope must use document_ids or "
                "RetrievalScope.document_ids, not metadata_condition doc_ref."
            )


def _normalize_condition_operator(raw_condition: Any) -> str:
    return "and" if raw_condition is None else str(raw_condition).strip().lower()


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
