"""Batch readers must retain authorization without nesting pooled Sessions."""

from datetime import datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import QueuePool

from app.db.base import Base
from app.mcp_server.auth import MCPAuthInfo
from app.mcp_server.tools import wework_space
from app.mcp_server.tools.wework_space_batch import dispatch
from app.models.delivery import Delivery, LoopItemAttachment
from app.models.user import User
from tests.mcp_server.test_wework_space import _project
from tests.mcp_server.test_wework_space_batch import add_items


@pytest.fixture
def single_connection_board(tmp_path, monkeypatch: pytest.MonkeyPatch):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'batch.sqlite'}",
        poolclass=QueuePool,
        pool_size=1,
        max_overflow=0,
        pool_timeout=0.01,
    )
    factory = sessionmaker(engine, expire_on_commit=False)
    try:
        Base.metadata.create_all(engine)
        with factory() as db:
            users = [
                User(
                    user_name=name,
                    password_hash="unused-test-hash",
                    email=f"{name}@example.com",
                    is_active=True,
                )
                for name in ("candidate-owner", "candidate-outsider")
            ]
            db.add_all(users)
            db.commit()
            owner, outsider = users
            project = _project(db, owner, provider="local")
            board = SimpleNamespace(
                engine=engine,
                factory=factory,
                project=project,
                owner=owner,
                space={"project_store": "backend", "space_id": str(project.id)},
                token=MCPAuthInfo(owner.id, owner.user_name, "user"),
                denied_token=MCPAuthInfo(outsider.id, outsider.user_name, "user"),
            )
        monkeypatch.setattr(wework_space, "SessionLocal", factory)
        yield board
        assert engine.pool.checkedout() == 0
    finally:
        engine.dispose()


def test_assignment_candidates_reuse_one_connection_and_preserve_access(
    single_connection_board,
):
    board = single_connection_board
    expected = wework_space.get_assignment_candidates(
        board.token, board.space["space_id"]
    )
    assert expected["members"] == [
        {
            "id": board.owner.id,
            "name": board.owner.user_name,
            "role": "Maintainer",
            "capability": "",
        }
    ]
    assert expected["robots"] == []
    assert expected["groups"] == []
    for types in (None, ["user"]):
        result = dispatch(
            "batch_get_assignment_candidates",
            board.token,
            {
                "spaces": [board.space, board.space],
                **({"types": types} if types else {}),
            },
        )
        assert result["counts"]["succeeded"] == 2, result
        assert result["counts"]["failed"] == 0
        assert [entry["request_id"] for entry in result["results"]] == ["0", "1"]
        for entry in result["results"]:
            assert entry["space"] == board.space
            assert entry["result"] == (
                expected if types is None else {"members": expected["members"]}
            )
    denied = dispatch(
        "batch_get_assignment_candidates", board.denied_token, {"spaces": [board.space]}
    )
    assert denied["counts"]["failed"] == 1
    assert denied["results"][0]["error"]["code"] == "not_found"
    assert "result" not in denied["results"][0]


def section_items(board):
    with board.factory() as db:
        parent, child = add_items(db, board.project, board.owner, 2)
        child.parent_id = parent.id
        for item in (parent, child):
            db.add(
                LoopItemAttachment(
                    id=f"attachment-{item.id}",
                    loop_item_id=item.id,
                    cloud_project_id=str(board.project.id),
                    display_name="evidence.txt",
                    content_type="text/plain",
                    size_bytes=8,
                    sha256="a" * 64,
                    created_by_user_id=board.owner.id,
                )
            )
            db.add(
                Delivery(
                    id=f"delivery-{item.id}",
                    loop_item_id=item.id,
                    cloud_project_id=str(board.project.id),
                    title="Delivered evidence",
                    created_by_user_id=board.owner.id,
                    status="delivered",
                    delivered_at=datetime(2026, 1, 1),
                    metadata_json={},
                )
            )
        db.commit()
        return parent, child


def details(board, token, items):
    return dispatch(
        "batch_get_board_items",
        token,
        {
            "items": [
                {
                    "request_id": item.id,
                    "target": {"space": board.space, "item_id": item.id},
                }
                for item in items
            ],
            "include": ["permissions", "attachment_metadata", "delivery_summaries"],
        },
    )


def test_optional_sections_reuse_one_connection_and_preserve_nonmember_denial(
    single_connection_board,
):
    board = single_connection_board
    items = section_items(board)
    expected = {
        item.id: {
            "attachment_metadata": wework_space.list_item_attachments(
                board.token, board.space["space_id"], item.id
            ),
            "delivery_summaries": wework_space.list_deliveries(
                board.token, board.space["space_id"], item.id
            ),
        }
        for item in items
    }
    result = details(board, board.token, items)
    assert result["counts"]["succeeded"] == 2
    for entry in result["results"]:
        sections = entry["result"]["sections"]
        assert sections["permissions"]["state"] == "complete"
        for name in ("attachment_metadata", "delivery_summaries"):
            assert sections[name]["state"] == "complete", result
            assert sections[name]["value"] == expected[entry["request_id"]][name]
            assert len(sections[name]["value"]) == 1
    denied = details(board, board.denied_token, items)
    assert denied["counts"]["failed"] == 2
    assert all(entry["error"]["code"] == "not_found" for entry in denied["results"])
    assert all("result" not in entry for entry in denied["results"])


def test_optional_sections_keep_executor_parent_attachment_denial(
    single_connection_board, monkeypatch
):
    board = single_connection_board
    parent, child = section_items(board)
    token = MCPAuthInfo(
        board.owner.id, board.owner.user_name, "task", task_id=1, subtask_id=2
    )
    monkeypatch.setattr(
        wework_space,
        "_board_context",
        lambda *_: {
            "space_id": board.space["space_id"],
            "item_id": child.id,
            "dispatch_role": "executor",
        },
    )
    result = details(board, token, [parent, child])
    assert result["counts"]["succeeded"] == 2
    parent_sections = result["results"][0]["result"]["sections"]
    assert parent_sections["attachment_metadata"] == {"state": "unavailable"}
    assert parent_sections["delivery_summaries"]["state"] == "complete"
    assert (
        parent_sections["delivery_summaries"]["value"][0]["id"]
        == f"delivery-{parent.id}"
    )
    child_sections = result["results"][1]["result"]["sections"]
    assert child_sections["attachment_metadata"]["state"] == "complete"
    assert (
        child_sections["attachment_metadata"]["value"][0]["id"]
        == f"attachment-{child.id}"
    )
    assert child_sections["delivery_summaries"]["state"] == "complete"


def test_optional_section_failure_retains_other_section_coverage(
    single_connection_board, monkeypatch
):
    board = single_connection_board
    parent, _ = section_items(board)

    def unavailable(*_args):
        raise RuntimeError("Attachment source unavailable")

    monkeypatch.setattr(wework_space, "_item_attachments", unavailable)
    result = details(board, board.token, [parent])
    assert result["counts"]["succeeded"] == 1
    sections = result["results"][0]["result"]["sections"]
    assert sections["attachment_metadata"] == {"state": "unavailable"}
    assert sections["permissions"]["state"] == "complete"
    assert sections["delivery_summaries"]["state"] == "complete"
    assert sections["delivery_summaries"]["value"][0]["id"] == f"delivery-{parent.id}"
