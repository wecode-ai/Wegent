"""Group-owned crew definitions reuse Kind resources and explicit resource grants."""

from typing import TYPE_CHECKING

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.schemas.base_role import BaseRole
from app.schemas.workspace import CollaborationGroupCreate, CollaborationGroupUpdate
from app.services.collaboration_container_access import (
    require_collaboration_container_access,
)
from app.services.collaboration_permissions import RESOURCE_USE_ROLES
from app.services.resource_grant_storage import ensure_resource_member_grant
from app.services.workspaces.collaboration_groups import (
    COLLABORATION_GROUP_KIND,
    _group_payload,
    _group_values,
)

if TYPE_CHECKING:
    from app.services.workspaces.collaboration_groups import (
        WorkspaceCollaborationGroupService,
    )


class ChatGroupCrewService:
    def __init__(self, shared: "WorkspaceCollaborationGroupService") -> None:
        self.shared = shared

    @staticmethod
    def _rows(db: Session, container: int):
        return (
            db.query(Kind)
            .join(
                ResourceMember,
                (ResourceMember.resource_id == Kind.id)
                & (ResourceMember.resource_type == COLLABORATION_GROUP_KIND),
            )
            .filter(
                Kind.kind == COLLABORATION_GROUP_KIND,
                Kind.is_active.is_(True),
                ResourceMember.entity_type == "chat_group",
                ResourceMember.entity_id == str(container),
                ResourceMember.status == "approved",
                ResourceMember.role.in_(RESOURCE_USE_ROLES),
            )
        )

    @staticmethod
    def _owner(crew: Kind) -> tuple[str, int]:
        for prefix, owner_type in (
            ("chat-groups/", "chat_group"),
            ("projects/", "project"),
            ("workspaces/", "workspace"),
        ):
            if crew.namespace.startswith(prefix):
                value = crew.namespace.removeprefix(prefix)
                if (
                    value.isascii()
                    and value.isdecimal()
                    and str(int(value)) == value
                    and int(value) > 0
                ):
                    return owner_type, int(value)
        raise HTTPException(409, "Collaboration group has an invalid owner namespace")

    @staticmethod
    def _view(container: int, crew: Kind) -> dict[str, object]:
        owner_type, owner_id = ChatGroupCrewService._owner(crew)
        return {
            **_group_values(None, owner_type, owner_id, crew),
            "binding_owner_id": str(container),
        }

    def list(self, db: Session, container: int, user: int) -> list[dict[str, object]]:
        require_collaboration_container_access(db, container, user)
        rows = self._rows(db, container).order_by(Kind.name, Kind.id).all()
        return [self._view(container, crew) for crew in rows]

    def create(
        self, db: Session, container: int, user: int, values: CollaborationGroupCreate
    ) -> dict[str, object]:
        require_collaboration_container_access(
            db, container, user, BaseRole.Maintainer, write=True
        )
        self.shared._validate_name_available(
            db, owner_type="chat_group", owner_id=container, name=values.name
        )
        self.shared._validate_members(
            db,
            workspace_id=None,
            owner_type="chat_group",
            owner_id=container,
            leader=values.leader,
            members=values.members,
            stages=values.stages,
            actor_user_id=user,
        )
        crew = Kind(
            user_id=user,
            kind=COLLABORATION_GROUP_KIND,
            name=values.name,
            namespace=f"chat-groups/{container}",
            json=_group_payload(values),
            is_active=True,
        )
        db.add(crew)
        db.flush()
        self._bind(db, container, crew, user)
        db.commit()
        db.refresh(crew)
        return self._view(container, crew)

    @staticmethod
    def _bind(db: Session, container: int, crew: Kind, user: int) -> None:
        ensure_resource_member_grant(
            db,
            resource_type=COLLABORATION_GROUP_KIND,
            resource_id=crew.id,
            entity_type="chat_group",
            entity_id=str(container),
            added_by_user_id=user,
            role=BaseRole.Developer,
        )

    def add(
        self, db: Session, container: int, crew_id: int, user: int
    ) -> dict[str, object]:
        crew = db.get(Kind, crew_id)
        if crew is None or crew.kind != COLLABORATION_GROUP_KIND or not crew.is_active:
            raise HTTPException(404, "Collaboration group not found")
        owner_type, owner_id = self._owner(crew)
        if owner_type == "chat_group":
            for group_id in sorted({container, owner_id}):
                require_collaboration_container_access(
                    db, group_id, user, BaseRole.Maintainer, write=True
                )
        else:
            require_collaboration_container_access(
                db, container, user, BaseRole.Maintainer, write=True
            )
            self._require_source_management(db, owner_type, owner_id, user)
        crew = (
            db.query(Kind)
            .filter_by(id=crew_id)
            .with_for_update()
            .populate_existing()
            .one()
        )
        if not crew.is_active or self._owner(crew) != (owner_type, owner_id):
            raise HTTPException(409, "Collaboration group source changed")
        if self._rows(db, container).filter(Kind.id == crew_id).first() is not None:
            raise HTTPException(
                409, "Collaboration group is already added to this group"
            )
        source_grant = (
            db.query(ResourceMember)
            .filter_by(
                resource_type=COLLABORATION_GROUP_KIND,
                resource_id=crew_id,
                entity_type=owner_type,
                entity_id=str(owner_id),
                status="approved",
            )
            .filter(ResourceMember.role.in_(RESOURCE_USE_ROLES))
            .with_for_update()
            .populate_existing()
            .first()
        )
        if source_grant is None:
            raise HTTPException(
                422, "Collaboration group source authorization is unavailable"
            )
        current = CollaborationGroupCreate.model_validate(self._view(container, crew))
        self.shared._validate_members(
            db,
            workspace_id=None,
            owner_type="chat_group",
            owner_id=container,
            leader=current.leader,
            members=current.members,
            stages=current.stages,
            actor_user_id=user,
        )
        self._bind(db, container, crew, user)
        db.commit()
        return self._view(container, crew)

    @staticmethod
    def _require_source_management(
        db: Session, kind: str, owner: int, user: int
    ) -> None:
        if kind == "workspace":
            from app.services.project_classification_access import (
                require_locked_workspace,
            )

            require_locked_workspace(db, owner, user, BaseRole.Maintainer)
        else:
            from app.services.project_classification_access import (
                require_classification_project,
            )

            try:
                require_classification_project(
                    db, str(owner), user, required_role=BaseRole.Maintainer
                )
            except HTTPException as error:
                if error.status_code == 403:
                    raise HTTPException(
                        403,
                        "Source administration is required to share this collaboration group",
                    ) from error
                raise

    def update(
        self,
        db: Session,
        container: int,
        crew_id: int,
        user: int,
        values: CollaborationGroupUpdate,
    ) -> dict[str, object]:
        require_collaboration_container_access(
            db, container, user, BaseRole.Maintainer, write=True
        )
        crew = (
            self._rows(db, container)
            .filter(Kind.id == crew_id)
            .with_for_update()
            .populate_existing()
            .one_or_none()
        )
        if crew is None or crew.namespace != f"chat-groups/{container}":
            raise HTTPException(404, "Group-owned collaboration group not found")
        self.shared._update_owned_group(
            db,
            workspace_id=None,
            owner_type="chat_group",
            owner_id=container,
            group=crew,
            values=values,
            actor_user_id=user,
        )
        self._commit_revocation(db, container)
        db.refresh(crew)
        return self._view(container, crew)

    def remove(self, db: Session, container: int, crew_id: int, user: int) -> None:
        require_collaboration_container_access(
            db, container, user, BaseRole.Maintainer, write=True
        )
        crew = (
            self._rows(db, container)
            .filter(Kind.id == crew_id)
            .with_for_update()
            .populate_existing()
            .one_or_none()
        )
        if crew is None:
            raise HTTPException(404, "Group collaboration group not found")
        if crew.namespace == f"chat-groups/{container}":
            crew.is_active = False
        grant = (
            db.query(ResourceMember)
            .filter_by(
                resource_type=COLLABORATION_GROUP_KIND,
                resource_id=crew_id,
                entity_type="chat_group",
                entity_id=str(container),
            )
            .one()
        )
        db.delete(grant)
        self._commit_revocation(db, container)

    @staticmethod
    def _commit_revocation(db: Session, container: int) -> None:
        from app.services.collaboration_revocation import (
            revoke_unauthorized_project_work,
        )
        from app.services.loop_item_executions.cancellation import (
            request_execution_cancellations,
        )

        db.flush()
        pending = revoke_unauthorized_project_work(db, container)
        db.commit()
        request_execution_cancellations(pending)
