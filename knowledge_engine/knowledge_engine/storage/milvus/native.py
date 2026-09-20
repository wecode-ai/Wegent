# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Milvus row layout, index contract vocabulary and scope filters.

This module owns what a stored row is: the physical schema, the index contract
that binds a collection to one embedding space and schema version, row
identifiers, the filter expressions the read and write paths share, and the
reads that answer what a collection really contains. The contract has exactly
one home - the description of the collection it describes, written when that
collection is created and read back from it - so nothing outside the collection
records what a collection contains. The shared connection and the write and
search RPCs live in ``store``; nothing here resolves retrieval text or calls an
embedding provider, so an adapter can be tested against real Milvus without a
model.

The persisted contract is only what makes a stored index incompatible with a
request: the schema version, the dimension and the stable embedding space
identity. Fields, metric, index, BM25 function and analyzer are static physical
structure, so a change to any of them is expressed by bumping
``SCHEMA_VERSION`` - and the writer checks that structure against the real
collection instead of trusting the version it declares. The checks read that
structure back from the collection; the schema this code writes is the shape
they compare it with, which is why it is built here and not described twice.
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
from pymilvus.exceptions import AmbiguousIndexName
from pymilvus.milvus_client.index import IndexParams

from knowledge_engine.storage.milvus.errors import IndexContractIncompatibleError

# Bump when the physical row layout changes in a way that requires rebuilding.
SCHEMA_VERSION = 5
METRIC_TYPE = "COSINE"
INDEX_TYPE = "AUTOINDEX"
SPARSE_METRIC_TYPE = "BM25"
SPARSE_INDEX_TYPE = "SPARSE_INVERTED_INDEX"
# The keyword capability is a property of the collection: the analyzer decides
# which tokens BM25 indexes, so a change here is a static structure change that
# ``SCHEMA_VERSION`` publishes rather than a field the contract persists.
ANALYZER_TYPE = "chinese"
ANALYZER_PARAMS: Dict[str, Any] = {"type": ANALYZER_TYPE}
BM25_FUNCTION_NAME = "retrieval_text_bm25"

# Marker that separates the stored contract from any other description text.
# Milvus 2.5.4 round-trips a collection description unchanged (verified on the
# pinned contract fixture), so the contract needs no column of its own.
CONTRACT_DESCRIPTION_PREFIX = "wegent-index-contract:"

MAX_ID_LENGTH = 128
MAX_TEXT_LENGTH = 65535

# Retrieval reads at the level that skips the linearizable wait (~400ms Strong
# versus ~1ms Bounded on the contract fixture), which also means the first reads
# after a write can be answered from a snapshot that predates it. The write path
# accepts that window and does not wait for it (ticket 11); creation still
# verifies, so that read stays Strong.
READ_CONSISTENCY_LEVEL = "Bounded"
WRITE_CONSISTENCY_LEVEL = "Strong"

# Fallback deadline for one RPC when a store was constructed without one.
DEFAULT_RPC_TIMEOUT_SECONDS = 10.0
# Creating a collection and writing its contract are heavy server operations,
# so they get a wider budget than a query or mutation. The value stays an int
# on purpose: ``MilvusClient.create_collection`` also runs the index-build wait
# loop, and PyMilvus only enforces that loop's own total budget when the
# timeout is an int (``GrpcHandler.wait_for_creating_index``). A float here
# leaves the loop bounded by nothing but its per-RPC deadline.
HEAVY_RPC_TIMEOUT_SECONDS = 30

# The physical columns of a stored row. Everything else a row carries lives in
# the metadata column, the one place a condition can name.
ID_FIELD = "id"
RETRIEVAL_TEXT_FIELD = "retrieval_text"
DISPLAY_TEXT_FIELD = "display_text"
METADATA_FIELD = "metadata"
DENSE_VECTOR_FIELD = "dense_vector"
SPARSE_VECTOR_FIELD = "sparse_vector"

