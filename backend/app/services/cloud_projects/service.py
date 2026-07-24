# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Cloud project lifecycle and local execution bindings."""

import re
import uuid

from fastapi import HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject, CloudProjectLocalBinding
from app.models.project import Project
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.cloud_project import (
    CloudProjectCreate,
    CloudProjectMemberCreate,
    CloudProjectMemberUpdate,
    CloudProjectUpdate,
    LocalBindingCreate,
)
from app.services.cloud_projects.access import require_cloud_project_role


class CloudProjectService:
    def _generate_project_key(self, db: Session, name: str) -> str:
        prefix = re.sub(r"[^A-Za-z0-9]", "", name).upper()[:8] or "PRJ"
        for _ in range(10):
            suffix = uuid.uuid4().hex[:6].upper()
            candidate = f"{prefix}{suffix}"[:16]
            exists = (
                db.query(CloudProject.id)
                .filter(CloudProject.project_key == candidate)
                .first()
            )
            if exists is None:
                return candidate
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Could not generate project key"
        )

    def create(
        self, db: Session, user_id: int, values: CloudProjectCreate
    ) -> CloudProject:
        public_id = str(uuid.uuid4())
        project = CloudProject(
            public_id=public_id,
            project_key=values.project_key
            or self._generate_project_key(db, values.name),
            name=values.name,
            description=values.description,
            created_by_user_id=user_id,
            storage_prefix=f"projects/{public_id}",
        )
        db.add(project)
        try:
            db.flush()
            db.add(
                ResourceMember.create(
                    resource_type=ResourceType.CLOUD_PROJECT.value,
                    resource_id=project.id,
                    entity_id=str(user_id),
                    role=BaseRole.Owner.value,
                    status=MemberStatus.APPROVED.value,
                )
            )
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Cloud project key already exists"
            ) from exc
        db.refresh(project)
        return project

    def list_accessible(self, db: Session, user_id: int) -> list[CloudProject]:
        member_project_ids = select(ResourceMember.resource_id).where(
            ResourceMember.resource_type == ResourceType.CLOUD_PROJECT.value,
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(user_id),
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        return (
            db.query(CloudProject)
            .filter(
                CloudProject.status == "active",
                or_(
                    CloudProject.created_by_user_id == user_id,
                    CloudProject.id.in_(member_project_ids),
                ),
            )
            .order_by(CloudProject.updated_at.desc())
            .all()
        )

    def get(self, db: Session, project_id: int, user_id: int) -> CloudProject:
        return require_cloud_project_role(db, project_id, user_id).project

    def update(
        self,
        db: Session,
        project_id: int,
        user_id: int,
        values: CloudProjectUpdate,
    ) -> CloudProject:
        project = require_cloud_project_role(
            db, project_id, user_id, BaseRole.Maintainer
        ).project
        updates = values.model_dump(exclude={"version"}, exclude_none=True)
        updated = (
            db.query(CloudProject)
            .filter(
                CloudProject.id == project.id,
                CloudProject.version == values.version,
            )
            .update({**updates, "version": CloudProject.version + 1})
        )
        if updated != 1:
            db.rollback()
            raise HTTPException(status.HTTP_409_CONFLICT, "Cloud project changed")
        db.commit()
        db.refresh(project)
        return project

    def add_local_binding(
        self,
        db: Session,
        cloud_project_id: int,
        user_id: int,
        values: LocalBindingCreate,
    ) -> CloudProjectLocalBinding:
        require_cloud_project_role(db, cloud_project_id, user_id, BaseRole.Developer)
        local_project = (
            db.query(Project)
            .filter(
                Project.id == values.local_project_id,
                Project.user_id == user_id,
                Project.is_active.is_(True),
            )
            .first()
        )
        if local_project is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Local project not found")
        if values.is_default:
            db.query(CloudProjectLocalBinding).filter(
                CloudProjectLocalBinding.cloud_project_id == cloud_project_id,
                CloudProjectLocalBinding.user_id == user_id,
                CloudProjectLocalBinding.device_id == values.device_id,
            ).update({"is_default": False})
        binding = CloudProjectLocalBinding(
            cloud_project_id=cloud_project_id,
            user_id=user_id,
            **values.model_dump(),
        )
        db.add(binding)
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Local project is already linked"
            ) from exc
        db.refresh(binding)
        return binding

    def list_local_bindings(
        self, db: Session, cloud_project_id: int, user_id: int
    ) -> list[CloudProjectLocalBinding]:
        require_cloud_project_role(db, cloud_project_id, user_id)
        return (
            db.query(CloudProjectLocalBinding)
            .filter(
                CloudProjectLocalBinding.cloud_project_id == cloud_project_id,
                CloudProjectLocalBinding.user_id == user_id,
            )
            .order_by(
                CloudProjectLocalBinding.is_default.desc(),
                CloudProjectLocalBinding.updated_at.desc(),
            )
            .all()
        )

    def list_members(
        self, db: Session, cloud_project_id: int, user_id: int
    ) -> list[dict[str, object]]:
        project = require_cloud_project_role(db, cloud_project_id, user_id).project
        rows = (
            db.query(ResourceMember, User)
            .join(User, User.id == ResourceMember.user_id)
            .filter(
                ResourceMember.resource_type == ResourceType.CLOUD_PROJECT.value,
                ResourceMember.resource_id == cloud_project_id,
                ResourceMember.entity_type == "user",
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .order_by(ResourceMember.id)
            .all()
        )
        members = [
            {
                "id": member.id,
                "user_id": member_user.id,
                "user_name": member_user.user_name,
                "email": member_user.email,
                "role": member.role,
            }
            for member, member_user in rows
        ]
        if not any(
            member["user_id"] == project.created_by_user_id for member in members
        ):
            creator = db.get(User, project.created_by_user_id)
            if creator is not None:
                members.insert(
                    0,
                    {
                        "id": 0,
                        "user_id": creator.id,
                        "user_name": creator.user_name,
                        "email": creator.email,
                        "role": BaseRole.Owner.value,
                    },
                )
        return members

    def add_member(
        self,
        db: Session,
        cloud_project_id: int,
        user_id: int,
        values: CloudProjectMemberCreate,
    ) -> dict[str, object]:
        require_cloud_project_role(db, cloud_project_id, user_id, BaseRole.Maintainer)
        target = db.get(User, values.user_id)
        if target is None or not target.is_active:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
        member = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.CLOUD_PROJECT.value,
                ResourceMember.resource_id == cloud_project_id,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(target.id),
            )
            .first()
        )
        if member is None:
            member = ResourceMember.create(
                resource_type=ResourceType.CLOUD_PROJECT.value,
                resource_id=cloud_project_id,
                entity_id=str(target.id),
                role=values.role.value,
                status=MemberStatus.APPROVED.value,
            )
            db.add(member)
        else:
            member.role = values.role.value
            member.status = MemberStatus.APPROVED.value
        db.commit()
        db.refresh(member)
        return {
            "id": member.id,
            "user_id": target.id,
            "user_name": target.user_name,
            "email": target.email,
            "role": member.role,
        }

    def update_member(
        self,
        db: Session,
        cloud_project_id: int,
        member_user_id: int,
        user_id: int,
        values: CloudProjectMemberUpdate,
    ) -> dict[str, object]:
        project = require_cloud_project_role(
            db, cloud_project_id, user_id, BaseRole.Maintainer
        ).project
        if member_user_id == project.created_by_user_id:
            raise HTTPException(status.HTTP_409_CONFLICT, "Project owner is immutable")
        member, target = self._get_member(db, cloud_project_id, member_user_id)
        member.role = values.role.value
        db.commit()
        db.refresh(member)
        return {
            "id": member.id,
            "user_id": target.id,
            "user_name": target.user_name,
            "email": target.email,
            "role": member.role,
        }

    def remove_member(
        self,
        db: Session,
        cloud_project_id: int,
        member_user_id: int,
        user_id: int,
    ) -> None:
        project = require_cloud_project_role(
            db, cloud_project_id, user_id, BaseRole.Maintainer
        ).project
        if member_user_id == project.created_by_user_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Project owner cannot be removed"
            )
        member, _ = self._get_member(db, cloud_project_id, member_user_id)
        db.delete(member)
        db.commit()

    @staticmethod
    def _get_member(
        db: Session, cloud_project_id: int, member_user_id: int
    ) -> tuple[ResourceMember, User]:
        member = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.CLOUD_PROJECT.value,
                ResourceMember.resource_id == cloud_project_id,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(member_user_id),
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .first()
        )
        target = db.get(User, member_user_id)
        if member is None or target is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Project member not found")
        return member, target


cloud_project_service = CloudProjectService()
