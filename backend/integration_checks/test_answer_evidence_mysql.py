"""CI-only real completion -> HTTP reads with independent MySQL sessions."""

from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, select
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.api.endpoints.knowledge_citations import router
from app.core.security import get_current_user
from app.models.kind import Kind
from app.models.knowledge import DocumentIndexStatus, DocumentStatus, KnowledgeDocument
from app.models.knowledge_citation import KnowledgeCitation
from app.models.resource_member import ResourceMember
from app.models.subtask import Subtask, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.services.chat.storage import db as storage
from app.services.chat.storage.answer_attempt import AnswerSaveResult
from app.services.chat.trigger.lifecycle import persist_completed_result
from app.services.knowledge.answer_evidence import TrustedEvidence
from integration_checks.test_answer_attempt_mysql import database  # noqa: F401


def seed(engine):
    with Session(engine) as db:
        db.add_all(
            [
                User(id=i, user_name=f"evidence-{i}", password_hash="test-hash")
                for i in range(7, 13)
            ]
        )
        task = TaskResource(
            id=9,
            user_id=7,
            kind="Task",
            name="evidence",
            namespace="default",
            json={"status": {"status": "RUNNING"}},
        )
        kb = Kind(
            user_id=7,
            kind="KnowledgeBase",
            name="native",
            namespace="default",
            json={"spec": {}},
        )
        db.add_all([task, kb])
        db.flush()
        document = KnowledgeDocument(
            kind_id=kb.id,
            user_id=7,
            name="原生资料",
            source_type="text",
            status=DocumentStatus.ENABLED,
            is_active=True,
            file_extension="txt",
            index_status=DocumentIndexStatus.SUCCESS,
            chunks=[{"content": "回答时的原文"}],
        )
        answer = Subtask(
            user_id=7,
            task_id=9,
            team_id=1,
            title="answer",
            bot_ids=[],
            role="ASSISTANT",
            status=SubtaskStatus.RUNNING,
            answer_generation_id="a" * 32,
        )
        db.add_all([document, answer])
        db.flush()
        for user_id, resource_type, resource_id, role in [
            (8, "Task", 9, "Reporter"),
            (9, "KnowledgeBase", kb.id, "Reporter"),
            (11, "Task", 9, "Reporter"),
            (11, "KnowledgeBase", kb.id, "RestrictedAnalyst"),
            (12, "Task", 9, "Reporter"),
            (12, "KnowledgeBase", kb.id, "Reporter"),
        ]:
            db.add(
                ResourceMember(
                    resource_type=resource_type,
                    resource_id=resource_id,
                    entity_type="user",
                    entity_id=str(user_id),
                    role=role,
                    status="approved",
                )
            )
        db.commit()
        return answer.id, kb.id, document.id


def result(kb_id, doc_id):
    return {
        "value": f"结论[[evidence:{'b' * 32}]]",
        "_answer_evidence": TrustedEvidence(
            [
                {
                    "evidence_id": "b" * 32,
                    "content": "回答时的原文",
                    "source": "原生资料",
                    "knowledge_base_id": kb_id,
                    "document_id": doc_id,
                }
            ],
            user_id=7,
        ),
    }


