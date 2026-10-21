"""Set task membership states for the CI-covered Rust access E2E scenario."""

import json
import os
import sys

from sqlalchemy.engine import make_url


def main() -> None:
    # Never fall back to a developer database for a test fixture.
    url = make_url(os.environ["DATABASE_URL"])
    if url.get_backend_name() != "mysql" or url.database != "wegent_test":
        raise RuntimeError(
            "Task member fixture requires the isolated MySQL wegent_test database"
        )

    from app.db.session import SessionLocal
    from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
    from app.models.share_link import ResourceType
    from app.models.task import TaskResource
    from app.models.user import User

    data = json.load(sys.stdin)
    state = data["state"]
    if state not in {"absent", "pending", "approved", "rejected", "copied"}:
        raise ValueError(f"Unsupported task member state: {state}")

    task_id = int(data["task_id"])
    owner_username = str(data["owner_username"])
    member_user_id = int(data["member_user_id"])
    member_username = str(data["member_username"])

    with SessionLocal() as db:
        owner = db.query(User).filter_by(user_name=owner_username).one()
        member = db.query(User).filter_by(id=member_user_id).one()
        if member.user_name != member_username:
            raise RuntimeError("Task member fixture user identity mismatch")

        db.query(TaskResource).filter_by(
            id=task_id,
            kind="Task",
            user_id=owner.id,
        ).one()

        membership = (
            db.query(ResourceMember)
            .filter_by(
                resource_type=ResourceType.TASK,
                resource_id=task_id,
                entity_type="user",
                entity_id=str(member_user_id),
            )
            .one_or_none()
        )

        if state == "absent":
            if membership is not None:
                db.delete(membership)
        else:
            if membership is None:
                membership = ResourceMember.create(
                    resource_type=ResourceType.TASK,
                    resource_id=task_id,
                    entity_id=str(member_user_id),
                    role=ResourceRole.Maintainer.value,
                    invited_by_user_id=owner.id,
                )
                db.add(membership)

            membership.status = (
                MemberStatus.APPROVED.value
                if state in {"approved", "copied"}
                else state
            )
            membership.copied_resource_id = task_id if state == "copied" else 0

        db.commit()
        print(json.dumps({"state": state, "task_id": task_id}))


if __name__ == "__main__":
    main()
