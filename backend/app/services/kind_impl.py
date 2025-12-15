# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Implementation of specific Kind services
"""
import logging
from typing import Any, Dict

from shared.utils.crypto import decrypt_api_key, encrypt_api_key, is_api_key_encrypted
from sqlalchemy.orm import Session

from app.core.exceptions import NotFoundException
from app.models.kind import Kind
from app.models.subtask import Subtask
from app.schemas.kind import Bot, Model, Task, Team
from app.services.adapters.task_kinds import task_kinds_service
from app.services.kind_base import KindBaseService

logger = logging.getLogger(__name__)


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
        Validate that all skill names exist for the user.

        Args:
            db: Database session
            skill_names: List of skill names to validate
            user_id: User ID

        Raises:
            NotFoundException: If any skill does not exist
        """
        if not skill_names:
            return

        # Query all skills at once for efficiency
        existing_skills = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
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
        """No references to validate for Model"""
        pass

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

        shell = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Shell",
                Kind.namespace == shell_namespace,
                Kind.name == shell_name,
                Kind.is_active == True,
            )
            .first()
        )

        # If not found in user's shells, try to find in public shells (user_id=0)
        if not shell:
            public_shell = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Shell",
                    Kind.name == shell_name,
                    Kind.namespace == shell_namespace,
                    Kind.is_active == True,
                )
                .first()
            )
            if not public_shell:
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


class TeamKindService(KindBaseService):
    """Service for Team resources"""

    def __init__(self):
        super().__init__("Team")

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


class WorkspaceKindService(KindBaseService):
    """Service for Workspace resources"""

    def __init__(self):
        super().__init__("Workspace")

    def _validate_references(
        self, db: Session, user_id: int, resource: Dict[str, Any]
    ) -> None:
        """No references to validate for Workspace"""
        pass


class TaskKindService(KindBaseService):
    """Service for Task resources"""

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

        workspace = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Workspace",
                Kind.namespace == workspace_namespace,
                Kind.name == workspace_name,
                Kind.is_active == True,
            )
            .first()
        )

        if not workspace:
            raise NotFoundException(
                f"Workspace '{workspace_name}' not found in namespace '{workspace_namespace}'"
            )

        # Check the status of existing task, if not COMPLETED status, modification is not allowed
        existing_task = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Task",
                Kind.namespace == resource["metadata"]["namespace"],
                Kind.name == resource["metadata"]["name"],
                Kind.is_active == True,
            )
            .first()
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
        self, db: Session, user_id: int, db_resource: Kind, resource: Dict[str, Any]
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

        except Exception as e:
            # Log error but don't interrupt the process
            logger.error(f"Error creating subtasks: {str(e)}")

    def _update_side_effects(
        self, db: Session, user_id: int, db_resource: Kind, resource: Dict[str, Any]
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

        except Exception as e:
            # Log error but don't interrupt the process
            logger.error(f"Error updating subtasks: {str(e)}")

    def _format_resource(self, resource: Kind) -> Dict[str, Any]:
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
            subtasks = (
                db.query(Subtask)
                .filter(Subtask.task_id == resource.id)
                .order_by(Subtask.message_id.asc())
                .all()
            )

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
                        "result": subtask.result,
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
