"""Committed receipt projections retain independent results and current authority."""

import copy
from datetime import datetime
from typing import Any

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import OperationalError

from app.mcp_server.tools import wework_space
from app.mcp_server.tools.wework_space_batch import dispatch
from app.models.delivery import LoopItem, LoopNode
from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.services.board_tools import writes
from tests.mcp_server.test_wework_space_batch import add_items, board  # noqa: F401


def update_request(items: list[LoopItem], space: dict[str, str]) -> dict[str, Any]:
    return {
        "operation_key": "receipt-visibility",
        "items": [
            {
                "request_id": str(index),
                "target": {"space": space, "item_id": item.id},
                "expected_version": 1,
                "patch": {"title": f"Committed {index}"},
            }
            for index, item in enumerate(items)
        ],
    }


@pytest.mark.parametrize("delete_before_initial_response", [False, True])
def test_deleted_item_redacts_only_its_projection_without_replay(
    board, test_db, test_user, monkeypatch, delete_before_initial_response
):
    project, token, space = board
    items = add_items(test_db, project, test_user, 2)
    request = update_request(items, space)
    original_view = writes._view

    def delete_then_view(db, caller, row):
        items[0].deleted_at = datetime.now()
        db.commit()
        return original_view(db, caller, row)

    with monkeypatch.context() as patcher:
        if delete_before_initial_response:
            patcher.setattr(writes, "_view", delete_then_view)
        initial = dispatch("batch_update_board_items", token, request)
    operation_id = initial["operation_id"]
    row = test_db.get(LoopNode, operation_id)
    original_metadata = copy.deepcopy(row.metadata_json)
    if not delete_before_initial_response:
        items[0].deleted_at = datetime.now()
        test_db.commit()

    receipt = dispatch("get_board_operation", token, {"operation_id": operation_id})

    assert receipt["state"] == "completed"
    assert receipt["counts"]["succeeded"] == 2
    assert receipt["counts"]["failed"] == 0
    assert receipt["results"][0] == {
        "request_id": "0",
        "state": "succeeded",
        "committed": True,
        "error": {
            "code": "result_unavailable",
            "message": "Committed result is unavailable under current access",
            "retryable": False,
        },
    }
    assert receipt["results"][1] == original_metadata["results"][1]
    assert items[0].id not in str(receipt)
    assert "Committed 0" not in str(receipt)
    if delete_before_initial_response:
        assert initial == receipt
    assert dispatch("batch_update_board_items", token, request) == receipt
    assert (
        dispatch(
            "get_board_operation", token, {"operation_key": request["operation_key"]}
        )
        == receipt
    )
    assert (
        test_db.query(LoopItem).filter_by(cloud_project_id=str(project.id)).count() == 2
    )
    assert [test_db.get(LoopItem, item.id).version for item in items] == [2, 2]
    assert test_db.get(LoopNode, operation_id).metadata_json == original_metadata

    items[0].deleted_at = None
    items[0].title = "Later visible content"
    items[0].version = 3
    test_db.commit()
    restored = dispatch("get_board_operation", token, {"operation_id": operation_id})
    assert restored["results"] == original_metadata["results"]
    assert restored["results"][0]["result"]["title"] == "Committed 0"
    assert restored["results"][0]["item_version"] == 2


def test_revoked_project_membership_still_hides_the_whole_receipt(
    board, test_db, test_user, test_admin_user
):
    project, token, space = board
    # Keep this caller's access in the direct grant, not inherited space ownership.
    workspace = test_db.get(Kind, int(project.workspace_id))
    workspace.user_id = test_admin_user.id
    test_db.commit()
    items = add_items(test_db, project, test_user, 2)
    request = update_request(items, space)
    committed = dispatch("batch_update_board_items", token, request)
    member = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="CloudProject",
            resource_id=int(project.id),
            entity_type="user",
            entity_id=str(test_user.id),
        )
        .one()
    )
    member.status = "rejected"
    test_db.commit()

    for name, arguments in [
        ("get_board_operation", {"operation_id": committed["operation_id"]}),
        ("batch_update_board_items", request),
    ]:
        with pytest.raises(HTTPException) as denied:
            dispatch(name, token, arguments)
        assert denied.value.status_code == 404
        assert "Committed" not in str(denied.value.detail)
    member.status = "approved"
    test_db.commit()
    assert (
        dispatch(
            "get_board_operation", token, {"operation_id": committed["operation_id"]}
        )
        == committed
    )
    assert [item.version for item in items] == [2, 2]


def test_receipt_projection_does_not_mask_database_failures(
    board, test_db, test_user, monkeypatch
):
    project, token, space = board
    items = add_items(test_db, project, test_user, 1)
    committed = dispatch(
        "batch_update_board_items", token, update_request(items, space)
    )
    error = OperationalError("SELECT loop_items", {}, RuntimeError("connection failed"))

    def broken_read(*_args, **_kwargs):
        raise error

    monkeypatch.setattr(wework_space, "_read_item", broken_read)
    with pytest.raises(OperationalError) as failed:
        dispatch(
            "get_board_operation", token, {"operation_id": committed["operation_id"]}
        )
    assert failed.value is error
