# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Implementation of specific Kind services
"""

import json as jsonlib
import logging
from typing import Any, Dict

from sqlalchemy import String, cast, or_
from sqlalchemy.orm import Session

from app.core.exceptions import NotFoundException
from app.models.kind import Kind
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.schemas.kind import Bot, Model, Retriever, Task, Team
from app.services.adapters.task_kinds import task_kinds_service
from app.services.kind_base import KindBaseService, TaskResourceBaseService
from app.services.model_embedding_dimension import (
    validate_embedding_dimension_declaration,
)
from app.stores.tasks import subtask_store, task_store
from app.utils.client_payload_sanitizer import sanitize_client_payload
from shared.utils.crypto import decrypt_api_key, encrypt_api_key, is_api_key_encrypted

logger = logging.getLogger(__name__)


def _escape_like(value: str) -> str:
    """Escape LIKE wildcards in a resource name."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _json_text_mentions_any(names: list[str]):
    """SQL prefilter: rows whose serialized JSON mentions any given name.

    Names are JSON-serialized first so quotes and backslashes match their
    escaped representation inside the stored JSON document. Both the
    ASCII-escaped and raw-unicode serializations are matched because JSON
    text serialization differs by driver/dialect (e.g. SQLite stores
    \\uXXXX escapes while MySQL keeps raw UTF-8 characters).

    This is only a coarse filter to avoid scanning and parsing every row;
    callers must still verify references precisely in Python. Over-matching
    (e.g. substring collisions) is therefore safe.
    """
    patterns = []
    for name in names:
        serialized_variants = {
            jsonlib.dumps(name, ensure_ascii=False),
            jsonlib.dumps(name, ensure_ascii=True),
        }
        for variant in serialized_variants:
            patterns.append(
                cast(Kind.json, String).like(f"%{_escape_like(variant)}%", escape="\\")
            )
    return or_(*patterns)


