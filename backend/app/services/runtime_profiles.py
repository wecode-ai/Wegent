# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Reusable Wework Runtime profiles backed by LoopNode resources."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import RuntimeBinding, RuntimeProfile, loop_datetime_is_unset
from app.models.loop_item_execution import LoopItemExecution
from app.schemas.base_role import BaseRole
from app.schemas.runtime_profile import RuntimeProfileCreate, RuntimeProfileUpdate
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.loop_item_executions.profile import validate_wework_execution_target

CLOUD_MODEL_TYPES = {"public", "user", "group"}
CLOUD_MODEL_NAMESPACE_OPTION = "weworkCloudModelNamespace"
CLOUD_MODEL_RESOURCE_USER_ID_OPTION = "weworkCloudModelResourceUserId"


def _metadata(row: RuntimeProfile) -> dict:
    return dict(row.metadata_json) if isinstance(row.metadata_json, dict) else {}


def _catalog_visible(row: RuntimeProfile) -> bool:
    return _metadata(row).get("catalog_visibility") != "internal"


def _validate_cloud_model_identity(
    model_type: str | None,
    model_options: dict[str, str] | None,
) -> None:
    if model_type not in CLOUD_MODEL_TYPES:
        return
    options = model_options or {}
    namespace = str(options.get(CLOUD_MODEL_NAMESPACE_OPTION) or "").strip()
    try:
        resource_user_id = int(options.get(CLOUD_MODEL_RESOURCE_USER_ID_OPTION))
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Cloud model identity is incomplete",
        ) from exc
    if not namespace or resource_user_id < 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Cloud model identity is incomplete",
        )


