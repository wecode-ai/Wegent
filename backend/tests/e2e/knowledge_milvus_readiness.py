# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Exercise missing-index readiness through real Backend, Runtime and Milvus."""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
import uuid
from contextlib import ExitStack
from pathlib import Path
from typing import Any

import httpx
from knowledge_remote_index_support import (
    EMBEDDING_MODEL_URL,
    MOCK_MODEL_SERVER_URL,
    _assert_records_reference_document,
    _auth_headers,
    _check,
    _create_client,
    _create_document,
    _create_knowledge_base,
    _create_retrieval_resources,
    _delete_document,
    _delete_knowledge_base,
    _internal_retrieve,
    _login,
    _require_remote_services,
    _upload_attachment,
    _wait_for_index_status,
)


class MilvusState:
    """Manage real index state and inspect persisted data through Milvus REST."""

    def __init__(self, client: httpx.Client, collection: str) -> None:
        self.client = client
        self.collection = collection
        self.missing_index: dict[str, Any] | None = None

    def call(self, operation: str, **params: Any) -> Any:
        response = self.client.post(
            f"/v2/vectordb/{operation}",
            json={"collectionName": self.collection, **params},
        )
        _check(response.status_code == 200, f"Milvus {operation}: {response.text}")
        body = response.json()
        _check(body.get("code") == 0, f"Milvus {operation}: {body}")
        return body.get("data")

    def remove_index(self, field: str) -> None:
        description = self.call("indexes/describe", indexName=field)[0]
        self.call("collections/release")
        self.call("indexes/drop", indexName=field)
        self.missing_index = description
        names = self.call("indexes/list")
        other = "embedding" if field == "sparse_embedding" else "sparse_embedding"
        _check(
            field not in names and other in names,
            f"wrong missing-index fixture: {names}",
        )

    def restore_index(self) -> None:
        if self.missing_index is None:
            return
        index = self.missing_index
        self.call(
            "indexes/create",
            indexParams=[
                {
                    "fieldName": index["fieldName"],
                    "indexName": index["indexName"],
                    "metricType": index["metricType"],
                    "params": {
                        "index_type": index["indexType"],
                        **index.get("params", {}),
                    },
                }
            ],
        )
        self.missing_index = None

    def load(self) -> None:
        self.call("collections/load")
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if (
                self.call("collections/get_load_state")["loadState"]
                == "LoadStateLoaded"
            ):
                return
            time.sleep(0.02)
        raise AssertionError(f"collection never loaded: {self.collection}")

    def snapshot(self, *, parents: bool = False) -> list[dict[str, Any]]:
        collection = self.collection + "__parents" if parents else self.collection
        fields = (
            ["parent_node_id", "doc_ref", "content"]
            if parents
            else ["id", "doc_ref", "text"]
        )
        # Use an explicit Strong query: REST defaults do not carry the writer's
        # session timestamp, so stale reads cannot prove absence of side effects.
        script = """import json, sys
from pymilvus import MilvusClient
request = json.load(sys.stdin)
client = MilvusClient(uri=request.pop("uri"))
try:
    print(json.dumps(client.query(**request, consistency_level="Strong")))
finally:
    client.close()
"""
        root = Path(__file__).resolve().parents[3]
        result = subprocess.run(
            [
                "uv",
                "run",
                "--project",
                str(root / "knowledge_runtime"),
                "--no-sync",
                "python",
                "-c",
                script,
            ],
            input=json.dumps(
                {
                    "uri": str(self.client.base_url).rstrip("/"),
                    "collection_name": collection,
                    "filter": "id >= 0" if parents else 'id != ""',
                    "output_fields": fields,
                    "limit": 100,
                    "timeout": 20,
                }
            ),
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        _check(
            result.returncode == 0, f"strong Milvus snapshot failed: {result.stderr}"
        )
        rows = json.loads(result.stdout)
        return sorted(
            rows, key=lambda row: str(row.get("parent_node_id", row.get("id")))
        )

    def seed_parents(self, documents: list[int]) -> None:
        collection = self.collection + "__parents"
        self.call(
            "collections/create",
            collectionName=collection,
            dimension=2,
            autoId=True,
            metricType="L2",
            params={"enableDynamicField": True, "consistencyLevel": "Strong"},
        )
        self.call(
            "entities/insert",
            collectionName=collection,
            data=[
                {
                    "vector": [0.0, 0.0],
                    "knowledge_id": self.collection.removeprefix("wegent_kb_"),
                    "doc_ref": str(document),
                    "parent_node_id": f"parent-{document}",
                    "content": f"parent sentinel {document}",
                }
                for document in documents
            ],
        )
        _check(
            len(self.snapshot(parents=True)) == len(documents),
            "parent fixture not persisted",
        )


def _log_since(path: Path, offset: int) -> str:
    with path.open(encoding="utf-8") as stream:
        stream.seek(offset)
        return stream.read()


def _wait_for_log(path: Path, offset: int, message: str) -> str:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        lines = _log_since(path, offset)
        if message in lines:
            return lines
        time.sleep(0.02)
    raise AssertionError(
        f"Runtime never emitted {message!r}: {_log_since(path, offset)}"
    )


def _assert_summary(path: Path, offset: int, collection: str, ready: bool) -> None:
    outcome = "ready" if ready else "failed"
    lines = _wait_for_log(
        path, offset, f"index readiness {outcome}: collection={collection} "
    )
    summaries = re.findall(
        rf"index readiness {outcome}: collection={re.escape(collection)} "
        r"attempts=(\d+) elapsed=([\d.]+)s last_error=([^\n]+)",
        lines,
    )
    _check(len(summaries) == 1, f"expected one readiness summary: {lines}")
    attempts, elapsed, error = summaries[0]
    _check(
        int(attempts) >= 2, f"missing-index retry branch was not exercised: {summaries}"
    )
    _check("there is no vector index" in error, f"unexpected readiness error: {error}")
    if not ready:
        _check(
            float(elapsed) >= 4.99, f"failure did not exhaust the 5s budget: {elapsed}"
        )


def _assert_retrieval(
    client: httpx.Client,
    token: str,
    kb_id: int,
    user_id: int,
    document: int,
    marker: str,
) -> None:
    response = _internal_retrieve(client, kb_id, document, marker, user_id=user_id)
    _check(response.status_code == 200, f"retrieving indexed content: {response.text}")
    _assert_records_reference_document(
        response.json().get("records", []), kb_id, document, marker
    )


def _embedding_requests(model: str) -> int:
    response = httpx.get(f"{MOCK_MODEL_SERVER_URL}/captured-requests", timeout=10)
    _check(response.status_code == 200, f"reading model requests: {response.text}")
    return sum(
        request.get("url") == "/v1/embeddings"
        and isinstance(request.get("body"), dict)
        and request["body"].get("model") == model
        for request in response.json()
    )


def _run_case(field: str, recover: bool, runtime_log: Path) -> None:
    name = f"milvus-ready-{uuid.uuid4().hex[:12]}"
    with (
        _create_client() as client,
        httpx.Client(
            base_url=os.environ["E2E_MILVUS_URL"],
            timeout=30,
        ) as milvus_client,
        ExitStack() as cleanup,
    ):
        token, user_id = _login(client)

        def delete_resource(path: str) -> None:
            response = client.delete(path, headers=_auth_headers(token))
            _check(response.status_code < 300, f"cleanup failed: {response.text}")

        _create_retrieval_resources(
            client,
            token,
            name,
            embedding_url=EMBEDDING_MODEL_URL,
            storage_type="milvus",
            storage_url=os.environ["E2E_MILVUS_URL"],
            embedding_model_id=name,
            on_created=lambda path: cleanup.callback(delete_resource, path),
        )
        kb = _create_knowledge_base(client, token, name, name)
        kb_id = int(kb["id"])
        cleanup.callback(_delete_knowledge_base, client, token, kb_id)
        markers = [f"readytarget{uuid.uuid4().hex}", f"readysibling{uuid.uuid4().hex}"]
        documents = []
        for marker in markers:
            attachment, _ = _upload_attachment(client, token, marker)
            document = _create_document(client, token, kb_id, attachment)
            document_id = int(document["id"])
            documents.append(document_id)
            cleanup.callback(_delete_document, client, token, document_id)
            _wait_for_index_status(
                client, token, kb_id, document_id, "success", generation=1
            )

        state = MilvusState(milvus_client, f"wegent_kb_{kb_id}")
        state.seed_parents(documents)
        before = state.snapshot()
        before_parents = state.snapshot(parents=True)
        _check(len(before) >= 2, "child fixtures must contain both documents")
        state.remove_index(field)
        cleanup.callback(state.restore_index)
        offset = runtime_log.stat().st_size
        embedding_count = _embedding_requests(name)
        new_marker = f"readyreplacement{uuid.uuid4().hex}"
        updated = client.put(
            f"/api/knowledge-documents/{documents[0]}/content",
            headers=_auth_headers(token),
            json={"content": new_marker},
        )
        _check(updated.status_code < 300, f"updating document: {updated.text}")
        # Restore only after this application's real load RPC reported a missing index.
        lines = _wait_for_log(
            runtime_log,
            offset,
            f"waiting for vector indexes: collection={state.collection} ",
        )
        _check(f"[{field}]" in lines, f"wrong missing-index error: {lines}")
        if recover:
            state.restore_index()
        row = _wait_for_index_status(
            client,
            token,
            kb_id,
            documents[0],
            "success" if recover else "failed",
            generation=2,
        )
        _assert_summary(runtime_log, offset, state.collection, recover)
        if not recover:
            error = row.get("processing_error")
            _check(
                isinstance(error, dict)
                and error.get("stage") == "indexing"
                and error.get("code") == "indexing_failed"
                and error.get("generation") == 2,
                f"indexing failure not surfaced: {row}",
            )
            _check(
                _embedding_requests(name) == embedding_count,
                "failed cleanup continued into document embedding",
            )
            _check(
                f"Indexing document for knowledge_base_id={kb_id},"
                not in _log_since(runtime_log, offset),
                "failed cleanup continued into the Runtime indexing flow",
            )
            # Restore the fixture only after failure, to inspect unchanged persisted data.
            state.restore_index()
            state.load()
            _check(
                state.snapshot() == before,
                "failed cleanup changed child data or wrote new content",
            )
            _check(
                state.snapshot(parents=True) == before_parents,
                "failed cleanup deleted parent nodes",
            )
        else:
            after = state.snapshot()
            _check(
                new_marker in str(after) and markers[0] not in str(after),
                f"rebuilt content mismatch: before={before} after={after} new={new_marker}",
            )
            sibling = [row for row in after if row["doc_ref"] == str(documents[1])]
            _check(
                sibling
                == [row for row in before if row["doc_ref"] == str(documents[1])],
                "sibling child data was modified",
            )
            _check(
                state.snapshot(parents=True)
                == [
                    row for row in before_parents if row["doc_ref"] == str(documents[1])
                ],
                "parent cleanup crossed document scope",
            )
            _assert_retrieval(client, token, kb_id, user_id, documents[0], new_marker)
        _assert_retrieval(client, token, kb_id, user_id, documents[1], markers[1])
        print(f"Milvus readiness field={field} recover={recover} passed", flush=True)


def run_readiness_scenarios() -> None:
    _require_remote_services()
    runtime_log = Path(
        os.environ.get(
            "E2E_KNOWLEDGE_RUNTIME_LOG",
            str(Path(__file__).resolve().parents[3] / "knowledge_runtime" / "ci.log"),
        )
    )
    _check(
        runtime_log.is_file(),
        f"Runtime log is required for deterministic synchronization: {runtime_log}",
    )
    for field in ("embedding", "sparse_embedding"):
        for recover in (True, False):
            _run_case(field, recover, runtime_log)


if __name__ == "__main__":
    run_readiness_scenarios()