class GhostKindService(KindBaseService):
    """Service for Ghost resources"""

    def __init__(self):
        super().__init__("Ghost")

    def _validate_references(
        self, db: Session, user_id: int, resource: Dict[str, Any]
    ) -> None:
        """Validate skill references for Ghost"""
        from app.schemas.kind import Ghost

        ghost_crd = Ghost.model_validate(resource)

        # Validate skills if provided
        if ghost_crd.spec.skills:
            self._validate_skills(db, ghost_crd.spec.skills, user_id)

    def _validate_skills(self, db: Session, skill_names: list, user_id: int) -> None:
        """
        Validate that all skill names exist for the user or as system skills.

        Args:
            db: Database session
            skill_names: List of skill names to validate
            user_id: User ID

        Raises:
            NotFoundException: If any skill does not exist
        """
        from sqlalchemy import or_

        if not skill_names:
            return

        # Query all skills at once for efficiency
        # Include both user's skills (user_id == user_id) and system skills (user_id == 0)
        existing_skills = (
            db.query(Kind)
            .filter(
                or_(Kind.user_id == user_id, Kind.user_id == 0),
                Kind.kind == "Skill",
                Kind.name.in_(skill_names),
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .all()
        )

        existing_skill_names = {skill.name for skill in existing_skills}
        missing_skills = [
            name for name in skill_names if name not in existing_skill_names
        ]

        if missing_skills:
            raise NotFoundException(
                f"The following Skills do not exist: {', '.join(missing_skills)}"
            )


class ModelKindService(KindBaseService):
    """Service for Model resources"""

    def __init__(self):
        super().__init__("Model")

    def _validate_references(
        self, db: Session, user_id: int, resource: Dict[str, Any]
    ) -> None:
        """Guard the Model write contract.

        Model resources have no references to validate; the hook carries the
        embedding dimension declaration rules that every write must satisfy.
        """
        metadata = resource.get("metadata") or {}
        name = metadata.get("name")
        if not name:
            return

        stored = self.get_resource(
            user_id,
            metadata.get("namespace", "default"),
            name,
        )
        validate_embedding_dimension_declaration(
            spec=resource.get("spec") or {},
            stored_spec=(stored.json or {}).get("spec") if stored else None,
            name=name,
        )

    def _extract_resource_data(self, resource: Dict[str, Any]) -> Dict[str, Any]:
        """Extract and encrypt API key in Model resource data"""
        # Call parent method first
        resource_data = super()._extract_resource_data(resource)

        try:
            if "spec" in resource_data and "modelConfig" in resource_data["spec"]:
                model_config = resource_data["spec"]["modelConfig"]
                if "env" in model_config and "api_key" in model_config["env"]:
                    api_key = model_config["env"]["api_key"]
                    if api_key and api_key != "***":
                        # Only encrypt if not already encrypted
                        if not is_api_key_encrypted(api_key):
                            resource_data["spec"]["modelConfig"]["env"]["api_key"] = (
                                encrypt_api_key(api_key)
                            )
                            logger.info("Encrypted API key for Model resource")
        except ValueError as e:
            logger.exception("Failed to encrypt API key: %r", e)
            raise

        return resource_data

    def _format_resource(self, resource: Kind) -> Dict[str, Any]:
        """Format Model resource for API response with decrypted API key"""
        # Get the stored resource data
        result = super()._format_resource(resource)

        # Decrypt API key for display
        try:
            if "spec" in result and "modelConfig" in result["spec"]:
                model_config = result["spec"]["modelConfig"]
                if "env" in model_config and "api_key" in model_config["env"]:
                    api_key = model_config["env"]["api_key"]
                    if api_key:
                        result["spec"]["modelConfig"]["env"]["api_key"] = (
                            decrypt_api_key(api_key)
                        )
        except (ValueError, KeyError) as e:
            logger.warning("Failed to decrypt API key: %r", e)

        return result


class ShellKindService(KindBaseService):
    """Service for Shell resources"""

    def __init__(self):
        super().__init__("Shell")

    def _validate_references(
        self, db: Session, user_id: int, resource: Dict[str, Any]
    ) -> None:
        """No references to validate for Shell"""
        pass


class BotKindService(KindBaseService):
    """Service for Bot resources"""

    def __init__(self):
        super().__init__("Bot")

    def _validate_references(
        self, db: Session, user_id: int, resource: Dict[str, Any]
    ) -> None:
        """Validate Ghost, Shell, and Model references"""
        bot_crd = Bot.model_validate(resource)

        # Check if referenced ghost exists
        ghost_name = bot_crd.spec.ghostRef.name
        ghost_namespace = bot_crd.spec.ghostRef.namespace or "default"

        ghost = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Ghost",
                Kind.namespace == ghost_namespace,
                Kind.name == ghost_name,
                Kind.is_active == True,
            )
            .first()
        )
        if not ghost:
            raise NotFoundException(
                f"Ghost '{ghost_name}' not found in namespace '{ghost_namespace}'"
            )

        # Check if referenced shell exists (check user's Shell first, then public shells)
        shell_name = bot_crd.spec.shellRef.name
        shell_namespace = bot_crd.spec.shellRef.namespace or "default"

        from app.services.adapters.shell_utils import get_shell_by_name

        shell = get_shell_by_name(
            db,
            shell_name,
            user_id,
            shell_namespace,
        )
        if not shell:
            raise NotFoundException(
                f"Shell '{shell_name}' not found in namespace '{shell_namespace}' or in public shells"
            )

    def _get_ghost_data(
        self, db: Session, user_id: int, name: str, namespace: str
    ) -> Dict[str, Any]:
        """Get ghost data from Kind table"""
        ghost = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Ghost",
                Kind.namespace == namespace,
                Kind.name == name,
                Kind.is_active == True,
            )
            .first()
        )

        return ghost.json

    def _get_shell_data(
        self, db: Session, user_id: int, name: str, namespace: str
    ) -> Dict[str, Any]:
        """Get shell data from Kind table, fallback to public shells if not found"""
        # First try to find in user's shells
        shell = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Shell",
                Kind.namespace == namespace,
                Kind.name == name,
                Kind.is_active == True,
            )
            .first()
        )

        if shell:
            return shell.json

        # If not found in user's shells, try to find in public shells (user_id=0)
        public_shell = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Shell",
                Kind.name == name,
                Kind.namespace == namespace,
                Kind.is_active == True,
            )
            .first()
        )

        if public_shell:
            return public_shell.json

        # If still not found, return None or raise exception
        raise NotFoundException(
            f"Shell '{name}' not found in namespace '{namespace}' or in public shells"
        )

    def _get_model_data(
        self, db: Session, user_id: int, name: str, namespace: str
    ) -> Dict[str, Any]:
        """Get model data from Kind table"""
        model = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Model",
                Kind.namespace == namespace,
                Kind.name == name,
                Kind.is_active == True,
            )
            .first()
        )

        return model.json


