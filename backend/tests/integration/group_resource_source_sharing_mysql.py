"""Real source sharing authority must survive neither revocation nor an RR view."""

from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.models.delivery import CollaborationChatGroup
from app.models.namespace import Namespace
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.services.chat_group_access import GROUP_RESOURCE_TYPE
from app.services.external_entity_resolver import _external_entity_resolvers
from app.services.group_resource_permissions import authorize_group_team
from app.services.resource_authority_reads import current_authority_reads
from app.services.share.namespace_entity_resolver import NamespaceEntityResolver
from tests.services.test_group_resource_source_sharing import source


def _seed(engine: Engine, mode: str) -> tuple[str, int, int]:
    with Session(engine) as db:
        group = CollaborationChatGroup(
            project_key=f"TSR{uuid4().hex[:12]}",
            name="Explicit Team source",
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
                role="Owner",
                status="approved",
            )
        )
        team, grant = source(db, db.get(User, 1), mode)
        result = str(group.id), team.id, grant.id
        db.commit()
        return result


def _target_grants(db: Session, group_id: str, team_id: int) -> int:
    return (
        db.query(ResourceMember)
        .filter_by(
            resource_type="Team",
            resource_id=team_id,
            entity_type="chat_group",
            entity_id=group_id,
        )
        .count()
    )


def _case(engine: Engine, mode: str) -> None:
    group_id, team_id, grant_id = _seed(engine, mode)
    with Session(engine) as db:
        authorize_group_team(db, db.get(CollaborationChatGroup, group_id), 1, team_id)
        assert _target_grants(db, group_id, team_id) == 1
        db.rollback()
    with (
        engine.connect().execution_options(
            isolation_level="REPEATABLE READ"
        ) as connection,
        Session(bind=connection) as reader,
    ):
        assert reader.get(ResourceMember, grant_id).status == "approved"
        with Session(engine) as revoker:
            revoker.get(ResourceMember, grant_id).status = "rejected"
            revoker.commit()
        assert (
            reader.query(ResourceMember.status).filter_by(id=grant_id).scalar()
            == "approved"
        )
        try:
            authorize_group_team(
                reader, reader.get(CollaborationChatGroup, group_id), 1, team_id
            )
        except HTTPException as denied:
            assert denied.status_code in {403, 422}
        else:
            raise AssertionError("Revoked source authority created a Group Team grant")
        assert _target_grants(reader, group_id, team_id) == 0
        assert current_authority_reads() is False
        reader.rollback()
    print(
        f"MySQL Group Team source authority: {mode} legal then RR revocation rejected",
        flush=True,
    )


def run_group_source_sharing_cases(engine: Engine) -> None:
    Namespace.__table__.create(engine, checkfirst=True)
    original = _external_entity_resolvers.get("namespace")
    _external_entity_resolvers["namespace"] = NamespaceEntityResolver
    try:
        for mode in ("direct", "namespace", "parent", "namespace_entity"):
            _case(engine, mode)
    finally:
        if original is None:
            _external_entity_resolvers.pop("namespace", None)
        else:
            _external_entity_resolvers["namespace"] = original