# The one index each vector field carries in this schema version. It is one
# table because two readers must agree on it: the writer declares these indexes
# when it creates a collection, and the structure check reads them back.
EXPECTED_INDEXES: Dict[str, tuple[str, str]] = {
    DENSE_VECTOR_FIELD: (INDEX_TYPE, METRIC_TYPE),
    SPARSE_VECTOR_FIELD: (SPARSE_INDEX_TYPE, SPARSE_METRIC_TYPE),
}
# The state an index reports once it can answer a search.
INDEX_STATE_FINISHED = "Finished"

# The metadata keys every stored chunk carries. Row identity is deliberately
# absent: the write path owns it, so a query condition can never pin or fake it.
KNOWLEDGE_ID_KEY = "knowledge_id"
DOC_REF_KEY = "doc_ref"
SOURCE_FILE_KEY = "source_file"
CHUNK_INDEX_KEY = "chunk_index"
CREATED_AT_KEY = "created_at"

# Columns one read asks for by default: the row's identity, the two texts the
# retrieval paths answer with, and the metadata column that holds the rest.
ROW_OUTPUT_FIELDS: List[str] = [
    ID_FIELD,
    RETRIEVAL_TEXT_FIELD,
    DISPLAY_TEXT_FIELD,
    METADATA_FIELD,
]


