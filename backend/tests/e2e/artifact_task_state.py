# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Arrange and inspect only artifacts belonging to an owned E2E device."""

import json
import os

from app.db.session import SessionLocal
from app.models.subtask_context import SubtaskContext
from app.services.device_service import device_service
from app.stores.tasks import subtask_store
from shared.models.db.enums import SubtaskRole


def main() -> None:
    if not os.environ.get("DATABASE_URL"):
        raise RuntimeError("Artifact E2E requires the isolated service DATABASE_URL")
    request = json.loads(os.environ["WEGENT_ARTIFACT_E2E_REQUEST"])
    device_id = request["expected_device_id"]
    if not device_id.startswith("e2e-artifact-"):
        raise ValueError("Only E2E-owned device artifacts may be inspected")
    with SessionLocal() as db:
        device = device_service.get_device_by_device_id(
            db, request["user_id"], device_id
        )
        if device is None:
            raise ValueError("The requested E2E device is not owned by this user")
        context = (
            db.query(SubtaskContext)
            .filter_by(
                id=request["context_id"],
                user_id=request["user_id"],
                context_type="remote_workspace_artifact",
            )
            .one()
        )
        source = context.type_data["source"]
        if source["executor_name"] != f"device-app-record-{device.id}":
            raise ValueError("Artifact does not belong to the requested E2E device")
        subtask = subtask_store.get_by_id_and_role(
            db,
            subtask_id=context.subtask_id,
            owner_user_id=request["user_id"],
            role=SubtaskRole.ASSISTANT,
        )
        if subtask is None or subtask.task_id != request["task_id"]:
            raise ValueError("Artifact task identity does not match")
        if request["operation"] == "rebind":
            replacement = request["replacement_device_id"]
            if not replacement.startswith("e2e-artifact-"):
                raise ValueError("Replacement must also be an E2E-owned device")
            replacement_device = device_service.get_device_by_device_id(
                db, request["user_id"], replacement
            )
            if replacement_device is None:
                raise ValueError("Replacement device is not owned by this user")
            subtask_store.update_fields(
                db,
                subtask=subtask,
                executor_name=f"device-app-record-{replacement_device.id}",
            )
            db.commit()
        elif request["operation"] != "inspect":
            raise ValueError("Unknown artifact E2E fixture operation")
        print(
            json.dumps(
                {
                    "task_id": subtask.task_id,
                    "subtask_id": context.subtask_id,
                    "executor_name": subtask.executor_name,
                    "source": source,
                    "binary_size": len(context.binary_data or b""),
                    "image_base64": context.image_base64 or "",
                    "extracted_text": context.extracted_text or "",
                }
            )
        )


if __name__ == "__main__":
    main()