@pytest.mark.asyncio
async def test_committed_snapshot_http_authorization_and_refresh(database, monkeypatch):
    engine, _ = database
    answer_id, kb_id, doc_id = seed(engine)
    monkeypatch.setattr(
        "app.services.chat.storage.session_manager.cleanup_streaming_state", AsyncMock()
    )
    payload = result(kb_id, doc_id)
    payload["_answer_evidence"] = TrustedEvidence(
        payload["_answer_evidence"].units, user_id=12
    )
    saved = await persist_completed_result(
        subtask_id=answer_id,
        task_id=9,
        status="COMPLETED",
        generation_id="a" * 32,
        result=payload,
    )
    assert saved is AnswerSaveResult.COMMITTED
    citation_id = payload["answer_citations"][0]["citation_id"]
    with Session(engine) as db:
        assert db.get(KnowledgeCitation, int(citation_id)).user_id == 12
    assert "_answer_evidence" not in payload
    assert "回答时的原文" not in str(payload)

    app = FastAPI()
    app.include_router(router, prefix="/api/knowledge-bases")
    user_id = 7

    def session():
        with Session(engine) as db:
            yield db

    def user():
        with Session(engine) as db:
            return db.get(User, user_id)

    app.dependency_overrides[get_db] = session
    app.dependency_overrides[get_current_user] = user
    path = f'/api/knowledge-bases/citations/{citation_id}?answer_id={answer_id}&generation_id={"a" * 32}'
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        for identity, expected in [(7, 200), (8, 403), (9, 403), (10, 403), (11, 403)]:
            user_id = identity
            response = await client.get(path)
            assert response.status_code == expected
            assert response.headers["cache-control"] == "private, no-store"
            if expected == 403:
                assert "回答时的原文" not in response.text
        user_id = 7
        assert (
            await client.get(f"/api/knowledge-bases/citations/{citation_id}")
        ).status_code == 422
        assert (await client.get(path.replace("a" * 32, "c" * 32))).status_code == 404
        with Session(engine) as db:
            db.get(KnowledgeDocument, doc_id).chunks = [{"content": "当前新原文"}]
            db.get(Subtask, answer_id).result = {
                "value": "forged",
                "answer_generation_id": "c" * 32,
            }
            db.commit()
        restored = await client.get(path)
        assert restored.json()["content"] == "回答时的原文"
        assert restored.json()["citation_id"] == citation_id
        with Session(engine) as db:
            db.get(Kind, kb_id).json = {"spec": {"directAccessRequirement": "edit"}}
            db.commit()
        user_id = 12
        assert (await client.get(path)).status_code == 403
        user_id = 7
        with Session(engine) as db:
            db.get(KnowledgeDocument, doc_id).is_active = False
            db.commit()
        assert (await client.get(path)).status_code == 409
        with Session(engine) as db:
            db.delete(db.get(KnowledgeDocument, doc_id))
            db.commit()
        assert (await client.get(path)).status_code == 409
    repeated = await persist_completed_result(
        subtask_id=answer_id,
        task_id=9,
        status="COMPLETED",
        generation_id="a" * 32,
        result=result(kb_id, doc_id),
    )
    assert repeated is AnswerSaveResult.REJECTED
    with Session(engine) as db:
        assert len(db.scalars(select(KnowledgeCitation)).all()) == 1


def test_actual_mysql_insert_failure_rolls_back_evidence_only(database):
    engine, _ = database
    answer_id, kb_id, doc_id = seed(engine)
    payload = result(kb_id, doc_id)

    def reject_insert(connection, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("INSERT INTO KNOWLEDGE_CITATIONS"):
            # A real server DataError, caught only after successful SAVEPOINT rollback.
            return (
                "SIGNAL SQLSTATE '22001' SET MYSQL_ERRNO = 1406, MESSAGE_TEXT = 'fixture rejection'",
                (),
            )
        return statement, parameters

    event.listen(engine, "before_cursor_execute", reject_insert, retval=True)
    try:
        outcome = storage.db_handler._update_subtask_sync(
            answer_id, "COMPLETED", result=payload, generation_id="a" * 32
        )
    finally:
        event.remove(engine, "before_cursor_execute", reject_insert)
    assert outcome is not AnswerSaveResult.UNCONFIRMED
    with Session(engine) as db:
        answer = db.get(Subtask, answer_id)
        assert answer.status == SubtaskStatus.COMPLETED
        assert answer.result["value"] == "结论[[evidence-unavailable]]"
        assert answer.result["answer_citations"] == []
        assert db.scalars(select(KnowledgeCitation)).all() == []
