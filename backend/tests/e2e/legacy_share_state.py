"""Fixtures for the CI-covered real share authorization browser scenario."""

import json
import os
import sys
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import or_
from sqlalchemy.engine import make_url


def build_shared_resource(name: str, kind: str) -> dict[str, Any]:
    """Build the resource document persisted by the share regression fixture."""
    resource: dict[str, Any] = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": kind,
        "metadata": {"name": name, "namespace": "default"},
        "spec": {"name": name, "members": []},
    }
    if kind == "Team":
        from app.schemas.kind import Team

        resource["spec"]["collaborationModel"] = "solo"
        Team.model_validate(resource)
    return resource


def main() -> None:
    url = make_url(os.environ["DATABASE_URL"])
    if url.get_backend_name() != "mysql" or url.database != "wegent_test":
        raise RuntimeError("Share fixture requires the isolated MySQL wegent_test DB")
    data = json.load(sys.stdin)
    prefix = data["prefix"]
    if not prefix.startswith("e2e-legacy-share-"):
        raise ValueError("Unexpected fixture prefix")

    from app.db.session import SessionLocal
    from app.models.kind import Kind
    from app.models.resource_member import ResourceMember
    from app.models.share_link import ShareLink
    from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
    from app.models.subtask_context import SubtaskContext
    from app.models.task import TaskResource
    from app.models.user import User
    from app.services.share.token_access import hash_share_token

    with SessionLocal() as db:
        owner = db.query(User).filter_by(user_name=data["owner"]).one()
        viewer = db.query(User).filter_by(user_name=data["viewer"]).one()
        task = (
            db.query(TaskResource)
            .filter_by(user_id=owner.id, kind="Task", name=prefix)
            .one_or_none()
        )
        resources = (
            db.query(Kind)
            .filter(Kind.user_id == owner.id, Kind.name.like(f"{prefix}%"))
            .all()
        )
        operation = data["operation"]
        if operation == "seed":
            if task or resources:
                raise RuntimeError("Fixture already exists")
            resources = [
                Kind(
                    user_id=owner.id,
                    kind=kind,
                    name=f"{prefix}-{kind}",
                    namespace="default",
                    is_active=True,
                    json=build_shared_resource(f"{prefix}-{kind}", kind),
                )
                for kind in ("Team", "KnowledgeBase")
            ]
            db.add_all(resources)
            db.flush()
            task = TaskResource(
                user_id=owner.id,
                kind="Task",
                name=prefix,
                namespace="default",
                is_active=TaskResource.STATE_ACTIVE,
                client_origin="frontend",
                is_group_chat=True,
                json={
                    "apiVersion": "agent.wecode.io/v1",
                    "kind": "Task",
                    "metadata": {"name": prefix, "namespace": "default"},
                    "spec": {
                        "title": prefix,
                        "prompt": prefix,
                        "teamRef": {"name": resources[0].name, "namespace": "default"},
                        "workspaceRef": {"name": prefix, "namespace": "default"},
                    },
                    "status": {"state": "Available", "status": "COMPLETED"},
                },
            )
            db.add(task)
            db.flush()
            subtask = Subtask(
                user_id=owner.id,
                task_id=task.id,
                team_id=resources[0].id,
                title=prefix,
                bot_ids=[],
                role=SubtaskRole.USER,
                prompt=f"{prefix}-private-body",
                status=SubtaskStatus.COMPLETED,
            )
            db.add(subtask)
            db.flush()
            context = SubtaskContext(
                user_id=owner.id,
                subtask_id=subtask.id,
                context_type="attachment",
                name=f"{prefix}.txt",
                status="ready",
                binary_data=b"fixture",
                type_data={
                    "file_extension": "txt",
                    "mime_type": "text/plain",
                    "file_size": 7,
                    "storage_backend": "mysql",
                },
            )
            db.add(context)
            unlinked = SubtaskContext(
                user_id=owner.id,
                subtask_id=0,
                context_type="attachment",
                name=f"{prefix}-unlinked.txt",
                status="ready",
            )
            db.add(unlinked)
            db.flush()
            tokens = {}
            entries = [
                (task, "Task"),
                (task, "TaskInvite"),
                *[(resource, resource.kind) for resource in resources],
            ]
            for resource, resource_type in entries:
                token = f"{prefix}-{resource_type}%2B%3D"
                tokens[resource_type] = token
                db.add(
                    ShareLink(
                        resource_type=resource_type,
                        resource_id=resource.id,
                        created_by_user_id=owner.id,
                        share_token=token,
                        token_hash=hash_share_token(token),
                        token_version=1,
                        expires_at=datetime.utcnow() + timedelta(days=1),
                        default_role="Reporter",
                        require_approval=False,
                        is_active=True,
                    )
                )
            db.commit()
            print(
                json.dumps(
                    {
                        "task_id": task.id,
                        "team_id": resources[0].id,
                        "kb_id": resources[1].id,
                        "attachment_id": context.id,
                        "unlinked_attachment_id": unlinked.id,
                        "tokens": tokens,
                        "body": subtask.prompt,
                    }
                )
            )
            return
        if task is None:
            raise RuntimeError("Fixture task missing")
        links = (
            db.query(ShareLink)
            .filter(
                ShareLink.created_by_user_id == owner.id,
                or_(
                    (ShareLink.resource_type == "TaskShare")
                    & (ShareLink.resource_id == task.id),
                    (ShareLink.resource_type == "TaskInvite")
                    & (ShareLink.resource_id == task.id),
                    *[
                        (ShareLink.resource_type == resource.kind)
                        & (ShareLink.resource_id == resource.id)
                        for resource in [task, *resources]
                    ],
                ),
            )
            .all()
        )
        if operation == "old-writer":
            # Simulate rows written without the new fields after migration.
            for link in links:
                if link.token_version == 1:
                    link.token_hash = None
            db.commit()
            print(json.dumps({"operation": operation}))
            return
        if operation in ("approved", "rejected"):
            for resource in [task, *resources]:
                member = (
                    db.query(ResourceMember)
                    .filter_by(
                        resource_type=resource.kind,
                        resource_id=resource.id,
                        entity_type="user",
                        entity_id=str(viewer.id),
                    )
                    .one_or_none()
                )
                if member is None:
                    member = ResourceMember(
                        resource_type=resource.kind,
                        resource_id=resource.id,
                        entity_type="user",
                        entity_id=str(viewer.id),
                        user_id=viewer.id,
                        role="Reporter",
                        copied_resource_id=0,
                    )
                    db.add(member)
                member.status = operation
        elif operation in ("expired", "revoked"):
            for link in links:
                if operation == "expired":
                    link.expires_at = datetime.utcnow() - timedelta(days=1)
                else:
                    link.is_active = False
        elif operation == "cleanup":
            for link in links:
                db.delete(link)
            db.query(ResourceMember).filter(
                or_(
                    *[
                        (ResourceMember.resource_type == resource.kind)
                        & (ResourceMember.resource_id == resource.id)
                        for resource in [task, *resources]
                    ]
                ),
                ResourceMember.entity_id == str(viewer.id),
            ).delete(synchronize_session=False)
            subtasks = db.query(Subtask).filter_by(task_id=task.id).all()
            db.query(SubtaskContext).filter(
                or_(
                    SubtaskContext.subtask_id.in_([row.id for row in subtasks]),
                    (SubtaskContext.user_id == owner.id)
                    & (SubtaskContext.subtask_id == 0)
                    & (SubtaskContext.name == f"{prefix}-unlinked.txt"),
                )
            ).delete(synchronize_session=False)
            for row in [*subtasks, task, *resources]:
                db.delete(row)
        else:
            raise ValueError("Unknown fixture operation")
        db.commit()
        print(json.dumps({"operation": operation}))


if __name__ == "__main__":
    main()
