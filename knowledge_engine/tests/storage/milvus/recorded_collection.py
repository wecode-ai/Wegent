# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Literal answers of the pinned Milvus 2.5.4 server, for the unit tests.

``describe_collection`` and the index metadata of one created collection are
recorded here exactly as the pinned server answers them, so a unit test that
checks the structure validation compares a written collection against an
independent recording instead of against an expectation built by the same code
the validator uses. A writer change the validator does not follow then fails a
test rather than agreeing with itself.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from knowledge_engine.storage.milvus.native import (
    MilvusIndexBinding,
    index_contract_description,
)

# The field ids and the dimension are the recording's own values; nothing here
# is read from the schema builder under test.
RECORDED_DIMENSION = 1536


def recorded_fields(dimension: int = RECORDED_DIMENSION) -> List[Dict[str, Any]]:
    """The field payload the pinned server answers for this row layout."""
    return [
        {
            "field_id": 100,
            "name": "id",
            "description": "",
            "type": 21,
            "params": {"max_length": 128},
            "is_primary": True,
        },
        {
            "field_id": 101,
            "name": "retrieval_text",
            "description": "",
            "type": 21,
            "params": {
                "max_length": 65535,
                "enable_analyzer": "true",
                "analyzer_params": '{"type":"chinese"}',
            },
        },
        {
            "field_id": 102,
            "name": "display_text",
            "description": "",
            "type": 21,
            "params": {"max_length": 65535},
        },
        {
            "field_id": 103,
            "name": "metadata",
            "description": "",
            "type": 23,
            "params": {},
            "nullable": True,
        },
        {
            "field_id": 104,
            "name": "dense_vector",
            "description": "",
            "type": 101,
            "params": {"dim": dimension},
        },
        {
            "field_id": 105,
            "name": "sparse_vector",
            "description": "",
            "type": 104,
            "params": {},
            "is_function_output": True,
        },
    ]


def recorded_functions() -> List[Dict[str, Any]]:
    """The BM25 function payload the pinned server answers.

    The field names come back as the server's repeated container: iterable, but
    not a ``list``. A tuple records that distinction, so a reader that only
    accepts a list fails here instead of agreeing with itself.
    """
    return [
        {
            "name": "retrieval_text_bm25",
            "id": 100,
            "description": "",
            "type": 1,
            "params": {},
            "input_field_names": ("retrieval_text",),
            "input_field_ids": "[101]",
            "output_field_names": ("sparse_vector",),
            "output_field_ids": "[105]",
        }
    ]


def recorded_indexes() -> Dict[str, Dict[str, Any]]:
    """The index metadata the pinned server answers, keyed by the name it gives.

    Milvus names an index after the field it covers when the create declares no
    name of its own, so the key is both the index name and the covered field
    for the index this schema writes.
    """
    return {
        "dense_vector": {
            "index_type": "AUTOINDEX",
            "metric_type": "COSINE",
            "field_name": "dense_vector",
            "index_name": "dense_vector",
            "total_rows": 0,
            "indexed_rows": 0,
            "pending_index_rows": 0,
            "state": "Finished",
        },
        "sparse_vector": {
            "metric_type": "BM25",
            "index_type": "SPARSE_INVERTED_INDEX",
            "field_name": "sparse_vector",
            "index_name": "sparse_vector",
            "total_rows": 0,
            "indexed_rows": 0,
            "pending_index_rows": 0,
            "state": "Finished",
        },
    }


def recorded_description(
    binding: Optional[MilvusIndexBinding],
    *,
    description: Optional[str] = None,
    fields: Optional[List[Dict[str, Any]]] = None,
    functions: Optional[List[Dict[str, Any]]] = None,
    enable_dynamic_field: bool = False,
    auto_id: bool = False,
) -> Dict[str, Any]:
    """One ``describe_collection`` answer, with the recording as the default."""
    if description is None and binding is not None:
        description = index_contract_description(binding)
    return {
        "collection_name": "wegent_kb_1",
        # The server answers whether it numbers the rows itself, which is the
        # claim the structure check reads.
        "auto_id": auto_id,
        "description": description,
        "fields": (
            recorded_fields(
                binding.dimension if binding is not None else RECORDED_DIMENSION
            )
            if fields is None
            else fields
        ),
        "functions": recorded_functions() if functions is None else functions,
        "enable_dynamic_field": enable_dynamic_field,
    }
