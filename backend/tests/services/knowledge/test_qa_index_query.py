# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Index success to remote QA planning with chunk body storage disabled."""

from __future__ import annotations

import json
import sqlite3
import subprocess
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.knowledge import DocumentIndexStatus, KnowledgeDocument
from app.models.user import User
from app.services.knowledge.index_state_machine import mark_document_index_succeeded


def _create_qa_index_attempt(db: Session, user: User) -> KnowledgeDocument:
    kb = Kind(
        user_id=user.id,
        kind="KnowledgeBase",
        name="qa-kb",
        namespace="default",
        is_active=True,
        json={
            "spec": {
                "retrievalConfig": {
                    "retriever_name": "qa-retriever",
                    "retriever_namespace": "default",
                    "embedding_config": {
                        "model_name": "qa-embedding",
                        "model_namespace": "default",
                    },
                    "retrieval_mode": "hybrid",
                    "top_k": 7,
                    "score_threshold": 0.25,
                    "hybrid_weights": {"vector_weight": 0.85, "keyword_weight": 0.15},
                }
            }
        },
    )
    db.add_all(
        [
            kb,
            Kind(
                user_id=user.id,
                kind="Retriever",
                name="qa-retriever",
                namespace="default",
                is_active=True,
                json={"spec": {"storageConfig": {"type": "qdrant"}}},
            ),
            Kind(
                user_id=user.id,
                kind="Model",
                name="qa-embedding",
                namespace="default",
                is_active=True,
                json={"spec": {"protocol": "openai"}},
            ),
        ]
    )
    db.flush()
    document = KnowledgeDocument(
        kind_id=kb.id,
        user_id=user.id,
        name="qa.md",
        file_extension="md",
        index_status=DocumentIndexStatus.INDEXING,
        index_generation=1,
    )
    db.add(document)
    db.commit()
    return document


def _run_runtime_query(
    db: Session,
    document: KnowledgeDocument,
    db_path: Path,
) -> dict[str, Any]:
    # Separate processes keep the Backend and Runtime ORM registries isolated.
    # The fixture owns an outer transaction, so backup() would wait for its end.
    source = db.connection().connection.driver_connection
    with sqlite3.connect(db_path) as snapshot:
        snapshot.executescript("\n".join(source.iterdump()))
    repo = Path(__file__).resolve().parents[4]
    reader = Path(__file__).parent / "fixtures" / "run_remote_qa_query.py"
    completed = subprocess.run(
        [
            "uv",
            "run",
            "--offline",
            "--no-sync",
            "--project",
            str(repo / "knowledge_runtime"),
            "python",
            str(reader),
            str(db_path),
            str(document.kind_id),
            str(document.user_id),
            str(document.id),
        ],
        cwd=repo,
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    )
    return json.loads(completed.stdout)


def test_default_chunk_storage_index_success_reaches_remote_qa_plan(
    test_db: Session,
    test_user: User,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "CHUNK_STORAGE_ENABLED", False)
    document = _create_qa_index_attempt(test_db, test_user)
    assert mark_document_index_succeeded(
        test_db,
        document.id,
        1,
        chunks={
            "items": [{"content": "Q: question\nA: answer"}],
            "splitter_subtype": "qa_pair",
            "qa_pair_count": 1,
        },
        chunk_storage_enabled=settings.CHUNK_STORAGE_ENABLED,
    )
    test_db.refresh(document)
    assert "items" not in (document.chunks or {})

    plan = _run_runtime_query(test_db, document, tmp_path / "indexed-qa.db")
    assert plan["hint_source"] == "qa_pair_profile"
    assert "大广场模式" in plan["phrases"]
    assert "2025" in plan["keywords"]
    assert plan["retrieval_mode"] == "hybrid"
    assert plan["top_k"] == 7
    assert plan["score_threshold"] == 0.25
    assert plan["vector_weight"] == 0.85
    assert plan["keyword_weight"] == 0.15
