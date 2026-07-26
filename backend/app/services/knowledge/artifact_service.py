# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Business logic for knowledge-base generated artifacts."""

from __future__ import annotations

import re
from datetime import datetime
from uuid import uuid4

from sqlalchemy import and_, case, func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.knowledge import DocumentIndexStatus, KnowledgeDocument
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.user import User
from app.schemas.knowledge_artifact import (
    KnowledgeArtifact,
    KnowledgeArtifactCreate,
    KnowledgeArtifactExecutionHealth,
    KnowledgeArtifactListResponse,
    KnowledgeArtifactStatus,
    KnowledgeArtifactType,
    MindMapContent,
    MindMapNode,
)
from app.services.knowledge.artifact_repository import KnowledgeArtifactRepository
from app.services.knowledge.artifact_task_launcher import ArtifactTaskLauncher
from app.services.knowledge.knowledge_service import KnowledgeService
from app.stores.tasks import SubtaskStore, TaskStore, subtask_store, task_store
from shared.models.db import Kind

_JSON_BLOCK = re.compile(r"```json\s*(.*?)```", re.IGNORECASE | re.DOTALL)
_ACTIVE_STATUSES = {
    KnowledgeArtifactStatus.QUEUED,
    KnowledgeArtifactStatus.RUNNING,
}
_PROCESSING_DOCUMENT_STATUSES = (
    DocumentIndexStatus.QUEUED,
    DocumentIndexStatus.PENDING_CONVERSION,
    DocumentIndexStatus.CONVERTING,
    DocumentIndexStatus.INDEXING,
)


class ArtifactNotFoundError(LookupError):
    """The knowledge base or Artifact is not accessible."""


class ArtifactPermissionError(PermissionError):
    """The user cannot mutate Artifacts in this knowledge base."""


class ArtifactValidationError(ValueError):
    """The request or generated output does not meet the Artifact contract."""


