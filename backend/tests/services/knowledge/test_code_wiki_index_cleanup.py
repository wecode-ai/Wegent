# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Code Wiki deletion must leave its configuration available for remote purge."""

import json
import sqlite3
import subprocess
from pathlib import Path

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import ContentOrigin, KnowledgeDocument
from app.models.user import User
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.rag.remote_gateway import RemoteRagGateway, RemoteRagGatewayError
from tests.services.knowledge.test_qa_index_query import _create_qa_index_attempt


@pytest.mark.parametrize("remote_failure", [False, True])
def test_code_wiki_purges_before_deleting_its_configuration(
    test_db: Session,
    test_user: User,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    remote_failure: bool,
) -> None:
    document = _create_qa_index_attempt(test_db, test_user)
    kb = test_db.get(Kind, document.kind_id)
    kb.json = {"spec": {**kb.json["spec"], "kbType": "code_wiki"}}
    document.origin = ContentOrigin.GENERATED.value
    test_db.commit()
    kb_id, document_id = kb.id, document.id
    purged = []

    async def post_model(self, path, payload):
        assert path == "/internal/rag/purge-knowledge-index"
        if remote_failure:
            raise RemoteRagGatewayError("Runtime unavailable", retryable=True)
        snapshot_path = tmp_path / "wiki.db"
        source = test_db.connection().connection.driver_connection
        with sqlite3.connect(snapshot_path) as snapshot:
            snapshot.executescript("\n".join(source.iterdump()))
        repo = Path(__file__).resolve().parents[4]
        reader = Path(__file__).parent / "fixtures" / "run_code_wiki_purge.py"
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
                str(snapshot_path),
                str(payload.knowledge_base_id),
                str(payload.user_id),
            ],
            cwd=repo,
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )
        result = json.loads(completed.stdout)
        purged.append(result)
        return result

    monkeypatch.setattr(RemoteRagGateway, "_post_model", post_model)
    if remote_failure:
        with pytest.raises(RemoteRagGatewayError, match="Runtime unavailable"):
            KnowledgeService.delete_knowledge_base(test_db, kb_id, test_user.id)
        assert test_db.get(Kind, kb_id) is not None
        assert test_db.get(KnowledgeDocument, document_id) is not None
    else:
        assert KnowledgeService.delete_knowledge_base(test_db, kb_id, test_user.id)
        assert purged == [{"status": "deleted"}]
        assert test_db.get(Kind, kb_id) is None
        assert test_db.get(KnowledgeDocument, document_id) is None