class KnowledgeBaseKindService(KindBaseService):
    """Service for KnowledgeBase resources"""

    def __init__(self):
        super().__init__("KnowledgeBase")

    def _validate_references(
        self, db: Session, user_id: int, resource: Dict[str, Any]
    ) -> None:
        """No references to validate for KnowledgeBase"""
        pass


class TeamKindService(KindBaseService):
    """Service for Team resources"""

    def __init__(self):
        super().__init__("Team")

    def _pre_delete_side_effects(
        self, db: Session, user_id: int, db_resource: Kind
    ) -> None:
        """Delete member Bots that would be orphaned by this Team deletion.

        Bots hold the modelRef/shellRef/ghostRef bindings, so a deleted Team
        leaves Bots that keep blocking capability unbind operations while being
        unreachable from any UI. Only Bots owned by the same user and living in
        the same namespace as the Team are removed, and only when no other
        active Team still references them.

        Known limitation: for group namespaces, ``Kind.user_id`` is the
        creator rather than the namespace owner, so a Bot created by another
        group member is never cleaned up here, even when no other Team
        references it. This is intentional: leaving such Bots untouched is the
        safe fallback.
        """
        members = ((db_resource.json or {}).get("spec") or {}).get("members") or []
        candidates: set[tuple[str, str]] = set()
        for member in members:
            bot_ref = member.get("botRef", {}) if isinstance(member, dict) else {}
            bot_name = bot_ref.get("name")
            if not bot_name:
                continue
            bot_namespace = bot_ref.get("namespace") or "default"
            if bot_namespace != db_resource.namespace:
                continue
            candidates.add((bot_name, bot_namespace))

        if not candidates:
            return

        bots = (
            db.query(Kind)
            .filter(
                Kind.kind == "Bot",
                Kind.namespace == db_resource.namespace,
                Kind.name.in_([name for name, _ in candidates]),
                Kind.is_active == True,
            )
            .all()
        )
        if not bots:
            return

        referenced = self._find_bots_referenced_by_other_teams(
            db,
            exclude_team_id=db_resource.id,
            candidate_names=[name for name, _ in candidates],
        )
        bots_to_delete: list[Kind] = []
        for bot in bots:
            if bot.user_id != db_resource.user_id:
                continue
            # In the default namespace resources are per-user: a reference
            # from another user's Team points at that user's Bot, not this one.
            if bot.namespace == "default":
                key = (bot.name, bot.namespace, bot.user_id)
            else:
                key = (bot.name, bot.namespace, None)
            if key in referenced:
                continue
            bots_to_delete.append(bot)

        if not bots_to_delete:
            return

        self._delete_orphaned_ghosts(db, team=db_resource, bots=bots_to_delete)
        for bot in bots_to_delete:
            db.delete(bot)
            logger.info(
                "Deleted orphaned Bot '%s' in namespace '%s' while deleting Team '%s' "
                "(team_id=%s, bot_id=%s)",
                bot.name,
                bot.namespace,
                db_resource.name,
                db_resource.id,
                bot.id,
            )

    def _delete_orphaned_ghosts(
        self, db: Session, *, team: Kind, bots: list[Kind]
    ) -> None:
        """Delete Ghosts that are exclusive to the Bots being deleted.

        A Ghost is only removed when it belongs to the Team owner and no other
        active Bot references it. Ghost references in the default namespace are
        per-user: a reference from another user's Bot points at that user's
        Ghost and does not block deletion.
        """
        ghosts: dict[tuple[str, str], Kind] = {}
        for bot in bots:
            ghost_ref = ((bot.json or {}).get("spec") or {}).get("ghostRef") or {}
            ghost_name = ghost_ref.get("name")
            if not ghost_name:
                continue
            ghost_namespace = ghost_ref.get("namespace") or "default"
            if (ghost_name, ghost_namespace) in ghosts:
                continue
            query = db.query(Kind).filter(
                Kind.kind == "Ghost",
                Kind.namespace == ghost_namespace,
                Kind.name == ghost_name,
                Kind.is_active == True,
            )
            if ghost_namespace == "default":
                query = query.filter(Kind.user_id == team.user_id)
            ghost = query.first()
            if ghost is None or ghost.user_id != team.user_id:
                continue
            ghosts[(ghost_name, ghost_namespace)] = ghost

        if not ghosts:
            return

        deleted_bot_ids = {bot.id for bot in bots}
        referenced: set[tuple[str, str, int | None]] = set()
        other_bots = (
            db.query(Kind)
            .filter(
                Kind.kind == "Bot",
                Kind.is_active == True,
                Kind.id.notin_(deleted_bot_ids),
                _json_text_mentions_any([name for name, _ in ghosts]),
            )
            .yield_per(100)
        )
        for other in other_bots:
            other_ref = ((other.json or {}).get("spec") or {}).get("ghostRef") or {}
            other_name = other_ref.get("name")
            if not other_name:
                continue
            other_namespace = other_ref.get("namespace") or "default"
            if other_namespace == "default":
                referenced.add((other_name, other_namespace, other.user_id))
            else:
                referenced.add((other_name, other_namespace, None))

        for (ghost_name, ghost_namespace), ghost in ghosts.items():
            if ghost_namespace == "default":
                key = (ghost_name, ghost_namespace, ghost.user_id)
            else:
                key = (ghost_name, ghost_namespace, None)
            if key in referenced:
                continue
            db.delete(ghost)
            logger.info(
                "Deleted orphaned Ghost '%s' in namespace '%s' while deleting Team "
                "'%s' (ghost_id=%s, team_id=%s)",
                ghost_name,
                ghost_namespace,
                team.name,
                ghost.id,
                team.id,
            )

    @staticmethod
    def _find_bots_referenced_by_other_teams(
        db: Session, *, exclude_team_id: int, candidate_names: list[str]
    ) -> set[tuple[str, str, int | None]]:
        """Collect references to Bots from other active Teams.

        Returns (name, namespace, user_id) keys. ``user_id`` is set for
        references into the default namespace, because default-namespace
        resources are per-user; group-namespace references use ``None`` as a
        wildcard since they resolve namespace-wide.

        The scan cannot be narrowed by ``Kind.namespace``: a Team in any
        namespace may reference this Bot through an explicit cross-namespace
        ``botRef``. A coarse SQL text filter on the candidate Bot names keeps
        the scan small; matches are verified precisely in Python. Results are
        streamed to keep memory bounded on large installations.
        """
        referenced: set[tuple[str, str, int | None]] = set()
        other_teams = (
            db.query(Kind)
            .filter(
                Kind.kind == "Team",
                Kind.is_active == True,
                Kind.id != exclude_team_id,
                _json_text_mentions_any(candidate_names),
            )
            .yield_per(100)
        )
        for other in other_teams:
            members = ((other.json or {}).get("spec") or {}).get("members") or []
            for member in members:
                bot_ref = member.get("botRef", {}) if isinstance(member, dict) else {}
                bot_name = bot_ref.get("name")
                if not bot_name:
                    continue
                bot_namespace = bot_ref.get("namespace") or "default"
                if bot_namespace == "default":
                    referenced.add((bot_name, bot_namespace, other.user_id))
                else:
                    referenced.add((bot_name, bot_namespace, None))
        return referenced

    def _validate_references(
        self, db: Session, user_id: int, resource: Dict[str, Any]
    ) -> None:
        """Validate Bot references and workflow configuration"""
        team_crd = Team.model_validate(resource)

        # Check if all referenced bots exist
        for member in team_crd.spec.members:
            bot_name = member.botRef.name
            bot_namespace = member.botRef.namespace or "default"

            bot = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Bot",
                    Kind.namespace == bot_namespace,
                    Kind.name == bot_name,
                    Kind.is_active == True,
                )
                .first()
            )

            if not bot:
                raise NotFoundException(
                    f"Bot '{bot_name}' not found in namespace '{bot_namespace}'"
                )