class ArtifactService:
    """Coordinate permissions, durable persistence, and agent execution."""

    def __init__(
        self,
        db: Session,
        user: User,
        repository: KnowledgeArtifactRepository,
        *,
        launcher: ArtifactTaskLauncher | None = None,
        task_resource_store: TaskStore = task_store,
        subtask_resource_store: SubtaskStore = subtask_store,
    ) -> None:
        self.db = db
        self.user = user
        self.repository = repository
        self.launcher = launcher or ArtifactTaskLauncher(db, user)
        self.task_store = task_resource_store
        self.subtask_store = subtask_resource_store

    async def create(
        self,
        knowledge_base_id: int,
        request: KnowledgeArtifactCreate,
    ) -> KnowledgeArtifact:
        """Persist a queued Artifact and launch its background Task."""
        self._require_read_access(knowledge_base_id)
        document_ids = self._resolve_document_ids(
            knowledge_base_id,
            request.document_ids,
        )
        prepared_team = await self.launcher.preflight()
        now = datetime.now().astimezone()
        artifact = KnowledgeArtifact(
            artifact_id=str(uuid4()),
            knowledge_base_id=knowledge_base_id,
            artifact_type=request.artifact_type,
            title=self._default_title(request),
            status=KnowledgeArtifactStatus.QUEUED,
            source_document_ids=document_ids,
            generation_config={"instruction": request.instruction},
            user_id=self.user.id,
            created_at=now,
            updated_at=now,
        )
        persisted = self.repository.create(artifact)
        return await self._launch(persisted, prepared_team=prepared_team)

    async def list(
        self,
        knowledge_base_id: int,
        *,
        limit: int = 50,
    ) -> KnowledgeArtifactListResponse:
        """List recent Artifacts and reconcile active generations."""
        self._require_read_access(knowledge_base_id)
        artifacts = self.repository.list_by_knowledge_base(
            knowledge_base_id,
            limit=limit,
        )
        reconciled = await self._reconcile_many(artifacts)
        can_manage = KnowledgeService.can_manage_knowledge_base_documents(
            self.db,
            knowledge_base_id,
            self.user.id,
        )
        for artifact in reconciled:
            self._set_delete_capability(artifact, can_manage=can_manage)
        available_document_count, processing_document_count = (
            self._document_source_counts(knowledge_base_id)
        )
        return KnowledgeArtifactListResponse(
            items=reconciled,
            can_manage=can_manage,
            available_document_count=available_document_count,
            processing_document_count=processing_document_count,
        )

    async def get(
        self,
        knowledge_base_id: int,
        artifact_id: str,
    ) -> KnowledgeArtifact:
        """Get and reconcile one Artifact."""
        self._require_read_access(knowledge_base_id)
        artifact = await self._get_artifact(knowledge_base_id, artifact_id)
        reconciled = await self._reconcile(artifact)
        self._set_delete_capability(reconciled)
        return reconciled

    async def rename(
        self,
        knowledge_base_id: int,
        artifact_id: str,
        title: str,
    ) -> KnowledgeArtifact:
        """Rename one Artifact."""
        self._require_manage_access(knowledge_base_id)
        artifact = self.repository.rename(
            knowledge_base_id,
            artifact_id,
            title.strip(),
        )
        if artifact is None:
            raise ArtifactNotFoundError("Artifact not found")
        reconciled = await self._reconcile(artifact)
        self._set_delete_capability(reconciled, can_manage=True)
        return reconciled

    async def retry(
        self,
        knowledge_base_id: int,
        artifact_id: str,
    ) -> KnowledgeArtifact:
        """Retry a failed or stalled Artifact without changing its stable ID."""
        self._require_read_access(knowledge_base_id)
        artifact = await self._get_artifact(knowledge_base_id, artifact_id)
        artifact = await self._reconcile(artifact)
        if not artifact.can_retry:
            raise ArtifactValidationError(
                "Only failed or stalled artifacts can be retried"
            )
        prepared_team = await self.launcher.preflight()
        claimed, did_claim = self.repository.claim_retry(
            knowledge_base_id,
            artifact_id,
            expected_attempt=artifact.attempt,
            allow_active=(
                artifact.execution_health == KnowledgeArtifactExecutionHealth.STALLED
            ),
        )
        if claimed is None:
            raise ArtifactNotFoundError("Artifact not found")
        if not did_claim:
            raise ArtifactValidationError(
                "Only failed or stalled artifacts can be retried"
            )
        return await self._launch(claimed, prepared_team=prepared_team)

    async def delete(self, knowledge_base_id: int, artifact_id: str) -> None:
        """Delete the Artifact record without deleting its Task."""
        self._require_read_access(knowledge_base_id)
        artifact = await self._get_artifact(knowledge_base_id, artifact_id)
        artifact = await self._reconcile(artifact)
        can_manage = KnowledgeService.can_manage_knowledge_base_documents(
            self.db,
            knowledge_base_id,
            self.user.id,
        )
        if artifact.user_id != self.user.id and not can_manage:
            raise ArtifactPermissionError("Artifact deletion is not allowed")
        if (
            artifact.status in _ACTIVE_STATUSES
            and artifact.execution_health != KnowledgeArtifactExecutionHealth.STALLED
        ):
            raise ArtifactValidationError(
                "Active artifacts cannot be deleted before generation finishes"
            )
        if self.repository.delete(
            knowledge_base_id,
            artifact_id,
            expected_attempt=artifact.attempt,
        ):
            return
        if self.repository.get(knowledge_base_id, artifact_id) is None:
            raise ArtifactNotFoundError("Artifact not found")
        raise ArtifactValidationError("Artifact execution state has changed")

    def resolve_mind_map_node(
        self,
        knowledge_base_id: int,
        artifact_id: str,
        node_id: str,
    ) -> tuple[MindMapNode, list[int]]:
        """Resolve one interactive node and its currently usable source scope."""
        self._require_read_access(knowledge_base_id)
        artifact = self.repository.get(knowledge_base_id, artifact_id)
        if artifact is None:
            raise ArtifactNotFoundError("Artifact not found")
        if (
            artifact.status != KnowledgeArtifactStatus.SUCCEEDED
            or artifact.artifact_type != KnowledgeArtifactType.MIND_MAP
            or not artifact.content
        ):
            raise ArtifactValidationError("Interactive mind map is not available")

        try:
            mind_map = MindMapContent.model_validate_json(artifact.content)
        except ValueError as exc:
            raise ArtifactValidationError(
                "This mind map does not support interactive questions"
            ) from exc

        node = next((item for item in mind_map.nodes if item.id == node_id), None)
        if node is None:
            raise ArtifactValidationError("Mind map node not found")

        available_ids = {
            row[0]
            for row in (
                self.db.query(KnowledgeDocument.id)
                .filter(
                    KnowledgeDocument.kind_id == knowledge_base_id,
                    KnowledgeDocument.id.in_(artifact.source_document_ids),
                    KnowledgeDocument.index_status == DocumentIndexStatus.SUCCESS,
                    KnowledgeDocument.is_active.is_(True),
                )
                .all()
            )
        }
        source_document_ids = [
            document_id
            for document_id in artifact.source_document_ids
            if document_id in available_ids
        ]
        if not source_document_ids:
            raise ArtifactValidationError(
                "Mind map source documents are no longer available"
            )
        return node, source_document_ids

    async def _launch(
        self,
        artifact: KnowledgeArtifact,
        *,
        prepared_team: Kind,
    ) -> KnowledgeArtifact:
        try:
            launch = await self.launcher.launch(
                artifact_id=artifact.artifact_id,
                attempt=artifact.attempt,
                artifact_type=artifact.artifact_type,
                title=artifact.title,
                knowledge_base_id=artifact.knowledge_base_id,
                document_ids=artifact.source_document_ids,
                instruction=artifact.generation_config.get("instruction"),
                prepared_team=prepared_team,
            )
        except Exception as exc:
            artifact.status = KnowledgeArtifactStatus.FAILED
            artifact.error_message = str(exc) or "Failed to start artifact generation"
            artifact.completed_at = datetime.now().astimezone()
            artifact.updated_at = artifact.completed_at
            self.repository.update_execution(artifact)
            raise

        artifact.task_id = launch.task_id
        artifact.assistant_subtask_id = launch.assistant_subtask_id
        artifact.status = KnowledgeArtifactStatus.RUNNING
        artifact.updated_at = datetime.now().astimezone()
        return self.repository.update_execution(artifact) or artifact

    async def _reconcile(self, artifact: KnowledgeArtifact) -> KnowledgeArtifact:
        if artifact.status not in _ACTIVE_STATUSES:
            return self._apply_execution_health(artifact)
        execution_ids_changed = False
        if artifact.assistant_subtask_id is None:
            self._repair_execution_ids(artifact)
            if artifact.assistant_subtask_id is None:
                return self._apply_execution_health(artifact)
            execution_ids_changed = True

        subtask = self.subtask_store.get_by_id_and_role(
            self.db,
            subtask_id=artifact.assistant_subtask_id,
            role=SubtaskRole.ASSISTANT,
        )
        if subtask is None:
            if execution_ids_changed:
                artifact.updated_at = datetime.now().astimezone()
                artifact = self.repository.update_execution(artifact) or artifact
            return self._apply_execution_health(artifact)
        reconciled = await self._apply_subtask_status(
            artifact,
            subtask,
            changed=execution_ids_changed,
        )
        return self._apply_execution_health(reconciled, subtask)

    async def _reconcile_many(
        self,
        artifacts: list[KnowledgeArtifact],
    ) -> list[KnowledgeArtifact]:
        repaired_ids: set[str] = set()
        for artifact in artifacts:
            if (
                artifact.status in _ACTIVE_STATUSES
                and artifact.assistant_subtask_id is None
            ):
                self._repair_execution_ids(artifact)
                if artifact.assistant_subtask_id is not None:
                    repaired_ids.add(artifact.artifact_id)

        subtask_ids = {
            artifact.assistant_subtask_id
            for artifact in artifacts
            if artifact.status in _ACTIVE_STATUSES
            and artifact.assistant_subtask_id is not None
        }
        subtasks = self.subtask_store.list_by_ids_and_role(
            self.db,
            subtask_ids=list(subtask_ids),
            role=SubtaskRole.ASSISTANT,
        )
        subtasks_by_id = {subtask.id: subtask for subtask in subtasks}
        reconciled: list[KnowledgeArtifact] = []
        for artifact in artifacts:
            if artifact.status not in _ACTIVE_STATUSES:
                reconciled.append(self._apply_execution_health(artifact))
                continue
            subtask = subtasks_by_id.get(artifact.assistant_subtask_id)
            if subtask is None:
                if artifact.artifact_id in repaired_ids:
                    artifact.updated_at = datetime.now().astimezone()
                    artifact = self.repository.update_execution(artifact) or artifact
                reconciled.append(self._apply_execution_health(artifact))
                continue
            current = await self._apply_subtask_status(
                artifact,
                subtask,
                changed=artifact.artifact_id in repaired_ids,
            )
            reconciled.append(self._apply_execution_health(current, subtask))
        return reconciled

    async def _apply_subtask_status(
        self,
        artifact: KnowledgeArtifact,
        subtask: Subtask,
        *,
        changed: bool,
    ) -> KnowledgeArtifact:
        status = self._subtask_status(subtask)
        if status == SubtaskStatus.PENDING.value:
            changed = changed or artifact.status != KnowledgeArtifactStatus.QUEUED
            artifact.status = KnowledgeArtifactStatus.QUEUED
        elif status == SubtaskStatus.RUNNING.value:
            changed = changed or artifact.status != KnowledgeArtifactStatus.RUNNING
            artifact.status = KnowledgeArtifactStatus.RUNNING
        elif status == SubtaskStatus.COMPLETED.value:
            self._apply_completed_result(artifact, subtask)
            changed = True
        elif status in {
            SubtaskStatus.FAILED.value,
            SubtaskStatus.CANCELLED.value,
            SubtaskStatus.DELETE.value,
        }:
            artifact.status = KnowledgeArtifactStatus.FAILED
            result = subtask.result if isinstance(subtask.result, dict) else {}
            artifact.error_code = result.get("error_type")
            artifact.error_message = (
                subtask.error_message or "Artifact generation failed"
            )
            artifact.completed_at = subtask.completed_at or datetime.now().astimezone()
            changed = True

        if changed:
            artifact.updated_at = datetime.now().astimezone()
            return self.repository.update_execution(artifact) or artifact
        return artifact

    def _apply_completed_result(
        self,
        artifact: KnowledgeArtifact,
        subtask: Subtask,
    ) -> None:
        result = subtask.result if isinstance(subtask.result, dict) else {}
        raw_content = result.get("value")
        content = raw_content.strip() if isinstance(raw_content, str) else ""
        try:
            artifact.content = self._parse_content(artifact.artifact_type, content)
            artifact.status = KnowledgeArtifactStatus.SUCCEEDED
            artifact.error_code = None
            artifact.error_message = None
        except ArtifactValidationError as exc:
            artifact.content = None
            artifact.status = KnowledgeArtifactStatus.FAILED
            artifact.error_code = "INVALID_GENERATED_RESULT"
            artifact.error_message = str(exc)
        artifact.completed_at = subtask.completed_at or datetime.now().astimezone()

    def _apply_execution_health(
        self,
        artifact: KnowledgeArtifact,
        subtask: Subtask | None = None,
    ) -> KnowledgeArtifact:
        artifact.execution_health = KnowledgeArtifactExecutionHealth.HEALTHY
        artifact.can_retry = artifact.status == KnowledgeArtifactStatus.FAILED
        if artifact.status in _ACTIVE_STATUSES and self._is_stalled(
            artifact,
            subtask,
        ):
            artifact.execution_health = KnowledgeArtifactExecutionHealth.STALLED
            artifact.can_retry = True
        return artifact

    @staticmethod
    def _is_stalled(
        artifact: KnowledgeArtifact,
        subtask: Subtask | None,
    ) -> bool:
        activity_at = artifact.updated_at
        if subtask is not None:
            activity_at = subtask.updated_at or subtask.created_at or activity_at
        aware_now = datetime.now().astimezone()
        now = (
            aware_now.replace(tzinfo=None) if activity_at.tzinfo is None else aware_now
        )
        stall_seconds = max(1, settings.KNOWLEDGE_ARTIFACT_STALL_SECONDS)
        return (now - activity_at).total_seconds() >= stall_seconds

    @staticmethod
    def _subtask_status(subtask: Subtask) -> str:
        return (
            subtask.status.value
            if isinstance(subtask.status, SubtaskStatus)
            else str(subtask.status)
        ).upper()

    @staticmethod
    def _parse_content(
        artifact_type: KnowledgeArtifactType,
        content: str,
    ) -> str:
        if not content:
            raise ArtifactValidationError("Generated result is empty")
        if artifact_type == KnowledgeArtifactType.BRIEFING:
            return content
        matches = _JSON_BLOCK.findall(content)
        if matches:
            if len(matches) != 1 or not matches[0].strip():
                raise ArtifactValidationError(
                    "Generated mind map must contain exactly one JSON object"
                )
            content = matches[0].strip()
        try:
            mind_map = MindMapContent.model_validate_json(content)
        except ValueError as exc:
            raise ArtifactValidationError(
                "Generated mind map must be a valid interactive tree"
            ) from exc
        return mind_map.model_dump_json()

    def _repair_execution_ids(self, artifact: KnowledgeArtifact) -> None:
        task = self.task_store.get_owned_task_by_name(
            self.db,
            user_id=artifact.user_id,
            name=f"knowledge-artifact-{artifact.artifact_id}-{artifact.attempt}",
            namespace="default",
        )
        if task is None:
            return
        assistant = self.subtask_store.get_latest_assistant_by_statuses(
            self.db,
            task_id=task.id,
            statuses=list(SubtaskStatus),
            owner_user_id=artifact.user_id,
        )
        if assistant is None:
            return
        artifact.task_id = task.id
        artifact.assistant_subtask_id = assistant.id

    def _resolve_document_ids(
        self,
        knowledge_base_id: int,
        requested_ids: list[int],
    ) -> list[int]:
        query = self.db.query(KnowledgeDocument).filter(
            KnowledgeDocument.kind_id == knowledge_base_id,
            KnowledgeDocument.index_status == DocumentIndexStatus.SUCCESS,
            KnowledgeDocument.is_active.is_(True),
        )
        if requested_ids:
            documents = query.filter(KnowledgeDocument.id.in_(requested_ids)).all()
            found_ids = {document.id for document in documents}
            if found_ids != set(requested_ids):
                raise ArtifactValidationError(
                    "Documents must belong to this knowledge base and be indexed"
                )
            return requested_ids

        document_ids = [
            row[0]
            for row in query.order_by(KnowledgeDocument.id.asc()).with_entities(
                KnowledgeDocument.id
            )
        ]
        if not document_ids:
            raise ArtifactValidationError("Knowledge base has no indexed documents")
        return document_ids

    def _document_source_counts(self, knowledge_base_id: int) -> tuple[int, int]:
        """Count usable and processing documents for Artifact generation."""
        available_count, processing_count = (
            self.db.query(
                func.sum(
                    case(
                        (
                            and_(
                                KnowledgeDocument.is_active.is_(True),
                                KnowledgeDocument.index_status
                                == DocumentIndexStatus.SUCCESS,
                            ),
                            1,
                        ),
                        else_=0,
                    )
                ),
                func.sum(
                    case(
                        (
                            KnowledgeDocument.index_status.in_(
                                _PROCESSING_DOCUMENT_STATUSES
                            ),
                            1,
                        ),
                        else_=0,
                    )
                ),
            )
            .filter(KnowledgeDocument.kind_id == knowledge_base_id)
            .one()
        )
        return int(available_count or 0), int(processing_count or 0)

    async def _get_artifact(
        self,
        knowledge_base_id: int,
        artifact_id: str,
    ) -> KnowledgeArtifact:
        artifact = self.repository.get(knowledge_base_id, artifact_id)
        if artifact is None:
            raise ArtifactNotFoundError("Artifact not found")
        return artifact

    def _require_read_access(self, knowledge_base_id: int) -> None:
        knowledge_base, has_access = KnowledgeService.get_knowledge_base(
            self.db,
            knowledge_base_id,
            self.user.id,
        )
        if knowledge_base is None or not has_access:
            raise ArtifactNotFoundError("Knowledge base not found")

    def _require_manage_access(self, knowledge_base_id: int) -> None:
        self._require_read_access(knowledge_base_id)
        if not KnowledgeService.can_manage_knowledge_base_documents(
            self.db,
            knowledge_base_id,
            self.user.id,
        ):
            raise ArtifactPermissionError("Artifact management is not allowed")

    def _set_delete_capability(
        self,
        artifact: KnowledgeArtifact,
        *,
        can_manage: bool | None = None,
    ) -> None:
        if can_manage is None:
            can_manage = KnowledgeService.can_manage_knowledge_base_documents(
                self.db,
                artifact.knowledge_base_id,
                self.user.id,
            )
        is_active = (
            artifact.status in _ACTIVE_STATUSES
            and artifact.execution_health != KnowledgeArtifactExecutionHealth.STALLED
        )
        artifact.can_delete = (
            artifact.user_id == self.user.id or can_manage
        ) and not is_active

    @staticmethod
    def _default_title(request: KnowledgeArtifactCreate) -> str:
        if request.title and request.title.strip():
            return request.title.strip()
        if request.artifact_type == KnowledgeArtifactType.MIND_MAP:
            return "知识库思维导图"
        return "知识库简报"
