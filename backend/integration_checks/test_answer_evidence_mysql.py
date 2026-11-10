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
            # A real server NOT NULL error, caught only after SAVEPOINT rollback.
            return (
                "INSERT INTO knowledge_citations (id) VALUES (NULL)",
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


def multiple_result(kb_id, doc_id):
    payload = result(kb_id, doc_id)
    first = payload["_answer_evidence"].units[0]
    second = {**first, "evidence_id": "c" * 32, "content": "第二条私有原文"}
    payload["value"] += f"及[[evidence:{'c' * 32}]]"
    payload["_answer_evidence"] = TrustedEvidence([first, second], user_id=7)
    return payload


def test_second_mysql_insert_failure_rolls_back_entire_batch(database, caplog):
    engine, _ = database
    answer_id, kb_id, doc_id = seed(engine)
    payload = multiple_result(kb_id, doc_id)
    statements = []
    inserts = 0

    def reject_second(connection, cursor, statement, parameters, context, executemany):
        nonlocal inserts
        sql = statement.lstrip().upper()
        statements.append(sql)
        if sql.startswith("INSERT INTO KNOWLEDGE_CITATIONS"):
            inserts += 1
            if inserts == 2:
                return (
                    "INSERT INTO knowledge_citations (id) VALUES (NULL)",
                    (),
                )
        return statement, parameters

    event.listen(engine, "before_cursor_execute", reject_second, retval=True)
    try:
        outcome = storage.db_handler._update_subtask_sync(
            answer_id, "COMPLETED", result=payload, generation_id="a" * 32
        )
    finally:
        event.remove(engine, "before_cursor_execute", reject_second)
    assert outcome is not AnswerSaveResult.UNCONFIRMED
    assert inserts == 2
    assert sum(sql.startswith("SAVEPOINT ") for sql in statements) == 1
    assert sum(sql.startswith("ROLLBACK TO SAVEPOINT ") for sql in statements) == 1
    with Session(engine) as db:
        answer = db.get(Subtask, answer_id)
        assert answer.status == SubtaskStatus.COMPLETED
        assert (
            answer.result["value"]
            == "结论[[evidence-unavailable]]及[[evidence-unavailable]]"
        )
        assert answer.result["answer_citations"] == []
        assert answer.result["answer_evidence_errors"] == ["EVIDENCE_WRITE_FAILED"]
        assert db.scalars(select(KnowledgeCitation)).all() == []
    assert "[[citation:" not in str(payload)
    assert "第二条私有原文" not in caplog.text
    assert "private SQL rejection" not in caplog.text


@pytest.mark.parametrize(
    "fault",
    [
        "savepoint",
        "rollback",
        "release",
        "disconnect",
        "answer-update",
        "commit",
        "commit-ack",
    ],
)
def test_infrastructure_faults_never_publish_usable_ids(
    database, monkeypatch, caplog, fault
):
    from contextlib import contextmanager

    engine, _ = database
    answer_id, kb_id, doc_id = seed(engine)
    payload = multiple_result(kb_id, doc_id)
    inserts = 0

    def fail_statement(connection, cursor, statement, parameters, context, executemany):
        nonlocal inserts
        sql = statement.lstrip().upper()
        if sql.startswith("INSERT INTO KNOWLEDGE_CITATIONS"):
            inserts += 1
        reject = (
            (fault == "savepoint" and sql.startswith("SAVEPOINT "))
            or (fault == "release" and sql.startswith("RELEASE SAVEPOINT "))
            or (fault == "answer-update" and sql.startswith("UPDATE SUBTASKS "))
            or (
                fault == "rollback"
                and (
                    inserts == 2
                    and sql.startswith("INSERT INTO KNOWLEDGE_CITATIONS")
                    or sql.startswith("ROLLBACK TO SAVEPOINT ")
                )
            )
        )
        if (
            fault == "disconnect"
            and inserts == 2
            and sql.startswith("INSERT INTO KNOWLEDGE_CITATIONS")
        ):
            # Break the real DBAPI connection, then let the attempted INSERT fail.
            connection.connection.driver_connection.close()
        if (
            fault == "rollback"
            and inserts == 2
            and sql.startswith("INSERT INTO KNOWLEDGE_CITATIONS")
        ):
            return "INSERT INTO knowledge_citations (id) VALUES (NULL)", ()
        if reject:
            return (
                "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'private infrastructure fault'",
                (),
            )
        return statement, parameters

    @contextmanager
    def session():
        with Session(engine) as db:
            try:
                yield db
                if fault == "commit":
                    # Server-side connection loss before COMMIT is not an ACK loss.
                    db.connection().connection.driver_connection.close()
                if fault == "commit-ack":
                    from pymysql.err import OperationalError

                    raw = db.connection().connection.driver_connection
                    actual_commit = raw.commit

                    def lose_ack():
                        actual_commit()
                        raise OperationalError(2013, "private commit ACK lost")

                    # Inject ACK loss at the DBAPI boundary: Session.commit never returns.
                    # This is deterministic fault injection, not a real network-loss test.
                    with monkeypatch.context() as patch:
                        patch.setattr(raw, "commit", lose_ack)
                        db.commit()
                else:
                    db.commit()
            except Exception:
                db.rollback()
                raise

    monkeypatch.setattr(storage, "_db_session", session)
    event.listen(engine, "before_cursor_execute", fail_statement, retval=True)
    try:
        outcome = storage.db_handler._update_subtask_sync(
            answer_id, "COMPLETED", result=payload, generation_id="a" * 32
        )
    finally:
        event.remove(engine, "before_cursor_execute", fail_statement)
    assert outcome is AnswerSaveResult.UNCONFIRMED
    assert "answer_citations" not in payload
    assert "[[citation:" not in payload["value"]
    with Session(engine) as db:
        answer = db.get(Subtask, answer_id)
        rows = db.scalars(select(KnowledgeCitation)).all()
        if fault == "commit-ack":
            assert answer.status == SubtaskStatus.COMPLETED
            assert len(rows) == 2
            assert len(answer.result["answer_citations"]) == 2
        else:
            assert answer.status == SubtaskStatus.RUNNING
            assert rows == []
    assert "第二条私有原文" not in caplog.text
    assert "private infrastructure fault" not in caplog.text
    assert "private commit ACK lost" not in caplog.text


def test_independent_sessions_observe_atomic_commit_and_competing_completion(
    database, monkeypatch
):
    from concurrent.futures import ThreadPoolExecutor
    from contextlib import contextmanager
    from threading import Event

    engine, _ = database
    answer_id, kb_id, doc_id = seed(engine)
    ready, release, competing = Event(), Event(), Event()

    @contextmanager
    def session():
        with Session(engine) as db:
            try:
                yield db
                if not ready.is_set():
                    ready.set()
                    assert release.wait(15), "test did not release commit"
                db.commit()
            except Exception:
                db.rollback()
                raise

    monkeypatch.setattr(storage, "_db_session", session)

    def complete():
        return storage.db_handler._update_subtask_sync(
            answer_id,
            "COMPLETED",
            result=multiple_result(kb_id, doc_id),
            generation_id="a" * 32,
        )

    def competing_lock(connection, cursor, statement, parameters, context, executemany):
        if (
            ready.is_set()
            and not release.is_set()
            and "FOR UPDATE" in statement.upper()
        ):
            competing.set()

    event.listen(engine, "before_cursor_execute", competing_lock)
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(complete)
            try:
                assert ready.wait(15)
                with Session(engine) as observer:
                    assert (
                        observer.get(Subtask, answer_id).status == SubtaskStatus.RUNNING
                    )
                    assert observer.scalars(select(KnowledgeCitation)).all() == []
                second = executor.submit(complete)
                assert competing.wait(
                    15
                ), "second completion never reached the locked row"
                assert not second.done()
            finally:
                release.set()
            assert first.result(15) is not AnswerSaveResult.UNCONFIRMED
            assert second.result(15) is AnswerSaveResult.REJECTED
    finally:
        event.remove(engine, "before_cursor_execute", competing_lock)
    with Session(engine) as observer:
        answer = observer.get(Subtask, answer_id)
        rows = observer.scalars(select(KnowledgeCitation)).all()
        assert answer.status == SubtaskStatus.COMPLETED
        assert {str(row.id) for row in rows} == {
            item["citation_id"] for item in answer.result["answer_citations"]
        }
        assert len(rows) == 2
    assert (
        storage.db_handler._update_subtask_sync(
            answer_id,
            "COMPLETED",
            result=multiple_result(kb_id, doc_id),
            generation_id="stale" * 6,
        )
        is AnswerSaveResult.REJECTED
    )
    with Session(engine) as db:
        assert len(db.scalars(select(KnowledgeCitation)).all()) == 2


@pytest.mark.asyncio
async def test_multiple_same_name_documents_mixed_prevalidation_and_read_binding(
    database, monkeypatch
):
    engine, _ = database
    answer_id, kb_id, doc_id = seed(engine)
    with Session(engine) as db:
        second = KnowledgeDocument(
            kind_id=kb_id,
            user_id=7,
            name="原生资料",
            source_type="text",
            status=DocumentStatus.ENABLED,
            is_active=True,
            index_status=DocumentIndexStatus.SUCCESS,
        )
        db.add(second)
        db.commit()
        second_id = second.id
    payload = multiple_result(kb_id, doc_id)
    units = payload["_answer_evidence"].units
    units[0]["content"] = "界" * 5000
    units[1]["document_id"] = second_id
    units.extend(
        [
            {**units[0], "evidence_id": "oversize", "content": "界" * 5001},
            {**units[0], "evidence_id": "missing", "document_id": 2147483647},
            {**units[0], "evidence_id": "unused"},
        ]
    )
    payload[
        "value"
    ] += f"重复[[evidence:{'b' * 32}]][[evidence:oversize]][[evidence:missing]][[evidence:previous-generation]][[citation:1]]"
    payload["blocks"] = [{"type": "text", "content": f"[[evidence:{'c' * 32}]]"}]
    monkeypatch.setattr(
        "app.services.chat.storage.session_manager.cleanup_streaming_state", AsyncMock()
    )
    assert (
        await persist_completed_result(
            subtask_id=answer_id,
            task_id=9,
            status="COMPLETED",
            generation_id="a" * 32,
            result=payload,
        )
        is AnswerSaveResult.COMMITTED
    )
    citations = payload["answer_citations"]
    assert len(citations) == 2
    assert payload["value"].count(f'[[citation:{citations[0]["citation_id"]}]]') == 2
    assert payload["value"].count("[[evidence-unavailable]]") == 4
    assert (
        payload["blocks"][0]["content"] == f'[[citation:{citations[1]["citation_id"]}]]'
    )
    app = FastAPI()
    app.include_router(router, prefix="/api/knowledge-bases")

    def session():
        with Session(engine) as db:
            yield db

    def user():
        with Session(engine) as db:
            return db.get(User, 7)

    app.dependency_overrides[get_db] = session
    app.dependency_overrides[get_current_user] = user
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        for citation, content, document_id in zip(
            citations, ["界" * 5000, "第二条私有原文"], [doc_id, second_id]
        ):
            path = f'/api/knowledge-bases/citations/{citation["citation_id"]}?answer_id={answer_id}&generation_id={"a" * 32}'
            for _ in range(2):
                response = await client.get(path)
                assert response.status_code == 200
                assert response.json()["content"] == content
                assert response.json()["document_id"] == document_id
            assert (
                await client.get(
                    path.replace(f"answer_id={answer_id}", "answer_id=2147483647")
                )
            ).status_code == 404
            assert (
                await client.get(path.replace("a" * 32, "d" * 32))
            ).status_code == 404
        with Session(engine) as db:
            assert len(db.scalars(select(KnowledgeCitation)).all()) == 2


def test_old_attempt_with_evidence_cannot_insert_after_retry(database):
    from app.services.chat.operations.retry import reset_subtask_for_retry

    engine, _ = database
    answer_id, kb_id, doc_id = seed(engine)
    with Session(engine) as db:
        answer = db.get(Subtask, answer_id)
        answer.status = SubtaskStatus.FAILED
        db.commit()
        generation = reset_subtask_for_retry(db, answer)
    assert (
        storage.db_handler._update_subtask_sync(
            answer_id,
            "COMPLETED",
            result=multiple_result(kb_id, doc_id),
            generation_id="a" * 32,
        )
        is AnswerSaveResult.REJECTED
    )
    with Session(engine) as db:
        assert db.get(Subtask, answer_id).answer_generation_id == generation
        assert db.scalars(select(KnowledgeCitation)).all() == []
    assert (
        storage.db_handler._update_subtask_sync(
            answer_id,
            "COMPLETED",
            result=multiple_result(kb_id, doc_id),
            generation_id=generation,
        )
        is not AnswerSaveResult.UNCONFIRMED
    )
    with Session(engine) as db:
        rows = db.scalars(select(KnowledgeCitation)).all()
        assert len(rows) == 2
        assert all(
            row.caller_context["answer_evidence"]["generation_id"] == generation
            for row in rows
        )
