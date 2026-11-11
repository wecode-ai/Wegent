"""Project ordering must not authorize writes from an older RR grant snapshot."""

from fastapi import HTTPException
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from tests.integration.thread_classification_mysql import _seed


def verify_project_board_order(engine: Engine) -> None:
    from app.models.delivery import (
        CloudProject,
        CollaborationChatGroup,
        LoopItem,
        ThreadProjectLink,
    )
    from app.models.resource_member import ResourceMember
    from app.schemas.delivery import LoopItemUpdate
    from app.services.loop_items.service import loop_item_service

    for index, mode in enumerate(("anchor", "moving"), 9000):
        project_id, group_id, _ = _seed(engine, index, "direct")
        anchor_group = str(830000 + index)
        moving_id, anchor_id = f"PBO-{mode}-M", f"PBO-{mode}-A"
        with Session(engine) as db:
            db.add(
                CollaborationChatGroup(
                    id=anchor_group,
                    project_key=f"PBO{index}",
                    name="Readable anchor group",
                    status="active",
                    created_by_user_id=1,
                )
            )
            db.flush()
            db.add(
                ResourceMember(
                    resource_type="CollaborationChatGroup",
                    resource_id=int(anchor_group),
                    entity_type="user",
                    entity_id="2",
                    user_id=1,
                    role="Viewer",
                    status="approved",
                )
            )
            db.add_all(
                [
                    LoopItem(
                        id=moving_id,
                        cloud_project_id=group_id,
                        title="Moving",
                        status="completed",
                        created_by_user_id=2,
                        version=1,
                    ),
                    LoopItem(
                        id=anchor_id,
                        cloud_project_id=anchor_group,
                        title="Anchor",
                        status="pending",
                        created_by_user_id=1,
                        version=1,
                    ),
                ]
            )
            db.flush()
            db.add_all(
                [
                    ThreadProjectLink(
                        parent_id=project_id, loop_item_id=identity, status="active"
                    )
                    for identity in (moving_id, anchor_id)
                ]
            )
            db.commit()
        with Session(engine) as reader:
            reader.connection(execution_options={"isolation_level": "REPEATABLE READ"})
            assert loop_item_service.get(reader, moving_id, 2).version == 1
            assert loop_item_service.get(reader, anchor_id, 2).version == 1
            before = dict(reader.get(CloudProject, project_id).metadata_json or {})
            with Session(engine) as writer:
                grant = (
                    writer.query(ResourceMember)
                    .filter_by(
                        resource_type="CollaborationChatGroup",
                        resource_id=int(anchor_group if mode == "anchor" else group_id),
                        entity_type="user",
                        entity_id="2",
                    )
                    .one()
                )
                if mode == "anchor":
                    grant.status = "rejected"
                else:
                    grant.role = "Viewer"
                writer.commit()
            try:
                loop_item_service.update(
                    reader,
                    moving_id,
                    2,
                    LoopItemUpdate(
                        version=1,
                        status="pending",
                        position={
                            "beforeItemId": anchor_id,
                            "classificationProjectId": project_id,
                        },
                    ),
                )
            except HTTPException as rejected:
                assert rejected.status_code in (403, 404, 422)
            else:
                raise AssertionError(f"Project ordering reused a stale {mode} grant")
            reader.rollback()
            assert reader.get(LoopItem, moving_id).version == 1
            assert reader.get(LoopItem, moving_id).status == "completed"
            assert (reader.get(CloudProject, project_id).metadata_json or {}) == before
