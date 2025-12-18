# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Metadata filtering parser for RAG retrieval.
Converts Dify-style metadata conditions to LlamaIndex MetadataFilters.
"""

from typing import Any, Dict, List, Optional

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
        for cond in metadata_condition["conditions"]:
            key = cond.get("key")
            operator = cond.get("operator", "eq")
            value = cond.get("value")

            if not key or value is None:
                continue

            # Map operator string to FilterOperator enum
            filter_op = OPERATOR_MAP.get(operator.lower(), FilterOperator.EQ)

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

    for cond in metadata_condition["conditions"]:
        key = cond.get("key")
        operator = cond.get("operator", "eq")
        value = cond.get("value")

        if not key or value is None:
            continue

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