class RuntimeProfileService:
    """Own personal Runtime profiles and their per-project default bindings."""

    @staticmethod
    def execution_configuration(
        profile: RuntimeProfile,
    ) -> tuple[str, str, str, dict]:
        """Return the canonical execution fields stored by one Runtime profile."""

        metadata = _metadata(profile)
        return (
            str(metadata.get("execution_environment") or ""),
            str(profile.device_id or ""),
            str(metadata.get("model") or ""),
            metadata,
        )

    def require_runnable(
        self,
        db: Session,
        profile_id: str,
        user_id: int,
    ) -> RuntimeProfile:
        """Require an active Runtime profile that can start an execution."""

        profile = self.require_owned(db, profile_id, user_id)
        if profile.status != "active":
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "Runtime profile is not active",
            )
        environment, device_id, model, metadata = self.execution_configuration(profile)
        if not model:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "Runtime profile has no model",
            )
        validate_wework_execution_target(
            db,
            user_id=user_id,
            environment=environment,
            execution_device_id=device_id,
        )
        _validate_cloud_model_identity(
            metadata.get("model_type"),
            metadata.get("model_options"),
        )
        return profile

    def ensure_device_defaults(
        self,
        db: Session,
        user_id: int,
        devices: list[dict],
    ) -> None:
        existing_device_ids = {
            str(row.device_id)
            for row in db.query(RuntimeProfile)
            .filter(
                RuntimeProfile.user_id == user_id,
                RuntimeProfile.status == "active",
                loop_datetime_is_unset(RuntimeProfile.deleted_at),
            )
            .all()
            if row.device_id and _catalog_visible(row)
        }
        created = False
        for device in devices:
            device_id = str(device.get("device_id") or "").strip()
            if not device_id or device_id in existing_device_ids:
                continue
            device_type = str(device.get("device_type") or "local")
            device_name = str(device.get("name") or device_id).strip()
            db.add(
                RuntimeProfile(
                    user_id=user_id,
                    created_by_user_id=user_id,
                    updated_by_user_id=user_id,
                    name=device_name,
                    title=device_name,
                    device_id=device_id,
                    metadata_json={
                        "execution_environment": (
                            "local" if device_type == "local" else "cloud"
                        ),
                        "model": "",
                        "model_type": None,
                        "model_options": {},
                        "workspace_policy": "project",
                    },
                )
            )
            existing_device_ids.add(device_id)
            created = True
        if created:
            db.commit()

    def list(self, db: Session, user_id: int) -> list[dict]:
        rows = (
            db.query(RuntimeProfile)
            .filter(
                RuntimeProfile.user_id == user_id,
                loop_datetime_is_unset(RuntimeProfile.deleted_at),
            )
            .order_by(RuntimeProfile.updated_at.desc())
            .all()
        )
        return [self.to_view(row) for row in rows if _catalog_visible(row)]

    def create(self, db: Session, user_id: int, values: RuntimeProfileCreate) -> dict:
        validate_wework_execution_target(
            db,
            user_id=user_id,
            environment=values.execution_environment,
            execution_device_id=values.execution_device_id,
        )
        _validate_cloud_model_identity(values.model_type, values.model_options)
        row = RuntimeProfile(
            user_id=user_id,
            created_by_user_id=user_id,
            updated_by_user_id=user_id,
            name=values.name.strip(),
            title=values.name.strip(),
            device_id=values.execution_device_id,
            metadata_json={
                "execution_environment": values.execution_environment,
                "model": values.model,
                "model_type": values.model_type,
                "model_options": values.model_options,
                "workspace_policy": values.workspace_policy,
            },
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return self.to_view(row)

    def update(
        self,
        db: Session,
        user_id: int,
        profile_id: str,
        values: RuntimeProfileUpdate,
    ) -> dict:
        row = self.require_owned(db, profile_id, user_id, for_update=True)
        if row.version != values.version:
            raise HTTPException(status.HTTP_409_CONFLICT, "Runtime profile changed")
        metadata = _metadata(row)
        environment = values.execution_environment or str(
            metadata.get("execution_environment") or "local"
        )
        device_id = values.execution_device_id or str(row.device_id or "")
        validate_wework_execution_target(
            db,
            user_id=user_id,
            environment=environment,
            execution_device_id=device_id,
        )
        next_metadata = dict(metadata)
        for field in (
            "execution_environment",
            "model",
            "model_type",
            "model_options",
            "workspace_policy",
        ):
            if field in values.model_fields_set:
                next_metadata[field] = getattr(values, field)
        _validate_cloud_model_identity(
            next_metadata.get("model_type"),
            next_metadata.get("model_options"),
        )
        if values.name is not None:
            row.name = values.name.strip()
            row.title = values.name.strip()
        if values.execution_device_id is not None:
            row.device_id = values.execution_device_id
        if values.status is not None:
            row.status = values.status
        row.metadata_json = next_metadata
        row.updated_by_user_id = user_id
        row.version += 1
        db.commit()
        db.refresh(row)
        return self.to_view(row)

    def delete(self, db: Session, user_id: int, profile_id: str) -> None:
        row = self.require_owned(db, profile_id, user_id, for_update=True)
        active_binding = (
            db.query(RuntimeBinding.id)
            .filter(
                RuntimeBinding.parent_id == row.id,
                RuntimeBinding.status == "active",
                loop_datetime_is_unset(RuntimeBinding.deleted_at),
            )
            .first()
        )
        if active_binding:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Runtime profile is still a project default",
            )
        from app.models.delivery import ProjectChatAgent
        from app.services.project_chat.service import BOT_RUNTIME_PROFILE_ID_KEY

        referenced_agent = (
            db.query(ProjectChatAgent.id)
            .filter(
                ProjectChatAgent.created_by_user_id == user_id,
                ProjectChatAgent.metadata_json[BOT_RUNTIME_PROFILE_ID_KEY].as_string()
                == row.id,
                loop_datetime_is_unset(ProjectChatAgent.deleted_at),
            )
            .first()
        )
        if referenced_agent:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Runtime profile is still used by a robot",
            )
        row.status = "archived"
        row.deleted_at = datetime.now(timezone.utc).replace(tzinfo=None)
        row.updated_by_user_id = user_id
        row.version += 1
        db.commit()

    def get_project_default(self, db: Session, project_id: str, user_id: int) -> dict:
        require_cloud_project_role(db, project_id, user_id, BaseRole.RestrictedAnalyst)
        binding = self._default_binding(db, project_id, user_id)
        return {
            "project_id": str(project_id),
            "user_id": user_id,
            "runtime_profile_id": binding.parent_id if binding else None,
        }

    def set_project_default(
        self, db: Session, project_id: str, user_id: int, profile_id: str
    ) -> dict:
        require_cloud_project_role(db, project_id, user_id, BaseRole.RestrictedAnalyst)
        self.require_owned(db, profile_id, user_id)
        binding = self._default_binding(db, project_id, user_id, for_update=True)
        if binding is None:
            binding = RuntimeBinding(
                cloud_project_id=str(project_id),
                user_id=user_id,
                created_by_user_id=user_id,
                updated_by_user_id=user_id,
                parent_id=profile_id,
                is_default=True,
            )
            db.add(binding)
        else:
            binding.parent_id = profile_id
            binding.updated_by_user_id = user_id
            binding.version += 1
        db.commit()
        return {
            "project_id": str(project_id),
            "user_id": user_id,
            "runtime_profile_id": profile_id,
        }

    def resolve_project_default(
        self, db: Session, project_id: str, user_id: int
    ) -> RuntimeProfile | None:
        binding = self._default_binding(db, project_id, user_id)
        if binding is None or not binding.parent_id:
            return None
        profile = db.get(RuntimeProfile, binding.parent_id)
        if profile is None or profile.user_id != user_id or profile.status != "active":
            return None
        return profile

    def require_owned(
        self,
        db: Session,
        profile_id: str,
        user_id: int,
        *,
        for_update: bool = False,
    ) -> RuntimeProfile:
        query = db.query(RuntimeProfile).filter(
            RuntimeProfile.id == profile_id,
            RuntimeProfile.user_id == user_id,
            loop_datetime_is_unset(RuntimeProfile.deleted_at),
        )
        if for_update:
            query = query.with_for_update()
        row = query.one_or_none()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Runtime profile not found")
        return row

    def select_execution(
        self,
        db: Session,
        *,
        execution_id: int,
        user_id: int,
        profile_id: str,
        version: int,
    ) -> LoopItemExecution:
        execution = (
            db.query(LoopItemExecution)
            .filter(LoopItemExecution.id == execution_id)
            .with_for_update()
            .one_or_none()
        )
        if execution is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Execution not found")
        if execution.executor_owner_user_id != user_id:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Only the Runtime owner can configure this execution",
            )
        if execution.version != version:
            raise HTTPException(status.HTTP_409_CONFLICT, "Execution changed")
        if execution.status not in {"waiting_runtime", "queued"}:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Runtime can only be selected before execution starts",
            )
        profile = self.require_runnable(db, profile_id, user_id)
        environment, device_id, model, metadata = self.execution_configuration(profile)
        selection = dict(execution.runtime_selection)
        selection.update(
            {
                "runtime_profile_id": profile.id,
                "runtime_profile_version": profile.version,
                "runtime_source": "selected",
                "model": model,
                "model_type": metadata.get("model_type"),
                "model_options": dict(metadata.get("model_options") or {}),
                "workspace_policy": metadata.get("workspace_policy") or "project",
            }
        )
        from app.services.loop_item_executions.service import (
            loop_item_execution_service,
        )

        execution.execution_payload = (
            loop_item_execution_service._serialize_execution_intent(
                runtime_selection=selection,
                origin_context=dict(execution.runtime_origin_context),
            )
        )
        execution.execution_environment = environment
        execution.execution_device_id = device_id
        execution.status = "queued"
        execution.execution_note = ""
        execution.queued_at = datetime.now(timezone.utc).replace(tzinfo=None)
        execution.version += 1
        loop_item_execution_service._persist_runtime_request_intent(
            db,
            execution=execution,
        )
        db.commit()
        db.refresh(execution)
        return execution

    @staticmethod
    def to_view(row: RuntimeProfile) -> dict:
        metadata = _metadata(row)
        return {
            "id": row.id,
            "name": row.name or row.title or "Runtime",
            "execution_environment": str(
                metadata.get("execution_environment") or "local"
            ),
            "execution_device_id": str(row.device_id or ""),
            "model": str(metadata.get("model") or ""),
            "model_type": metadata.get("model_type"),
            "model_options": dict(metadata.get("model_options") or {}),
            "workspace_policy": str(metadata.get("workspace_policy") or "project"),
            "status": row.status or "active",
            "version": row.version,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
        }

    @staticmethod
    def _default_binding(
        db: Session,
        project_id: str,
        user_id: int,
        *,
        for_update: bool = False,
    ) -> RuntimeBinding | None:
        query = db.query(RuntimeBinding).filter(
            RuntimeBinding.cloud_project_id == str(project_id),
            RuntimeBinding.user_id == user_id,
            RuntimeBinding.is_default == True,
            RuntimeBinding.status == "active",
            loop_datetime_is_unset(RuntimeBinding.deleted_at),
        )
        if for_update:
            query = query.with_for_update()
        return query.order_by(RuntimeBinding.updated_at.desc()).first()


runtime_profile_service = RuntimeProfileService()
