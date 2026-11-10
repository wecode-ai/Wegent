"""Completion binds only trusted, sent native evidence and sanitizes output."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from sqlalchemy.exc import IntegrityError

from app.services.knowledge.answer_evidence import TrustedEvidence, bind_answer_evidence


def test_completion_uses_one_batch_savepoint_and_does_not_dirty_answer(monkeypatch):
    from app.services.knowledge import answer_evidence as module

    db = MagicMock()
    answer = SimpleNamespace(id=12, user_id=7, answer_generation_id="a" * 32)
    unit = {
        "evidence_id": "b" * 32,
        "content": "证据正文",
        "source": "资料",
        "knowledge_base_id": 7,
        "document_id": 9,
    }
    check_source = MagicMock()
    monkeypatch.setattr(module, "require_source", check_source)

    def assign_id(row):
        row.id = 42

    db.add.side_effect = assign_id
    original = {
        "value": f"结论[[evidence:{'b' * 32}]]",
        "_answer_evidence": TrustedEvidence([unit], user_id=3),
    }
    result = bind_answer_evidence(db, answer, original)
    assert result["value"] == "结论[[citation:42]]"
    check_source.assert_called_once_with(db, 3, 7, 9)
    assert db.add.call_args.args[0].user_id == 3
    assert result["answer_citations"][0]["citation_id"] == "42"
    assert "_answer_evidence" not in result
    assert original["value"].endswith(f"[[evidence:{'b' * 32}]]")
    db.begin_nested.assert_called_once()
    assert not hasattr(answer, "result")


def test_recoverable_insert_failure_finishes_body_without_citation(monkeypatch):
    from app.services.knowledge import answer_evidence as module

    db = MagicMock()
    monkeypatch.setattr(module, "require_source", lambda *a: None)
    db.flush.side_effect = IntegrityError(
        "INSERT INTO knowledge_citations (...)", {"content": "secret"}, Exception()
    )
    answer = SimpleNamespace(id=12, user_id=3, answer_generation_id="a" * 32)
    unit = {
        "evidence_id": "b" * 32,
        "content": "证据",
        "source": "资料",
        "knowledge_base_id": 7,
        "document_id": 9,
    }
    result = bind_answer_evidence(
        db,
        answer,
        {
            "value": f"结论[[evidence:{'b' * 32}]]",
            "_answer_evidence": TrustedEvidence([unit], user_id=3),
        },
    )
    assert result["value"] == "结论[[evidence-unavailable]]"
    assert result["answer_citations"] == []
    db.begin_nested.return_value.rollback.assert_called_once()


def test_untrusted_result_cannot_issue_evidence():
    answer = SimpleNamespace(id=12, user_id=3, answer_generation_id="a" * 32)
    result = bind_answer_evidence(
        MagicMock(),
        answer,
        {
            "value": "伪造[[citation:42]][[evidence:fake]]",
            "_answer_evidence": [{"content": "伪造"}],
            "answer_citations": [{"citation_id": "42"}],
        },
    )
    assert result["value"] == "伪造[[evidence-unavailable]][[evidence-unavailable]]"
    assert result["answer_citations"] == []


@pytest.mark.parametrize("failure", ["begin", "rollback", "release", "disconnect"])
def test_savepoint_infrastructure_failure_is_not_downgraded(monkeypatch, failure):
    from app.services.knowledge import answer_evidence as module

    db = MagicMock()
    monkeypatch.setattr(module, "require_source", lambda *a: None)
    if failure == "begin":
        db.begin_nested.side_effect = RuntimeError("begin")
    elif failure == "rollback":
        db.flush.side_effect = IntegrityError(
            "INSERT INTO knowledge_citations (...)", {}, Exception()
        )
        db.begin_nested.return_value.rollback.side_effect = RuntimeError("rollback")
    elif failure == "release":
        db.begin_nested.return_value.commit.side_effect = RuntimeError("release")
    else:
        db.flush.side_effect = IntegrityError(
            "INSERT INTO knowledge_citations (...)",
            {},
            Exception(),
            connection_invalidated=True,
        )
    unit = {
        "evidence_id": "b" * 32,
        "content": "证据",
        "source": "资料",
        "knowledge_base_id": 7,
        "document_id": 9,
    }
    answer = SimpleNamespace(id=12, user_id=3, answer_generation_id="a" * 32)
    with pytest.raises((RuntimeError, IntegrityError)):
        bind_answer_evidence(
            db,
            answer,
            {
                "value": f"结论[[evidence:{'b' * 32}]]",
                "_answer_evidence": TrustedEvidence([unit], user_id=3),
            },
        )


def test_markers_inside_code_links_and_html_do_not_issue_snapshots():
    from shared.utils.evidence_markers import rewrite_markers

    source = "`[[evidence:a]]` [link [[evidence:b]]](https://example.com) <b>[[evidence:c]]</b> [[evidence:d]]"
    seen = []
    output = rewrite_markers(source, lambda value: seen.append(value) or "bound")
    assert seen == ["d"]
    assert output.endswith(" bound")


@pytest.mark.parametrize(
    "answer_access,source_access",
    [(False, False), (False, True), (True, False), (True, True)],
)
def test_read_requires_both_independent_permissions(
    monkeypatch, answer_access, source_access
):
    from fastapi import HTTPException

    from app.models.subtask import SubtaskStatus
    from app.services.knowledge import answer_evidence as module

    row = SimpleNamespace(
        id=42,
        content="private snapshot",
        title="资料",
        caller_context={
            "answer_evidence": {
                "answer_id": 12,
                "generation_id": "a" * 32,
                "local_id": "b",
            }
        },
        knowledge_base_id=7,
        document_id=9,
        source_chunk_id="",
        created_at=None,
    )
    db = MagicMock()
    db.get.return_value = row
    answer = SimpleNamespace(
        task_id=5,
        answer_generation_id="a" * 32,
        status=SubtaskStatus.COMPLETED,
        role="ASSISTANT",
    )
    monkeypatch.setattr(module.subtask_store, "get_by_id", lambda *a, **k: answer)
    monkeypatch.setattr(module.task_access_store, "get_task", lambda *a, **k: object())
    monkeypatch.setattr(
        module.task_access_store, "is_member", lambda *a, **k: answer_access
    )

    def source(*args):
        if not source_access:
            raise HTTPException(403)

    monkeypatch.setattr(module, "require_source", source)
    if answer_access and source_access:
        assert (
            module.read_citation(db, 3, 42, 12, "a" * 32)["content"]
            == "private snapshot"
        )
    else:
        with pytest.raises(HTTPException) as error:
            module.read_citation(db, 3, 42, 12, "a" * 32)
        assert error.value.status_code == 403


@pytest.mark.parametrize(
    "change", ["deleted", "disabled", "external", "moved", "unindexed", "external-kb"]
)
def test_current_source_must_remain_native_available_and_indexed(monkeypatch, change):
    from fastapi import HTTPException

    from app.models.knowledge import DocumentIndexStatus, DocumentStatus
    from app.services.knowledge import answer_evidence as module

    db = MagicMock()
    kb = SimpleNamespace(is_active=True, json={"spec": {}})
    document = SimpleNamespace(
        kind_id=7,
        is_active=True,
        status=DocumentStatus.ENABLED,
        source_type="text",
        index_status=DocumentIndexStatus.SUCCESS,
    )
    if change == "deleted":
        document = None
    elif change == "disabled":
        document.status = DocumentStatus.DISABLED
    elif change == "external":
        document.source_type = "external"
    elif change == "moved":
        document.kind_id = 8
    elif change == "unindexed":
        document.index_status = DocumentIndexStatus.FAILED
    else:
        kb.json = {"spec": {"source": {"type": "external"}}}
    db.query.return_value.filter.return_value.first.side_effect = [kb, document]
    monkeypatch.setattr(
        module, "can_directly_access_knowledge_base", lambda *a, **k: True
    )
    with pytest.raises(HTTPException) as error:
        module.require_source(db, 3, 7, 9)
    assert error.value.status_code == 409


@pytest.mark.parametrize(
    "change", ["answer", "generation", "binding", "identity", "status"]
)
def test_binding_or_current_attempt_mismatch_never_reads_content(monkeypatch, change):
    from fastapi import HTTPException

    from app.models.subtask import SubtaskStatus
    from app.services.knowledge import answer_evidence as module

    binding = {"answer_id": 12, "generation_id": "a" * 32, "local_id": "b"}
    answer = SimpleNamespace(
        task_id=5,
        role="ASSISTANT",
        answer_generation_id="a" * 32,
        status=SubtaskStatus.COMPLETED,
        result={"answer_generation_id": "a" * 32},
    )
    if change == "answer":
        binding["answer_id"] = 13
    if change == "generation":
        binding["generation_id"] = "c" * 32
    if change == "binding":
        binding.pop("local_id")
    if change == "identity":
        answer.answer_generation_id = "c" * 32
    if change == "status":
        answer.status = SubtaskStatus.RUNNING
    db = MagicMock()
    db.get.return_value = SimpleNamespace(caller_context={"answer_evidence": binding})
    monkeypatch.setattr(module.subtask_store, "get_by_id", lambda *a, **k: answer)
    monkeypatch.setattr(module.task_access_store, "get_task", lambda *a, **k: object())
    monkeypatch.setattr(module.task_access_store, "is_member", lambda *a, **k: True)
    with pytest.raises(HTTPException) as error:
        module.read_citation(db, 3, 42, 12, "a" * 32)
    assert error.value.status_code == 404


def test_rejected_conditional_answer_write_rolls_back_inserted_evidence(monkeypatch):
    from contextlib import contextmanager

    from app.models.subtask import SubtaskStatus
    from app.services.chat.storage import db as storage
    from app.services.chat.storage.answer_attempt import AnswerSaveResult
    from app.services.knowledge import answer_evidence as module

    db = MagicMock()
    answer = MagicMock(
        id=12,
        user_id=3,
        task_id=7,
        answer_generation_id="a" * 32,
        status=SubtaskStatus.RUNNING,
        result=None,
        executor_name=None,
    )

    @contextmanager
    def session():
        yield db
        db.commit()

    monkeypatch.setattr(storage, "_db_session", session)
    monkeypatch.setattr(
        storage.task_stores.subtask_store, "get_by_id", lambda *a, **k: answer
    )
    monkeypatch.setattr(
        storage.task_stores.subtask_store,
        "update_fields_if_attempt",
        lambda *a, **k: False,
    )
    monkeypatch.setattr(module, "require_source", lambda *a: None)

    def assign_id(row):
        row.id = 42

    db.add.side_effect = assign_id
    unit = {
        "evidence_id": "b" * 32,
        "content": "证据",
        "source": "资料",
        "knowledge_base_id": 7,
        "document_id": 9,
    }
    outcome = storage.DatabaseHandler()._update_subtask_sync(
        12,
        "COMPLETED",
        generation_id="a" * 32,
        expected_status="RUNNING",
        result={
            "value": f"结论[[evidence:{'b' * 32}]]",
            "_answer_evidence": TrustedEvidence([unit], user_id=3),
        },
    )
    assert outcome is AnswerSaveResult.REJECTED
    db.rollback.assert_called_once()


def test_read_dependency_failure_is_retryable_and_does_not_leak(caplog, monkeypatch):
    from fastapi import HTTPException, Response

    from app.api.endpoints import knowledge_citations as api

    def broken(*args):
        raise RuntimeError("secret body and SQL parameters")

    monkeypatch.setattr(api, "read_citation", broken)
    with pytest.raises(HTTPException) as error:
        api.get_citation(
            Response(), 42, 12, "a" * 32, MagicMock(), SimpleNamespace(id=3)
        )
    assert error.value.status_code == 503
    assert error.value.detail == {"code": "CITATION_READ_FAILED"}
    assert error.value.headers["Cache-Control"] == "private, no-store"
    assert "secret body" not in caplog.text


def test_multiple_same_title_units_mixed_validation_and_duplicate_text_blocks(
    monkeypatch,
):
    from fastapi import HTTPException

    from app.services.knowledge import answer_evidence as module

    def source(db, actor, kb_id, doc_id):
        assert actor == 3
        if doc_id == 10:
            raise HTTPException(403)

    monkeypatch.setattr(module, "require_source", source)
    db = MagicMock()
    inserted = []

    def add(row):
        row.id = 40 + len(inserted)
        inserted.append(row)

    db.add.side_effect = add
    base = {"source": "同名资料", "knowledge_base_id": 7, "document_id": 9}
    units = [
        {**base, "evidence_id": "first", "content": "字" * 5000},
        {**base, "evidence_id": "second", "document_id": 11, "content": "另一原文"},
        {**base, "evidence_id": "long", "content": "字" * 5001},
        {**base, "evidence_id": "denied", "document_id": 10, "content": "不可读"},
        {**base, "evidence_id": "unused", "content": "未引用"},
        {**base, "evidence_id": "title", "content": "标题超长", "source": "字" * 1025},
        {
            **base,
            "evidence_id": "chunk",
            "content": "块超长",
            "source_chunk_id": "x" * 256,
        },
    ]
    original = {
        "value": "结论[[evidence:first]][[evidence:long]][[evidence:denied]][[citation:42]][[evidence:old]][[evidence:title]][[evidence:chunk]]",
        "blocks": [
            {
                "type": "text",
                "content": "[[evidence:first]][[evidence:second]] [[evidence:broken]",
            }
        ],
        "_answer_evidence": TrustedEvidence(units, user_id=3),
    }
    answer = SimpleNamespace(id=12, answer_generation_id="a" * 32)
    result = bind_answer_evidence(db, answer, original)
    assert len(inserted) == 2
    assert result["value"] == "结论[[citation:40]]" + "[[evidence-unavailable]]" * 6
    assert (
        result["blocks"][0]["content"]
        == "[[citation:40]][[citation:41]] [[evidence:broken]"
    )
    assert [
        (row.document_id, row.content, row.source_chunk_id) for row in inserted
    ] == [(9, "字" * 5000, ""), (11, "另一原文", "")]
    assert len(result["answer_citations"]) == 2
    assert "_answer_evidence" not in result
    assert original["value"].startswith("结论[[evidence:first]]")
    db.begin_nested.assert_called_once()
    db.commit.assert_not_called()


def test_no_reference_does_not_create_a_savepoint(monkeypatch):
    db = MagicMock()
    answer = SimpleNamespace(id=12, answer_generation_id="a" * 32)
    result = bind_answer_evidence(
        db,
        answer,
        {
            "value": "普通回答",
            "_answer_evidence": TrustedEvidence(
                [
                    {
                        "evidence_id": "unused",
                        "content": "正文",
                        "source": "资料",
                        "knowledge_base_id": 7,
                        "document_id": 9,
                    }
                ],
                user_id=3,
            ),
        },
    )
    assert result["answer_citations"] == []
    db.begin_nested.assert_not_called()
    db.add.assert_not_called()


@pytest.mark.parametrize(
    "title_length,chunk_length,accepted",
    [(1024, 255, True), (1025, 255, False), (1024, 256, False)],
)
def test_snapshot_metadata_uses_model_length_limits(
    monkeypatch, title_length, chunk_length, accepted
):
    from app.services.knowledge import answer_evidence as module

    monkeypatch.setattr(module, "require_source", lambda *args: None)
    db = MagicMock()
    db.add.side_effect = lambda row: setattr(row, "id", 42)
    answer = SimpleNamespace(id=12, answer_generation_id="a" * 32)
    unit = {
        "evidence_id": "local",
        "content": "完整原文",
        "source": "题" * title_length,
        "source_chunk_id": "c" * chunk_length,
        "knowledge_base_id": 7,
        "document_id": 9,
    }
    output = bind_answer_evidence(
        db,
        answer,
        {
            "value": "[[evidence:local]]",
            "_answer_evidence": TrustedEvidence([unit], user_id=3),
        },
    )
    assert output["value"] == (
        "[[citation:42]]" if accepted else "[[evidence-unavailable]]"
    )
    assert len(output["answer_citations"]) == int(accepted)


def test_implicit_flush_savepoint_rollback_failure_is_not_recoverable(monkeypatch):
    from sqlalchemy.exc import OperationalError

    from app.services.knowledge import answer_evidence as module

    monkeypatch.setattr(module, "require_source", lambda *args: None)
    db = MagicMock()
    # SQLAlchemy flush already attempted rollback and deactivated the savepoint.
    # A subsequent rollback() can return without sending another SQL statement.
    db.flush.side_effect = OperationalError(
        "ROLLBACK TO SAVEPOINT sa_savepoint_1", {}, Exception("private rollback error")
    )
    db.begin_nested.return_value.is_active = False
    answer = SimpleNamespace(id=12, answer_generation_id="a" * 32)
    unit = {
        "evidence_id": "local",
        "content": "私有原文",
        "source": "资料",
        "knowledge_base_id": 7,
        "document_id": 9,
    }
    with pytest.raises(OperationalError):
        bind_answer_evidence(
            db,
            answer,
            {
                "value": "[[evidence:local]]",
                "_answer_evidence": TrustedEvidence([unit], user_id=3),
            },
        )