class WorkspaceKindService(TaskResourceBaseService):
    """Service for Workspace resources (uses tasks table)"""

    def __init__(self):
        super().__init__("Workspace")

    def _validate_references(
        self, db: Session, user_id: int, resource: Dict[str, Any]
    ) -> None:
        """No references to validate for Workspace"""
        pass


class TaskKindService(TaskResourceBaseService):
    """Service for Task resources (uses tasks table)"""

    def __init__(self):
        super().__init__("Task")

    def _validate_references(
        self, db: Session, user_id: int, resource: Dict[str, Any]
    ) -> None:
        """Validate Team and Workspace references"""
        task_crd = Task.model_validate(resource)

        # Check if referenced team exists
        team_name = task_crd.spec.teamRef.name
        team_namespace = task_crd.spec.teamRef.namespace or "default"

        team = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Team",
                Kind.namespace == team_namespace,
                Kind.name == team_name,
                Kind.is_active == True,
            )
            .first()
        )

        if not team:
            raise NotFoundException(
                f"Team '{team_name}' not found in namespace '{team_namespace}'"
            )

        # Check if referenced workspace exists
        workspace_name = task_crd.spec.workspaceRef.name
        workspace_namespace = task_crd.spec.workspaceRef.namespace or "default"

        workspace = task_store.get_workspace_by_ref(
            db,
            user_id=user_id,
            name=workspace_name,
            namespace=workspace_namespace,
        )

        if not workspace:
            raise NotFoundException(
                f"Workspace '{workspace_name}' not found in namespace '{workspace_namespace}'"
            )

        # Check the status of existing task, if not COMPLETED status, modification is not allowed
        existing_task = task_store.get_owned_task_by_name(
            db,
            user_id=user_id,
            name=resource["metadata"]["name"],
            namespace=resource["metadata"]["namespace"],
        )

        if existing_task:
            existing_task_crd = Task.model_validate(existing_task.json)

            if (
                existing_task_crd.status
                and existing_task_crd.status.status != "COMPLETED"
            ):
                raise NotFoundException(
                    f"Task '{resource['metadata']['name']}' in namespace '{resource['metadata']['namespace']}' cannot be modified when status is '{existing_task_crd.status.status}'. Only COMPLETED tasks can be updated."
                )

    def _perform_side_effects(
        self,
        db: Session,
        user_id: int,
        db_resource: TaskResource,
        resource: Dict[str, Any],
    ) -> None:
        """Create subtasks for the new task"""
        try:
            task_crd = Task.model_validate(resource)

            team = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Team",
                    Kind.name == task_crd.spec.teamRef.name,
                    Kind.namespace == task_crd.spec.teamRef.namespace,
                    Kind.is_active == True,
                )
                .first()
            )

            if not team:
                logger.error(f"Team not found: {task_crd.spec.teamRef.name}")
                return

            # Call _create_subtasks method to create subtasks
            task_kinds_service._create_subtasks(
                db=db,
                task=db_resource,
                team=team,
                user_id=user_id,
                user_prompt=task_crd.spec.prompt,
            )
            db.commit()

            # Push mode: dispatch task to executor_manager
            from app.services.execution import schedule_dispatch

            schedule_dispatch(db_resource.id)

        except Exception as e:
            # Log error but don't interrupt the process
            logger.error(f"Error creating subtasks: {str(e)}")

    def _update_side_effects(
        self,
        db: Session,
        user_id: int,
        db_resource: TaskResource,
        resource: Dict[str, Any],
    ) -> None:
        """Update subtasks for the existing task"""
        try:
            task_crd = Task.model_validate(resource)

            team = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Team",
                    Kind.name == task_crd.spec.teamRef.name,
                    Kind.namespace == task_crd.spec.teamRef.namespace,
                    Kind.is_active == True,
                )
                .first()
            )

            if not team:
                logger.error(f"Team not found: {task_crd.spec.teamRef.name}")
                return

            # Call _create_subtasks method to update subtasks (append mode)
            task_kinds_service._create_subtasks(
                db=db,
                task=db_resource,
                team=team,
                user_id=user_id,
                user_prompt=task_crd.spec.prompt,
            )
            db.commit()

            # Push mode: dispatch task to executor_manager
            from app.services.execution import schedule_dispatch

            schedule_dispatch(db_resource.id)

        except Exception as e:
            # Log error but don't interrupt the process
            logger.error(f"Error updating subtasks: {str(e)}")

    def _format_resource(self, resource: TaskResource) -> Dict[str, Any]:
        """Format Task resource for API response with enhanced status information"""
        # Get the stored resource data
        stored_resource = resource.json

        # Ensure metadata has the correct name and namespace from the database
        result = stored_resource.copy()

        # Update metadata with values from the database (in case they were changed)
        if "metadata" not in result:
            result["metadata"] = {}

        result["metadata"]["name"] = resource.name
        result["metadata"]["namespace"] = resource.namespace

        # Ensure apiVersion and kind are set correctly
        result["apiVersion"] = "agent.wecode.io/v1"
        result["kind"] = self.kind

        # Get database connection
        with self.get_db() as db:
            # Query all Subtasks for this Task
            subtasks = subtask_store.list_by_task_ordered(db, task_id=resource.id)

            # Build subtasks array
            subtask_list = []
            for subtask in subtasks:
                subtask_list.append(
                    {
                        "title": subtask.title,
                        "role": subtask.role,
                        "bot_ids": subtask.bot_ids,
                        "executor_namespace": subtask.executor_namespace,
                        "executor_name": subtask.executor_name,
                        "status": subtask.status,
                        "progress": subtask.progress,
                        "result": sanitize_client_payload(subtask.result),
                        "errorMessage": subtask.error_message,
                        "messageId": subtask.message_id,
                        "parentId": subtask.parent_id,
                        "createdAt": subtask.created_at,
                        "updatedAt": subtask.updated_at,
                        "completedAt": subtask.completed_at,
                    }
                )

            result["status"]["subTasks"] = subtask_list

        return result

    def _post_delete_side_effects(
        self, db: Session, user_id: int, db_resource: Kind
    ) -> None:
        """Perform side effects after Task deletion - delegate to task_kinds_service.delete_task"""
        try:
            # Call task_kinds_service's delete_task method to handle cleanup after deletion
            task_kinds_service.delete_task(
                db=db, task_id=db_resource.id, user_id=user_id
            )
        except Exception as e:
            logger.error(
                f"Error delegating Task deletion to task_kinds_service: {str(e)}"
            )

    def _should_delete_resource(
        self, db: Session, user_id: int, db_resource: Kind
    ) -> bool:
        return False


