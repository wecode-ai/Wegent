"""A revoked resource must not survive a previously established RR read view."""

from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    CollaborationChatGroup,
    LoopItem,
    ProjectChatAgent,
)
from app.models.resource_member import ResourceMember
from app.services.chat_group_access import GROUP_RESOURCE_TYPE
from app.services.issue_resource_context import require_assignment_agent
from app.services.thread_participation import initialize_thread_participants
from app.services.thread_project_links import create_thread_classification
from tests.utils.collaboration import authorize_project, authorize_project_agent


def _seed(engine: Engine, reuse_project: bool) -> tuple[str, str, str, int]:
    with Session(engine) as db:
        group = CollaborationChatGroup(
            project_key=f"RRG{uuid4().hex[:12]}",
            name="Resource authority",
            status="active",
            created_by_user_id=1,
        )
        db.add(group)
        db.flush()
        db.add(
            ResourceMember(
                resource_type=GROUP_RESOURCE_TYPE,
                resource_id=int(group.id),
                entity_type="user",
                entity_id="1",
                user_id=1,
                status="approved",
                role="Owner",
            )
        )
        item = LoopItem(
            cloud_project_id=group.id,
            title="Live resource authority",
            created_by_user_id=1,
            status="pending",
        )
        db.add(item)
        db.flush()
        initialize_thread_participants(db, item)
        owner = group
        if reuse_project:
            owner = CloudProject(
                project_key=f"RRP{uuid4().hex[:12]}",
                name="Resource source",
                created_by_user_id=1,
                metadata_json={},
            )
            authorize_project(db, owner)
            create_thread_classification(db, item, owner)
        agent = ProjectChatAgent(
            cloud_project_id=owner.id,
            name="Authority agent",
            created_by_user_id=1,
            metadata_json={"authorization_version": 2, "runtime": "codex"},
        )
        db.add(agent)
        db.flush()
        if reuse_project:
            authorize_project_agent(db, agent)
            grant = (
                db.query(ResourceMember)
                .filter_by(
                    resource_type="Workspace",
                    resource_id=owner.workspace_id,
                    entity_type="project_agent",
                    entity_id=agent.id,
                )
                .one()
            )
        else:
            grant = ResourceMember(
                resource_type=GROUP_RESOURCE_TYPE,
                resource_id=int(group.id),
                entity_type="project_agent",
                entity_id=agent.id,
                user_id=1,
                status="approved",
                role="Developer",
            )
            db.add(grant)
            db.flush()
        result = str(group.id), str(item.id), str(agent.id), grant.id
        db.commit()
        return result


def run_group_resource_authority_cases(engine: Engine) -> None:
    for reuse_project in (False, True):
        group_id, item_id, agent_id, grant_id = _seed(engine, reuse_project)
        with (
            engine.connect().execution_options(
                isolation_level="REPEATABLE READ"
            ) as connection,
            Session(bind=connection) as reader,
        ):
            cached = reader.get(ResourceMember, grant_id)
            assert cached is not None and cached.status == "approved"
            with Session(engine) as revoker:
                revoker.get(ResourceMember, grant_id).status = "rejected"
                revoker.commit()
            # Prove a plain read still sees the old view before testing authority.
            assert (
                reader.query(ResourceMember.status).filter_by(id=grant_id).scalar()
                == "approved"
            )
            try:
                require_assignment_agent(
                    reader,
                    container_id=group_id,
                    agent_id=agent_id,
                    user_id=1,
                    item=reader.get(LoopItem, item_id),
                    execute=True,
                )
            except HTTPException as denied:
                assert denied.status_code == 422
            else:
                raise AssertionError("A revoked resource survived an RR snapshot")
            assert cached.status == "rejected"
            reader.rollback()
            print(
                "MySQL Group resource authority: "
                + ("linked Project" if reuse_project else "Group")
                + " revoked grant rejected after RR snapshot",
                flush=True,
            )
    from tests.integration.group_resource_source_sharing_mysql import (
        run_group_source_sharing_cases,
    )

    run_group_source_sharing_cases(engine)
    from tests.integration.group_resource_grant_concurrency_mysql import (
        run_independent_group_resource_grants,
    )

    run_independent_group_resource_grants(engine)
