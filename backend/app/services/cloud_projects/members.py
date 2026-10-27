"""Effective project membership and direct invitation management."""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.schemas.base_role import BaseRole, has_permission
from app.schemas.cloud_project import CloudProjectMemberCreate, CloudProjectMemberUpdate
from app.services.cloud_project_visibility import (
    effective_project_role,
    project_membership_rows,
    project_participant_ids,
    project_participant_roles,
)
from app.services.cloud_projects.access import (
    CloudProjectAccess,
    require_cloud_project_role,
)
from app.services.collaboration_permissions import collaboration_permission_service


class CloudProjectMemberService:
    def list_members(self, db: Session, cloud_project_id: int, user_id: int):
        access = require_cloud_project_role(db, cloud_project_id, user_id)
        return self.list_members_for_access(db, access, user_id)

    def list_members_for_access(
        self, db: Session, access: CloudProjectAccess, user_id: int
    ) -> list[dict[str, object]]:
        project = access.project
        workspace, membership_rows = project_membership_rows(db, project)
        roles = project_participant_roles(project, workspace, membership_rows)
        capabilities = self._member_capabilities(project)
        users = (
            db.query(User)
            .filter(User.id.in_(roles), User.is_active.is_(True))
            .order_by(User.id)
            .all()
        )
        participants = {member.id for member in users}
        sources = collaboration_permission_service.project_sources_many(
            project, users, workspace=workspace, grants=membership_rows
        )
        grants = {
            grant.entity_id: grant
            for grant in membership_rows
            if grant.resource_type == "CloudProject"
        }
        return [
            self._member_values(
                project,
                member,
                capabilities,
                user_id in participants,
                sources[member.id],
                grants.get(str(member.id)),
            )
            for member in users
        ]

    @staticmethod
    def _member_view(db, project, member, capabilities, expose_email):
        sources = collaboration_permission_service.project_sources(
            db, project, member.id
        )
        grant = CloudProjectMemberService._direct_member(db, int(project.id), member.id)
        return CloudProjectMemberService._member_values(
            project, member, capabilities, expose_email, sources, grant
        )

    @staticmethod
    def _member_values(
        project: CloudProject,
        member: User,
        capabilities: dict[str, str],
        expose_email: bool,
        sources: tuple[dict, ...],
        grant: ResourceMember | None,
    ) -> dict[str, object]:
        direct = next(
            (source["role"] for source in sources if source["type"] == "direct"), None
        )
        inherited = next(
            (source["role"] for source in sources if source["type"] == "workspace"),
            None,
        )
        role = effective_project_role(direct, inherited)
        return {
            "id": grant.id if grant else member.id,
            "user_id": member.id,
            "user_name": member.user_name,
            "email": member.email if expose_email else None,
            "role": role,
            "direct_role": direct,
            "inherited_role": inherited,
            "permission_sources": list(sources),
            "inherited_from_workspace_id": (
                str(project.workspace_id) if inherited else None
            ),
            "can_be_assignee": has_permission(role, BaseRole.Developer),
            "capability_description": capabilities.get(str(member.id), ""),
        }

    def add_member(
        self,
        db: Session,
        cloud_project_id: int,
        user_id: int,
        values: CloudProjectMemberCreate,
    ):
        require_cloud_project_role(db, cloud_project_id, user_id, BaseRole.Maintainer)
        project = self._lock_project(db, cloud_project_id)
        target = db.get(User, values.user_id)
        if not target or not target.is_active:
            raise HTTPException(404, "User not found")
        self._set_direct_role(db, cloud_project_id, target.id, values.role)
        self._set_member_capability(project, target.id, values.capability_description)
        from app.services.collaboration_revocation import (
            revoke_unauthorized_project_work,
        )
        from app.services.loop_item_executions.cancellation import (
            request_execution_cancellations,
        )

        db.flush()
        pending = revoke_unauthorized_project_work(db, project.id, target.id)
        db.commit()
        request_execution_cancellations(pending)
        return self._member_view(
            db, project, target, self._member_capabilities(project), True
        )

    def update_member(
        self,
        db: Session,
        cloud_project_id: int,
        member_user_id: int,
        user_id: int,
        values: CloudProjectMemberUpdate,
    ):
        require_cloud_project_role(db, cloud_project_id, user_id, BaseRole.Maintainer)
        project = self._lock_project(db, cloud_project_id)
        target = db.get(User, member_user_id)
        if not target or member_user_id not in project_participant_ids(db, project):
            raise HTTPException(404, "Project member not found")
        if values.role is not None:
            self._set_direct_role(db, cloud_project_id, member_user_id, values.role)
        if values.capability_description is not None:
            self._set_member_capability(
                project, target.id, values.capability_description
            )
        from app.services.collaboration_revocation import (
            revoke_unauthorized_project_work,
        )

        db.flush()
        pending = revoke_unauthorized_project_work(db, project.id, member_user_id)
        db.commit()
        from app.services.loop_item_executions.cancellation import (
            request_execution_cancellations,
        )

        request_execution_cancellations(pending)
        return self._member_view(
            db, project, target, self._member_capabilities(project), True
        )

    def remove_member(
        self, db: Session, cloud_project_id: int, member_user_id: int, user_id: int
    ):
        require_cloud_project_role(db, cloud_project_id, user_id, BaseRole.Maintainer)
        project = self._lock_project(db, cloud_project_id)
        grant = self._direct_member(db, cloud_project_id, member_user_id)
        if grant is None:
            raise HTTPException(
                409, "Inherited membership must be changed in the parent Workspace"
            )
        db.delete(grant)
        self._set_member_capability(project, member_user_id, "")
        from app.services.collaboration_revocation import (
            revoke_unauthorized_project_work,
        )

        db.flush()
        pending = revoke_unauthorized_project_work(db, project.id, member_user_id)
        db.commit()
        from app.services.loop_item_executions.cancellation import (
            request_execution_cancellations,
        )

        request_execution_cancellations(pending)

    @staticmethod
    def _set_direct_role(
        db: Session, project_id: int, user_id: int, role: BaseRole
    ) -> None:
        grant = CloudProjectMemberService._direct_member(db, project_id, user_id)
        if grant is None:
            db.add(
                ResourceMember.create(
                    resource_type="CloudProject",
                    resource_id=project_id,
                    entity_id=str(user_id),
                    role=role.value,
                    status="approved",
                )
            )
        else:
            grant.role, grant.status = role.value, "approved"

    @staticmethod
    def _direct_member(db: Session, project_id: int, user_id: int):
        return (
            db.query(ResourceMember)
            .filter_by(
                resource_type="CloudProject",
                resource_id=project_id,
                entity_type="user",
                entity_id=str(user_id),
            )
            .first()
        )
