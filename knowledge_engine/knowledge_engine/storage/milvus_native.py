# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Milvus row layout, index contract vocabulary and scope filters.

This module owns what a stored row is: the physical schema, the index contract
that binds a collection to one embedding space and schema version, row
identifiers, the filter expressions the read and write paths share, and the one
describe that reads a contract back. The contract has exactly one home - the
description of the collection it describes, written when that collection is
created and read back from it - so nothing outside the collection records what a
collection contains. The bounded client lifecycle and the write and search RPCs
live in ``milvus_store``; nothing here resolves retrieval text or calls an
embedding provider, so an adapter can be tested against real Milvus without a
model.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from typing import Any, Dict, Iterable, List, Sequence

from pymilvus import (
    CollectionSchema,
    DataType,
    FieldSchema,
    Function,
    FunctionType,
    MilvusClient,
)

from knowledge_engine.storage.errors import IndexContractIncompatibleError

# Bump when the physical row layout changes in a way that requires rebuilding.
SCHEMA_VERSION = 4
METRIC_TYPE = "COSINE"
INDEX_TYPE = "AUTOINDEX"
SPARSE_METRIC_TYPE = "BM25"
SPARSE_INDEX_TYPE = "SPARSE_INVERTED_INDEX"
# The keyword capability is a property of the collection: the analyzer decides
# which tokens BM25 indexes, so it is part of the stored index contract.
ANALYZER_TYPE = "chinese"
ANALYZER_PARAMS: Dict[str, Any] = {"type": ANALYZER_TYPE}
BM25_FUNCTION_NAME = "retrieval_text_bm25"

# Marker that separates the stored contract from any other description text.
# Milvus 2.5.4 round-trips a collection description unchanged (verified on the
# pinned contract fixture), so the contract needs no column of its own.
CONTRACT_DESCRIPTION_PREFIX = "wegent-index-contract:"

MAX_ID_LENGTH = 128
MAX_KEY_LENGTH = 512
MAX_TEXT_LENGTH = 65535
MAX_COUNT_ROWS = 16384

# Retrieval reads at the level that skips the linearizable wait (~400ms Strong
# versus ~1ms Bounded on the contract fixture), which also means the first reads
# after a write can be answered from a snapshot that predates it. The write path
# accepts that window and does not wait for it (ticket 11); deletion and
# creation still verify, so those reads stay Strong.
READ_CONSISTENCY_LEVEL = "Bounded"
WRITE_CONSISTENCY_LEVEL = "Strong"

# Fallback deadline for one RPC when a store was constructed without one.
DEFAULT_RPC_TIMEOUT_SECONDS = 10.0
# Creating a collection and writing its contract are heavy server operations,
# so they get a wider - but still bounded - budget than a query or mutation.
HEAVY_RPC_TIMEOUT_SECONDS = 30.0

ID_FIELD = "id"
KNOWLEDGE_ID_FIELD = "knowledge_id"
DOC_REF_FIELD = "doc_ref"
SOURCE_FILE_FIELD = "source_file"
CHUNK_INDEX_FIELD = "chunk_index"
RETRIEVAL_TEXT_FIELD = "retrieval_text"
DISPLAY_TEXT_FIELD = "display_text"
METADATA_FIELD = "metadata"
CREATED_AT_FIELD = "created_at"
DENSE_VECTOR_FIELD = "dense_vector"
SPARSE_VECTOR_FIELD = "sparse_vector"

# Physical scalar columns that a metadata condition may be compiled against.
# Row identity is deliberately absent: the write path owns it, so a query
# condition can never pin or fake it.
CHUNK_FIELDS_FOR_FILTERING: List[str] = [
    KNOWLEDGE_ID_FIELD,
    DOC_REF_FIELD,
    SOURCE_FILE_FIELD,
    CHUNK_INDEX_FIELD,
    CREATED_AT_FIELD,
]
NUMERIC_FILTER_FIELDS = frozenset({CHUNK_INDEX_FIELD})

ROW_OUTPUT_FIELDS: List[str] = [
    ID_FIELD,
    KNOWLEDGE_ID_FIELD,
    DOC_REF_FIELD,
    SOURCE_FILE_FIELD,
    CHUNK_INDEX_FIELD,
    RETRIEVAL_TEXT_FIELD,
    DISPLAY_TEXT_FIELD,
    METADATA_FIELD,
    CREATED_AT_FIELD,
]


