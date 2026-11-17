# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Verify Responses attachment linking through the real hybrid gateway."""

from __future__ import annotations

from copy import deepcopy
from io import BytesIO
from typing import TYPE_CHECKING

from PIL import Image

from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.subtask_context import SubtaskContext
from app.models.task import TaskResource

if TYPE_CHECKING:
    from tests.e2e.terminal_handoff_gateway import TerminalHandoffGateway


def assert_response_attachments(case: TerminalHandoffGateway) -> None:
    case._create_team(pipeline=False)
    attachment_ids = _upload_images(case)
    _set_attachment_status(case, attachment_ids[0], "processing")
    _assert_rejected(case, attachment_ids, [attachment_ids[0]])
    _set_attachment_status(case, attachment_ids[0], "ready")

    response = _create_response(case, attachment_ids[::-1])
    task_id = int(response["id"].removeprefix("resp_"))
    contexts = _linked_contexts(case, task_id, attachment_ids)
    captures = case._wait_for(lambda: case._model_requests() or None)
    case.assertEqual(len(captures), 1, captures)
    _assert_images(case, captures[0], contexts, attachment_ids[::-1])
    _assert_rejected(case, attachment_ids, attachment_ids)
    case.assertEqual(len(case._model_requests()), 1)

    _disable_subscription_history(case, task_id)
    resumed = _create_response(case, attachment_ids, response["id"])
    case.assertEqual(resumed["id"], response["id"])
    contexts = _linked_contexts(case, task_id, attachment_ids)
    captures = case._wait_for(
        lambda: captures if len(captures := case._model_requests()) >= 2 else None
    )
    case.assertEqual(len(captures), 2, captures)
    _assert_images(case, captures[-1], contexts, attachment_ids)


def _upload_images(case: TerminalHandoffGateway) -> list[int]:
    attachment_ids = []
    for color in ("red", "blue"):
        image = BytesIO()
        Image.new("RGB", (10, 10), color).save(image, format="PNG")
        upload = case._json(
            case.api.post(
                "/api/v1/attachments/upload",
                files={
                    "file": (
                        f"{case.marker}-{color}.png",
                        image.getvalue(),
                        "image/png",
                    )
                },
            ),
            201,
        )
        attachment_ids.append(int(upload["id"]))
    return attachment_ids


def _set_attachment_status(
    case: TerminalHandoffGateway, attachment_id: int, status: str
) -> None:
    with SessionLocal() as db:
        db.query(SubtaskContext).filter(
            SubtaskContext.id == attachment_id,
            SubtaskContext.user_id == case.user_id,
        ).update({"status": status})
        db.commit()


def _create_response(
    case: TerminalHandoffGateway,
    attachment_ids: list[int],
    previous_response_id: str | None = None,
) -> dict:
    body = {
        "model": f"default#{case.marker}",
        "input": "Analyze the uploaded images",
        "attachment_ids": attachment_ids,
    }
    if previous_response_id is not None:
        body["previous_response_id"] = previous_response_id
    return case._json(case.api.post("/api/v1/responses", json=body))


def _linked_contexts(
    case: TerminalHandoffGateway, task_id: int, attachment_ids: list[int]
) -> dict[int, SubtaskContext]:
    _, rows = case._snapshot(task_id)
    with SessionLocal() as db:
        contexts = (
            db.query(SubtaskContext)
            .filter(
                SubtaskContext.id.in_(attachment_ids),
                SubtaskContext.user_id == case.user_id,
            )
            .all()
        )
        contexts = {context.id: context for context in contexts}
        case.assertEqual(set(contexts), set(attachment_ids))
        for context in contexts.values():
            case.assertEqual(context.subtask_id, rows[-2]["id"], rows)
            case.assertEqual(context.context_type, "attachment")
            case.assertEqual(context.status, "ready")
            case.assertTrue(context.image_base64, "image attachment must be parsed")
    return contexts


def _assert_images(
    case: TerminalHandoffGateway,
    capture: dict,
    contexts: dict[int, SubtaskContext],
    attachment_ids: list[int],
) -> None:
    user_messages = [
        message
        for message in capture["body"]["messages"]
        if message.get("role") == "user"
    ]
    image_blocks = [
        block
        for message in user_messages
        for block in message.get("content", [])
        if block.get("type") == "image_url"
    ]
    case.assertEqual(len(image_blocks), 2, capture)
    case.assertEqual(
        [block["image_url"]["url"] for block in image_blocks],
        [
            f"data:image/png;base64,{contexts[attachment_id].image_base64}"
            for attachment_id in attachment_ids
        ],
    )


def _assert_rejected(
    case: TerminalHandoffGateway, attachment_ids: list[int], invalid_ids: list[int]
) -> None:
    with SessionLocal() as db:
        before = (
            db.query(SubtaskContext.id, SubtaskContext.subtask_id)
            .filter(
                SubtaskContext.id.in_(attachment_ids),
                SubtaskContext.user_id == case.user_id,
            )
            .order_by(SubtaskContext.id)
            .all()
        )
        task_count = (
            db.query(TaskResource).filter(TaskResource.user_id == case.user_id).count()
        )
    rejected = case._json(
        case.api.post(
            "/api/v1/responses",
            json={
                "model": f"default#{case.marker}",
                "input": "Reject these attachments",
                "attachment_ids": attachment_ids,
            },
        ),
        403,
    )
    case.assertEqual(
        rejected["detail"],
        f"Invalid or unauthorized attachment IDs: {sorted(invalid_ids)}",
    )
    with SessionLocal() as db:
        after = (
            db.query(SubtaskContext.id, SubtaskContext.subtask_id)
            .filter(
                SubtaskContext.id.in_(attachment_ids),
                SubtaskContext.user_id == case.user_id,
            )
            .order_by(SubtaskContext.id)
            .all()
        )
        case.assertEqual(after, before)
        case.assertEqual(
            db.query(TaskResource).filter(TaskResource.user_id == case.user_id).count(),
            task_count,
        )


def _disable_subscription_history(case: TerminalHandoffGateway, task_id: int) -> None:
    with SessionLocal() as db:
        subscription = Kind(
            user_id=case.user_id,
            kind="Subscription",
            name=case.marker,
            namespace="default",
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Subscription",
                "metadata": {"name": case.marker, "namespace": "default"},
                "spec": {
                    "enabled": False,
                    "preserveHistory": False,
                    "historyMessageCount": 0,
                },
            },
        )
        db.add(subscription)
        db.flush()
        task = (
            db.query(TaskResource)
            .filter(TaskResource.id == task_id, TaskResource.user_id == case.user_id)
            .one()
        )
        document = deepcopy(task.json)
        document["metadata"]["labels"].update(
            {"type": "subscription", "subscriptionId": str(subscription.id)}
        )
        task.json = document
        db.commit()