class RetrieverKindService(KindBaseService):
    """Service for Retriever resources"""

    def __init__(self):
        super().__init__("Retriever")

    def _validate_references(
        self, db: Session, user_id: int, resource: Dict[str, Any]
    ) -> None:
        """Validate Retriever configuration"""
        retriever_crd = Retriever.model_validate(resource)

        # Validate storage type
        storage_type = retriever_crd.spec.storageConfig.type
        valid_storage_types = ["elasticsearch", "qdrant"]
        if storage_type not in valid_storage_types:
            raise ValueError(
                f"Invalid storage type: {storage_type}. "
                f"Valid options: {', '.join(valid_storage_types)}"
            )

        # Validate index strategy mode
        index_mode = retriever_crd.spec.storageConfig.indexStrategy.mode
        valid_modes = ["fixed", "rolling", "per_dataset", "per_user"]
        if index_mode not in valid_modes:
            raise ValueError(
                f"Invalid index strategy mode: {index_mode}. "
                f"Valid options: {', '.join(valid_modes)}"
            )

    def _extract_resource_data(self, resource: Dict[str, Any]) -> Dict[str, Any]:
        """Extract and encrypt sensitive data in Retriever resource"""
        # Call parent method first
        resource_data = super()._extract_resource_data(resource)

        try:
            if "spec" in resource_data and "storageConfig" in resource_data["spec"]:
                storage_config = resource_data["spec"]["storageConfig"]

                # Encrypt password if present
                if "password" in storage_config:
                    password = storage_config["password"]
                    if password and password != "***":
                        if not is_api_key_encrypted(password):
                            resource_data["spec"]["storageConfig"]["password"] = (
                                encrypt_api_key(password)
                            )
                            logger.info("Encrypted password for Retriever resource")

                # Encrypt API key if present
                if "apiKey" in storage_config:
                    api_key = storage_config["apiKey"]
                    if api_key and api_key != "***":
                        if not is_api_key_encrypted(api_key):
                            resource_data["spec"]["storageConfig"]["apiKey"] = (
                                encrypt_api_key(api_key)
                            )
                            logger.info("Encrypted API key for Retriever resource")
        except ValueError as e:
            logger.exception("Failed to encrypt sensitive data: %r", e)
            raise

        return resource_data

    def _format_resource(self, resource: Kind) -> Dict[str, Any]:
        """Format Retriever resource for API response with decrypted sensitive data"""
        # Get the stored resource data
        result = super()._format_resource(resource)

        # Decrypt sensitive data for display
        try:
            if "spec" in result and "storageConfig" in result["spec"]:
                storage_config = result["spec"]["storageConfig"]

                # Decrypt password if present
                if "password" in storage_config:
                    password = storage_config["password"]
                    if password:
                        result["spec"]["storageConfig"]["password"] = decrypt_api_key(
                            password
                        )

                # Decrypt API key if present
                if "apiKey" in storage_config:
                    api_key = storage_config["apiKey"]
                    if api_key:
                        result["spec"]["storageConfig"]["apiKey"] = decrypt_api_key(
                            api_key
                        )
        except (ValueError, KeyError) as e:
            logger.warning("Failed to decrypt sensitive data: %r", e)

        return result