@dataclass(frozen=True)
class MilvusIndexBinding:
    """Minimal index contract one collection declares about itself.

    Everything here describes the vectors and the row layout, never where the
    collection lives or how it was produced, so moving a knowledge base between
    deployments or renaming its Python classes cannot make a readable index
    look incompatible.
    """

    schema_version: int
    dimension: int
    embedding_space_id: str

    # The whole persisted contract, as one literal: what is not in this tuple is
    # not stored, so it cannot decide compatibility either.
    PERSISTED_FIELDS = ("schema_version", "dimension", "embedding_space_id")

    def __post_init__(self) -> None:
        if self.schema_version <= 0:
            raise ValueError("schema_version must be a positive integer")
        if self.dimension <= 0:
            raise ValueError("dimension must be a positive integer")
        if (
            not isinstance(self.embedding_space_id, str)
            or not self.embedding_space_id.strip()
        ):
            raise ValueError("embedding_space_id must be a non-empty string")

    def to_payload(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_payload(cls, payload: Dict[str, Any]) -> "MilvusIndexBinding":
        """Read a persisted contract, refusing anything this code did not write.

        A description carrying other fields than the persisted contract was
        written by another version of this code, not by a newer one this reader
        should guess about, so it is refused instead.
        """
        if set(payload) != set(cls.PERSISTED_FIELDS):
            raise ValueError(
                "the persisted index contract does not carry exactly "
                f"{', '.join(cls.PERSISTED_FIELDS)}"
            )
        try:
            return cls(
                schema_version=int(payload["schema_version"]),
                dimension=int(payload["dimension"]),
                embedding_space_id=payload["embedding_space_id"],
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("the persisted index contract is unreadable") from exc

    def assert_compatible(
        self, other: "MilvusIndexBinding", *, collection_name: str
    ) -> None:
        """Raise when the requested contract differs from the bound one."""
        for field in self.PERSISTED_FIELDS:
            if getattr(self, field) != getattr(other, field):
                raise IndexContractIncompatibleError(
                    collection_name,
                    f"{field} mismatch",
                    details={
                        "bound": getattr(self, field),
                        "requested": getattr(other, field),
                    },
                )


def sanitize_filter_value(value: Any) -> str:
    """Escape a value for a Milvus boolean filter expression."""
    return str(value).replace("\\", "\\\\").replace('"', '\\"')


def metadata_path(key: str) -> str:
    """The JSON path every scope and metadata condition is compiled against.

    One column carries all the metadata a row was written with, so a condition
    on it is a condition on that JSON path. The server applies it before the
    ``top_k`` cut, and the physical schema keeps no column whose only job is to
    be filterable.
    """
    return f'{METADATA_FIELD}["{sanitize_filter_value(key)}"]'


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
    """Compile the mandatory knowledge base and document scope.

    The scope names the same metadata keys the write path stores, so it is
    compiled like every other condition: it narrows the read inside the
    database, before the ``top_k`` cut, and a row whose metadata does not
    declare the scope cannot be returned.
    """
    knowledge_scope = metadata_path(KNOWLEDGE_ID_KEY)
    conditions = [f'{knowledge_scope} == "{sanitize_filter_value(knowledge_id)}"']
    if doc_refs is not None:
        if not doc_refs:
            raise ValueError("doc_refs must not be an empty scope")
        escaped = [f'"{sanitize_filter_value(doc_ref)}"' for doc_ref in doc_refs]
        conditions.append(f"{metadata_path(DOC_REF_KEY)} in [{', '.join(escaped)}]")
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
    """One ``describe_collection`` answer, read as everything it declares.

    The contract, the dense dimension and the physical row layout all come from
    the same server call, so a reader that only needs the contract pays no
    extra round trip for the rest and a writer can check what it reads.
    """

    dimension: int | None
    binding: MilvusIndexBinding | None
    # Keyed by field name: the layout is a set of named columns, and a check
    # about one column must not depend on where the server listed it.
    fields: Dict[str, Dict[str, Any]]
    functions: List[Dict[str, Any]]
    enable_dynamic_field: bool | None


def read_collection_description(
    client: MilvusClient,
    collection_name: str,
    *,
    timeout: float,
) -> CollectionDescription:
    """Read the contract and the physical structure one collection declares."""
    description = client.describe_collection(collection_name, timeout=timeout)
    return CollectionDescription(
        dimension=_dense_dimension(description),
        binding=index_contract_from_description(description.get("description")),
        fields={
            str(field.get("name")): dict(field)
            for field in description.get("fields", [])
        },
        functions=[dict(function) for function in description.get("functions", [])],
        enable_dynamic_field=description.get("enable_dynamic_field"),
    )


def _dense_dimension(description: Dict[str, Any]) -> int | None:
    for field in description.get("fields", []):
        if field.get("name") == DENSE_VECTOR_FIELD:
            dim = field.get("params", {}).get("dim")
            return int(dim) if dim is not None else None
    return None


@dataclass(frozen=True)
class CollectionIndexes:
    """What the server says about the indexes one collection carries.

    ``described`` maps each covered field to the server's answer about its
    index. ``unreadable`` names the index names the server would not describe
    because the collection holds more than one of them, so the state of the
    fields those indexes cover cannot be confirmed at all.
    """

    described: Dict[str, Dict[str, Any]]
    unreadable: List[str]


def read_collection_indexes(
    client: MilvusClient,
    collection_name: str,
    *,
    timeout: float,
) -> CollectionIndexes:
    """Read what the server says about the indexes of one collection.

    The answer is keyed by the field each index covers, because that is what
    the row layout names: Milvus allows one index per field, so the covered
    field is the index's identity for a structure check. An index name the
    server holds twice is not described - it refuses - and is reported as
    unreadable instead, which is what makes a collection two identical creates
    raced on visibly unconfirmable rather than silently assumed.
    """
    names = list(client.list_indexes(collection_name, timeout=timeout))
    described: Dict[str, Dict[str, Any]] = {}
    unreadable: List[str] = []
    for index_name in dict.fromkeys(names):
        if names.count(index_name) > 1:
            # The server answers about several indexes at once and refuses to
            # pick one, so this field's index state cannot be read at all.
            unreadable.append(index_name)
            continue
        try:
            answer = client.describe_index(collection_name, index_name, timeout=timeout)
        except AmbiguousIndexName:
            # The same state, reached without the duplicate being visible in
            # the name list: the server still will not pick one index.
            unreadable.append(index_name)
            continue
        if not answer:
            continue
        described[str(answer.get("field_name") or index_name)] = dict(answer)
    return CollectionIndexes(described=described, unreadable=unreadable)


def declare_collection_indexes(index_params: IndexParams) -> None:
    """Declare the physical index of every vector field this schema writes."""
    for field_name, (index_type, metric_type) in EXPECTED_INDEXES.items():
        index_params.add_index(
            field_name=field_name,
            index_type=index_type,
            metric_type=metric_type,
        )


def assert_collection_structure(
    described: CollectionDescription,
    indexes: CollectionIndexes,
    *,
    binding: MilvusIndexBinding,
    collection_name: str,
) -> None:
    """Refuse a collection whose real structure is not this schema version.

    The contract says which schema version a collection claims to be. A claim
    is not the structure itself: a create that died after the collection was
    registered, a collection another tool finished, or a partially built index
    all leave a collection that declares the current version while missing a
    field, the BM25 function or an index. The writer therefore compares the
    server's own answer with the schema this code writes - the same schema the
    create sent - and fails rather than writing rows into a collection it
    cannot read back.
    """
    mismatches = collection_structure_mismatches(
        described,
        indexes,
        binding=binding,
    )
    if mismatches:
        raise IndexContractIncompatibleError(
            collection_name,
            "the collection structure is not the one this schema version writes",
            details={"mismatches": mismatches},
        )


def collection_structure_mismatches(
    described: CollectionDescription,
    indexes: CollectionIndexes,
    *,
    binding: MilvusIndexBinding,
) -> List[str]:
    """Every way a collection's real structure differs from this schema version.

    An empty list means the collection is the one this code writes. Each entry
    names one difference, so a failure reports the whole picture instead of the
    first thing that did not match.
    """
    schema = build_collection_schema(binding)
    mismatches = _field_mismatches(described, schema)
    mismatches += _analyzer_mismatches(described)
    mismatches += _function_mismatches(described, schema)
    mismatches += _index_mismatches(indexes)
    return mismatches


def _field_mismatches(
    described: CollectionDescription, schema: CollectionSchema
) -> List[str]:
    """Compare the described columns with the schema this code writes.

    A column is this schema's column only when every property the schema
    declares on it is the one the server reports. The dense dimension is left
    to the contract comparison: a collection whose vector field reports
    another dimension than its own contract is refused before this runs.
    """
    expected = {field.name: field for field in schema.fields}
    actual = described.fields
    mismatches = _name_mismatches(expected, actual, kind="fields")
    for name in sorted(set(expected) & set(actual)):
        mismatches += _field_property_mismatches(name, expected[name], actual[name])
    if bool(described.enable_dynamic_field) != bool(schema.enable_dynamic_field):
        mismatches.append("the collection accepts dynamic fields, this schema does not")
    return mismatches


def _field_property_mismatches(
    name: str, expected: FieldSchema, actual: Dict[str, Any]
) -> List[str]:
    """Report the properties of one column that differ from this schema.

    Each property is read from where its own side keeps it: the schema declares
    them on the field it writes, while ``describe_collection`` answers the type
    at the field and the length among the field's parameters.
    """
    params = actual.get("params") or {}
    declared = (
        ("type", int(expected.dtype), int(actual.get("type", -1))),
        ("is_primary", bool(expected.is_primary), bool(actual.get("is_primary"))),
        ("nullable", bool(expected.nullable), bool(actual.get("nullable"))),
        ("max_length", expected.max_length, params.get("max_length")),
    )
    return [
        f"field {name} has {property_name} {actual_value}, expected {expected_value}"
        for property_name, expected_value, actual_value in declared
        if expected_value != actual_value
    ]


def _analyzer_mismatches(described: CollectionDescription) -> List[str]:
    """Compare the analyzer BM25 reads the retrieval text through.

    The keyword capability is the analyzer, not the field name: a collection
    whose retrieval text is analyzed differently indexes different terms, so
    the analyzer this schema declares is part of the structure to confirm.
    """
    field = described.fields.get(RETRIEVAL_TEXT_FIELD)
    if field is None:
        # The missing column is already one of the reported mismatches.
        return []
    params = field.get("params") or {}
    if str(params.get("enable_analyzer", "")).lower() != "true":
        return [f"{RETRIEVAL_TEXT_FIELD} does not enable an analyzer"]
    declared = _json_or_text(params.get("analyzer_params"))
    if declared != ANALYZER_PARAMS:
        return [
            f"{RETRIEVAL_TEXT_FIELD} is analyzed by {declared}, "
            f"expected {ANALYZER_PARAMS}"
        ]
    return []


def _function_mismatches(
    described: CollectionDescription, schema: CollectionSchema
) -> List[str]:
    """Compare the BM25 function that maintains the sparse vector."""
    expected = {function.name: function for function in schema.functions}
    actual = {str(function.get("name")): function for function in described.functions}
    mismatches = _name_mismatches(expected, actual, kind="functions")
    for name in sorted(set(expected) & set(actual)):
        expected_function = expected[name]
        actual_function = actual[name]
        if int(actual_function.get("type", -1)) != int(expected_function.type):
            mismatches.append(
                f"function {name} has type {actual_function.get('type')}, "
                f"expected {int(expected_function.type)}"
            )
        for role in ("input_field_names", "output_field_names"):
            expected_names = [str(item) for item in getattr(expected_function, role)]
            actual_names = _function_field_names(actual_function.get(role))
            if expected_names != actual_names:
                mismatches.append(
                    f"function {name} {role} is {actual_names}, "
                    f"expected {expected_names}"
                )
    return mismatches


def _name_mismatches(
    expected: Dict[str, Any],
    actual: Dict[str, Any],
    *,
    kind: str,
) -> List[str]:
    """Report the names only one side of a comparison declares."""
    mismatches: List[str] = []
    missing = sorted(set(expected) - set(actual))
    if missing:
        mismatches.append(f"{kind} are missing: {', '.join(missing)}")
    unexpected = sorted(set(actual) - set(expected))
    if unexpected:
        mismatches.append(
            f"{kind} are not part of this schema: {', '.join(unexpected)}"
        )
    return mismatches


def _index_mismatches(indexes: CollectionIndexes) -> List[str]:
    """Compare the indexes the vector fields carry with the declared ones."""
    mismatches = [
        f"the collection holds more than one {index_name} index, so the state "
        "of its fields cannot be confirmed"
        for index_name in indexes.unreadable
    ]
    for field_name, (index_type, metric_type) in EXPECTED_INDEXES.items():
        described = indexes.described.get(field_name)
        if described is None:
            mismatches.append(f"field {field_name} has no index")
            continue
        state = str(described.get("state") or "")
        if state != INDEX_STATE_FINISHED:
            mismatches.append(
                f"the index on {field_name} is "
                f"{state or 'in an unknown state'}, expected {INDEX_STATE_FINISHED}"
            )
        if str(described.get("index_type") or "") != index_type:
            mismatches.append(
                f"the index on {field_name} is {described.get('index_type')}, "
                f"expected {index_type}"
            )
        if str(described.get("metric_type") or "") != metric_type:
            mismatches.append(
                f"the index on {field_name} measures "
                f"{described.get('metric_type')}, expected {metric_type}"
            )
    return mismatches


def _json_or_text(value: Any) -> Any:
    """Read a parameter the server answers as JSON text when it is one."""
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except ValueError:
        return value


def _function_field_names(value: Any) -> List[str]:
    """Read a function's field list from either spelling an answer uses.

    The schema declares a list, while ``describe_collection`` answers with the
    protobuf repeated field of the server's message - a container that is
    iterable but is not a ``list`` - so both shapes are read into one.
    """
    if isinstance(value, Iterable) and not isinstance(value, (str, bytes)):
        return [str(item) for item in value]
    return [str(value)]


def build_collection_schema(binding: MilvusIndexBinding) -> CollectionSchema:
    """Build the physical row layout for one Milvus knowledge index.

    The collection carries both retrieval paths: a dense vector for semantic
    search and a server-maintained sparse vector whose terms come from the
    BM25 function over the analyzed retrieval text. Everything a condition can
    name - the scope, a document's own fields and every user key - lives in one
    native JSON column, so the server applies the condition before ``top_k``.
    Its description carries the index contract of the collection it creates.
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
    """Scalar columns shared by every knowledge index row.

    The row's identity, the retrieval text the BM25 function reads, the display
    text a caller is answered with, and the metadata JSON column that holds
    everything else - the scope, a document's own fields and every user key.
    Nothing is duplicated across them, so each value has one home per row.
    """
    return [
        FieldSchema(
            name=ID_FIELD,
            dtype=DataType.VARCHAR,
            is_primary=True,
            max_length=MAX_ID_LENGTH,
        ),
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
    ]