@dataclass(frozen=True)
class MilvusIndexBinding:
    """Physical index contract one collection declares about itself."""

    collection_name: str
    connection: str
    database: str
    schema_version: int
    embedding_space: str
    dimension: int
    metric_type: str
    index_type: str
    # Analyzer that tokenizes the BM25 keyword index. An empty value marks a
    # contract written before the keyword slice, which cannot serve keyword
    # retrieval and is rejected instead of answering with empty results.
    analyzer: str = ""

    def to_payload(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_payload(cls, payload: Dict[str, Any]) -> "MilvusIndexBinding":
        return cls(
            collection_name=str(payload["collection_name"]),
            connection=str(payload["connection"]),
            database=str(payload["database"]),
            schema_version=int(payload["schema_version"]),
            embedding_space=str(payload["embedding_space"]),
            dimension=int(payload["dimension"]),
            metric_type=str(payload["metric_type"]),
            index_type=str(payload["index_type"]),
            analyzer=str(payload.get("analyzer") or ""),
        )

    def assert_compatible(self, other: "MilvusIndexBinding") -> None:
        """Raise when the requested contract differs from the bound one."""
        for field in (
            "connection",
            "database",
            "schema_version",
            "embedding_space",
            "dimension",
            "metric_type",
            "index_type",
            "analyzer",
        ):
            if getattr(self, field) != getattr(other, field):
                raise IndexContractIncompatibleError(
                    self.collection_name,
                    f"{field} mismatch",
                    details={
                        "bound": getattr(self, field),
                        "requested": getattr(other, field),
                    },
                )


def sanitize_filter_value(value: Any) -> str:
    """Escape a value for a Milvus boolean filter expression."""
    return str(value).replace("\\", "\\\\").replace('"', '\\"')


def node_row_id(
    *,
    knowledge_id: str,
    doc_ref: str,
    chunk_index: int,
) -> str:
    """Derive a stable primary key for one indexed chunk.

    The key is the document and the chunk position inside it, so re-indexing
    the same document overwrites its rows instead of layering versions.
    """
    identity = "|".join(
        [
            str(knowledge_id),
            str(doc_ref),
            str(chunk_index),
        ]
    )
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def build_scope_filter(
    *,
    knowledge_id: str,
    doc_refs: Sequence[Any] | None = None,
    extra_conditions: Iterable[str] | None = None,
) -> str:
    """Compile the mandatory knowledge base and document scope."""
    conditions = [f'knowledge_id == "{sanitize_filter_value(knowledge_id)}"']
    if doc_refs is not None:
        if not doc_refs:
            raise ValueError("doc_refs must not be an empty scope")
        escaped = [f'"{sanitize_filter_value(doc_ref)}"' for doc_ref in doc_refs]
        conditions.append(f"doc_ref in [{', '.join(escaped)}]")
    for condition in extra_conditions or ():
        normalized = condition.strip()
        if normalized:
            conditions.append(normalized)
    return " and ".join(conditions)


def index_contract_description(binding: MilvusIndexBinding) -> str:
    """Serialize a contract into the description of the collection it describes.

    The description travels with the collection in every create and read, so the
    contract has no second home to drift away from it.
    """
    return CONTRACT_DESCRIPTION_PREFIX + json.dumps(
        binding.to_payload(), sort_keys=True
    )


def index_contract_from_description(description: Any) -> MilvusIndexBinding | None:
    """Read a contract back out of a collection description.

    ``None`` means the description carries no readable contract: a collection
    this code did not create, or one created by an older schema. Callers refuse
    such a collection instead of guessing what it contains.
    """
    if not isinstance(description, str) or not description.startswith(
        CONTRACT_DESCRIPTION_PREFIX
    ):
        return None
    try:
        payload = json.loads(description[len(CONTRACT_DESCRIPTION_PREFIX) :])
        if not isinstance(payload, dict):
            return None
        return MilvusIndexBinding.from_payload(payload)
    except (KeyError, TypeError, ValueError):
        return None


@dataclass(frozen=True)
class CollectionDescription:
    """One ``describe_collection`` answer, read as contract and dimension.

    Both facts come from the same server call, so the dimension check costs no
    extra round trip.
    """

    dimension: int | None
    binding: MilvusIndexBinding | None


def read_collection_description(
    client: MilvusClient,
    collection_name: str,
    *,
    timeout: float,
) -> CollectionDescription:
    """Read the contract and the dense dimension one collection declares."""
    description = client.describe_collection(collection_name, timeout=timeout)
    return CollectionDescription(
        dimension=_dense_dimension(description),
        binding=index_contract_from_description(description.get("description")),
    )


def _dense_dimension(description: Dict[str, Any]) -> int | None:
    for field in description.get("fields", []):
        if field.get("name") == DENSE_VECTOR_FIELD:
            dim = field.get("params", {}).get("dim")
            return int(dim) if dim is not None else None
    return None


def build_collection_schema(binding: MilvusIndexBinding) -> CollectionSchema:
    """Build the physical row layout for one Milvus knowledge index.

    The collection carries both retrieval paths: a dense vector for semantic
    search and a server-maintained sparse vector whose terms come from the
    BM25 function over the analyzed retrieval text. Filterable metadata is a
    native JSON column so it is applied by the server before ``top_k``. Its
    description carries the index contract of the collection it creates.
    """
    if binding.dimension <= 0:
        raise ValueError("dimension must be a positive integer")
    fields = _scalar_row_fields() + [
        FieldSchema(
            name=DENSE_VECTOR_FIELD,
            dtype=DataType.FLOAT_VECTOR,
            dim=binding.dimension,
        ),
        FieldSchema(
            name=SPARSE_VECTOR_FIELD,
            dtype=DataType.SPARSE_FLOAT_VECTOR,
        ),
    ]
    schema = CollectionSchema(
        fields=fields,
        auto_id=False,
        enable_dynamic_field=False,
        description=index_contract_description(binding),
    )
    schema.add_function(
        Function(
            name=BM25_FUNCTION_NAME,
            function_type=FunctionType.BM25,
            input_field_names=[RETRIEVAL_TEXT_FIELD],
            output_field_names=[SPARSE_VECTOR_FIELD],
            params={},
        )
    )
    return schema


def _scalar_row_fields() -> List[FieldSchema]:
    """Scalar columns shared by every knowledge index row."""
    return [
        FieldSchema(
            name=ID_FIELD,
            dtype=DataType.VARCHAR,
            is_primary=True,
            max_length=MAX_ID_LENGTH,
        ),
        FieldSchema(
            name=KNOWLEDGE_ID_FIELD,
            dtype=DataType.VARCHAR,
            max_length=MAX_KEY_LENGTH,
        ),
        FieldSchema(
            name=DOC_REF_FIELD,
            dtype=DataType.VARCHAR,
            max_length=MAX_KEY_LENGTH,
        ),
        FieldSchema(
            name=SOURCE_FILE_FIELD,
            dtype=DataType.VARCHAR,
            max_length=MAX_TEXT_LENGTH,
        ),
        FieldSchema(name=CHUNK_INDEX_FIELD, dtype=DataType.INT64),
        FieldSchema(
            name=RETRIEVAL_TEXT_FIELD,
            dtype=DataType.VARCHAR,
            max_length=MAX_TEXT_LENGTH,
            # The analyzer must be declared on the field itself: a
            # collection-level analyzer does not tokenize BM25 queries in
            # Milvus 2.5.4, which silently returns no Chinese hits.
            enable_analyzer=True,
            analyzer_params=dict(ANALYZER_PARAMS),
        ),
        FieldSchema(
            name=DISPLAY_TEXT_FIELD,
            dtype=DataType.VARCHAR,
            max_length=MAX_TEXT_LENGTH,
        ),
        FieldSchema(name=METADATA_FIELD, dtype=DataType.JSON, nullable=True),
        FieldSchema(
            name=CREATED_AT_FIELD,
            dtype=DataType.VARCHAR,
            max_length=MAX_TEXT_LENGTH,
        ),
    ]


def strip_connection_credentials(uri: str) -> str:
    """Remove userinfo from a connection URI before it is persisted."""
    if "://" not in uri:
        return uri
    scheme, _, remainder = uri.partition("://")
    authority, _, path = remainder.partition("/")
    if "@" in authority:
        authority = authority.rsplit("@", 1)[1]
    return f"{scheme}://{authority}/{path}" if path else f"{scheme}://{authority}"
