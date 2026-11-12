"""Current Runtime profile reads preserve the Group and original Project gates."""

import json

from sqlalchemy import select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.models.delivery import (
    LoopItem,
    ProjectChatAgent,
    RuntimeProfile,
    ThreadProjectLink,
)
from app.models.loop_item_execution import LoopItemExecution
from app.services.collaboration_revocation import execution_authorized
from tests.integration.group_resource_authority_mysql import _seed


def _execution(container_id: str, item_id: str, agent_id: str, profile_id: str):
    return LoopItemExecution(
        cloud_project_id=container_id,
        loop_item_id=item_id,
        agent_id=agent_id,
        assigner_user_id=1,
        executor_owner_user_id=1,
        execution_environment="local",
        execution_payload=json.dumps(
            {"runtime_selection": {"runtime_profile_id": profile_id}}
        ),
    )


def verify_runtime_profile_current_authority(engine: Engine) -> None:
    for original_project in (False, True):
        group_id, item_id, agent_id, _ = _seed(engine, original_project)
        with Session(engine) as db:
            item = db.get(LoopItem, item_id)
            container_id = group_id
            if original_project:
                container_id = str(db.get(ProjectChatAgent, agent_id).cloud_project_id)
                item.cloud_project_id = container_id
                db.query(ThreadProjectLink).filter_by(loop_item_id=item_id).delete(
                    synchronize_session=False
                )
            profile = RuntimeProfile(user_id=1, status="active")
            db.add(profile)
            db.flush()
            profile_id = str(profile.id)
            db.commit()
        with Session(engine) as positive:
            assert (
                execution_authorized(
                    positive, _execution(container_id, item_id, agent_id, profile_id)
                )
                is True
            )
            positive.rollback()
        with (
            engine.connect().execution_options(
                isolation_level="REPEATABLE READ"
            ) as connection,
            Session(bind=connection) as reader,
        ):
            cached = reader.get(RuntimeProfile, profile_id)
            assert cached.status == "active"
            with Session(engine) as revoker:
                revoker.get(RuntimeProfile, profile_id).status = "archived"
                revoker.commit()
            assert (
                reader.scalar(
                    select(RuntimeProfile.status).where(RuntimeProfile.id == profile_id)
                )
                == "active"
            )
            assert (
                execution_authorized(
                    reader, _execution(container_id, item_id, agent_id, profile_id)
                )
                is False
            )
            assert cached.status == "archived"
            reader.rollback()
        print(
            "MySQL Runtime profile current authority: "
            + ("Project" if original_project else "Group")
            + " archived profile rejected after RR snapshot",
            flush=True,
        )