class DeviceKindService(KindBaseService):
    """Service for Device resources (local device management)"""

    def __init__(self):
        super().__init__("Device")

    def _validate_references(
        self, db: Session, user_id: int, resource: Dict[str, Any]
    ) -> None:
        """Validate device-specific constraints"""
        from app.schemas.kind import Device

        device_crd = Device.model_validate(resource)

        # If isDefault is True, we'll handle clearing other defaults in side effects
        # No other references to validate for Device

    def _perform_side_effects(
        self,
        db: Session,
        user_id: int,
        db_resource: Kind,
        resource: Dict[str, Any],
    ) -> None:
        """Handle side effects after device creation"""
        # If this device is default, clear default flag on other devices
        if resource.get("spec", {}).get("isDefault"):
            self._ensure_single_default(db, user_id, db_resource.name)

    def _update_side_effects(
        self,
        db: Session,
        user_id: int,
        db_resource: Kind,
        resource: Dict[str, Any],
    ) -> None:
        """Handle side effects after device update"""
        # If this device is being set as default, clear default flag on others
        if resource.get("spec", {}).get("isDefault"):
            self._ensure_single_default(db, user_id, db_resource.name)

    def _ensure_single_default(
        self, db: Session, user_id: int, exclude_name: str
    ) -> None:
        """Ensure only one device can be default per user"""
        from sqlalchemy import and_

        # Find all other Device CRDs for this user that are default
        devices = (
            db.query(Kind)
            .filter(
                and_(
                    Kind.user_id == user_id,
                    Kind.kind == "Device",
                    Kind.namespace == "default",
                    Kind.is_active == True,
                    Kind.name != exclude_name,
                )
            )
            .all()
        )

        for device in devices:
            device_json = device.json.copy()
            if device_json.get("spec", {}).get("isDefault"):
                device_json["spec"]["isDefault"] = False
                device.json = device_json
                db.add(device)
                logger.info(
                    f"Cleared isDefault flag on device: {device.name} for user: {user_id}"
                )
