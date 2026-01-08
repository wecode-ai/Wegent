# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import base64
import logging
import urllib.parse
from datetime import datetime
from typing import List, Optional

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.shared_task import SharedTask
from app.models.subtask import Subtask
from app.models.subtask_context import ContextType, SubtaskContext
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.shared_task import (
    JoinSharedTaskResponse,
    PublicSharedTaskResponse,
    PublicSubtaskData,
    SharedTaskCreate,
    SharedTaskInDB,
    TaskShareInfo,
    TaskShareResponse,
)

logger = logging.getLogger(__name__)


class SharedTaskService:
    """Service for managing task sharing functionality"""

    def __init__(self):
        # Initialize AES key and IV from settings (reuse team share settings)
        self.aes_key = settings.SHARE_TOKEN_AES_KEY.encode("utf-8")
        self.aes_iv = settings.SHARE_TOKEN_AES_IV.encode("utf-8")

    def _aes_encrypt(self, data: str) -> str:
        """Encrypt data using AES-256-CBC"""
        cipher = Cipher(
            algorithms.AES(self.aes_key),
            modes.CBC(self.aes_iv),
            backend=default_backend(),
        )
        encryptor = cipher.encryptor()

        # Pad the data to 16-byte boundary (AES block size)
        padder = padding.PKCS7(128).padder()
        padded_data = padder.update(data.encode("utf-8")) + padder.finalize()

        # Encrypt the data
        encrypted_bytes = encryptor.update(padded_data) + encryptor.finalize()

        # Return base64 encoded encrypted data
        return base64.b64encode(encrypted_bytes).decode("utf-8")

    def _aes_decrypt(self, encrypted_data: str) -> Optional[str]:
        """Decrypt data using AES-256-CBC"""
        try:
            # Decode base64 encrypted data
            encrypted_bytes = base64.b64decode(encrypted_data.encode("utf-8"))

            # Create cipher object
            cipher = Cipher(
                algorithms.AES(self.aes_key),
                modes.CBC(self.aes_iv),
                backend=default_backend(),
            )
            decryptor = cipher.decryptor()

            # Decrypt the data
            decrypted_padded_bytes = (
                decryptor.update(encrypted_bytes) + decryptor.finalize()
            )

            # Unpad the data
            unpadder = padding.PKCS7(128).unpadder()
            decrypted_bytes = (
                unpadder.update(decrypted_padded_bytes) + unpadder.finalize()
            )

            # Return decrypted string
            return decrypted_bytes.decode("utf-8")
        except Exception:
            return None

    def generate_share_token(self, user_id: int, task_id: int) -> str:
        """Generate share token based on user and task information using AES encryption"""
        # Format: "user_id#task_id"
        share_data = f"{user_id}#{task_id}"
        # Use AES encryption
        share_token = self._aes_encrypt(share_data)
        # URL encode the token before returning it
        share_token = urllib.parse.quote(share_token)
        return share_token

    def decode_share_token(
        self, share_token: str, db: Optional[Session] = None
    ) -> Optional[TaskShareInfo]:
        """Decode share token to get task information using AES decryption"""
        try:
            # First URL decode the token, then use AES decryption
            decoded_token = urllib.parse.unquote(share_token)
            share_data_str = self._aes_decrypt(decoded_token)
            if not share_data_str:
                logger.info("Invalid share token format: %s", share_token)
                return None

            # Parse the "user_id#task_id" format
            if "#" not in share_data_str:
                return None

            user_id_str, task_id_str = share_data_str.split("#", 1)
            try:
                user_id = int(user_id_str)
                task_id = int(task_id_str)
            except ValueError:
                return None

            # If database session is provided, query user_name and task_title from database
            if db is not None:
                # Query user name
                user = (
                    db.query(User)
                    .filter(User.id == user_id, User.is_active == True)
                    .first()
                )

                # Query task
                task = (
                    db.query(TaskResource)
                    .filter(
                        TaskResource.id == task_id,
                        TaskResource.kind == "Task",
                        TaskResource.is_active == True,
                    )
                    .first()
                )

                if not user or not task:
                    logger.info("User or task not found in the database.")
                    return None

                # Extract task_type from task JSON (stored in metadata.labels)
                task_type = "chat"  # default
                git_repo_id = None
                git_repo = None
                git_domain = None
                git_type = None
                branch_name = None

                try:
                    from app.schemas.kind import Task, Workspace

                    task_json = task.json if isinstance(task.json, dict) else {}
                    metadata = task_json.get("metadata", {})
                    labels = metadata.get("labels", {})
                    task_type = labels.get("taskType", "chat")

                    # For code tasks, extract workspace repository information
                    if task_type == "code":
                        task_crd = Task.model_validate(task.json)
                        workspace_ref = task_crd.spec.workspaceRef

                        # Find the workspace by name and namespace
                        from app.models.task import TaskResource as TaskResourceModel

                        workspace = (
                            db.query(TaskResourceModel)
                            .filter(
                                TaskResourceModel.name == workspace_ref.name,
                                TaskResourceModel.namespace == workspace_ref.namespace,
                                TaskResourceModel.user_id == user_id,
                                TaskResourceModel.kind == "Workspace",
                                TaskResourceModel.is_active == True,
                            )
                            .first()
                        )

                        if workspace:
                            workspace_crd = Workspace.model_validate(workspace.json)
                            repo = workspace_crd.spec.repository
                            git_repo_id = repo.gitRepoId
                            git_repo = repo.gitRepo
                            git_domain = repo.gitDomain
                            branch_name = repo.branchName
                            # Infer git_type from git_domain
                            if "github" in repo.gitDomain.lower():
                                git_type = "github"
                            elif "gitlab" in repo.gitDomain.lower():
                                git_type = "gitlab"
                            elif "gitee" in repo.gitDomain.lower():
                                git_type = "gitee"
                            elif "gitea" in repo.gitDomain.lower():
                                git_type = "gitea"
                except Exception as e:
                    logger.warning(f"Failed to extract workspace info: {e}")
                    pass  # Use defaults if extraction fails

                return TaskShareInfo(
                    user_id=user_id,
                    user_name=user.user_name,
                    task_id=task_id,
                    task_title=task.name or "Untitled Task",
                    task_type=task_type,
                    git_repo_id=git_repo_id,
                    git_repo=git_repo,
                    git_domain=git_domain,
                    git_type=git_type,
                    branch_name=branch_name,
                )
            else:
                # Without database session, return basic info with placeholder names
                return TaskShareInfo(
                    user_id=user_id,
                    user_name=f"User_{user_id}",
                    task_id=task_id,
                    task_title=f"Task_{task_id}",
                )
        except Exception:
            return None

    def generate_share_url(self, share_token: str) -> str:
        """Generate share URL with token"""
        # Use /shared/task path for public read-only viewing
        base_url = settings.TASK_SHARE_BASE_URL  # Reuse the base URL
        return f"{base_url}/shared/task?token={share_token}"

    def validate_task_exists(self, db: Session, task_id: int, user_id: int) -> bool:
        """Validate that task exists and user has access (owner or group chat member)"""
        from app.services.task_member_service import task_member_service

        # Check if user is the task owner or an active group chat member
        return task_member_service.is_member(db, task_id, user_id)

    def share_task(self, db: Session, task_id: int, user_id: int) -> TaskShareResponse:
        """Generate task share link"""
        from app.services.task_member_service import task_member_service

        # Validate user has access to the task (owner or group chat member)
        if not task_member_service.is_member(db, task_id, user_id):
            raise HTTPException(status_code=404, detail="Task not found")

        # Get the task to get the actual owner's user_id for token generation
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active == True,
            )
            .first()
        )

        if task is None:
            raise HTTPException(status_code=404, detail="Task not found")

        # Generate share token using the task owner's user_id (not the current user)
        # This ensures the token remains valid and consistent
        share_token = self.generate_share_token(
            user_id=task.user_id,
            task_id=task_id,
        )

        # Generate share URL
        share_url = self.generate_share_url(share_token)

        return TaskShareResponse(share_url=share_url, share_token=share_token)

    def get_share_info(self, db: Session, share_token: str) -> TaskShareInfo:
        """Get task share information from token"""
        share_info = self.decode_share_token(share_token, db)

        if not share_info:
            raise HTTPException(status_code=400, detail="Invalid share token")

        # Validate task still exists and is active
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == share_info.task_id,
                TaskResource.user_id == share_info.user_id,
                TaskResource.kind == "Task",
                TaskResource.is_active == True,
            )
            .first()
        )

        if not task:
            raise HTTPException(
                status_code=404, detail="Task not found or no longer available"
            )

        return share_info

    def _copy_task_with_subtasks(
        self,
        db: Session,
        original_task: Kind,
        new_user_id: int,
        new_team_id: int,
        model_id: Optional[str] = None,
        force_override_bot_model: bool = False,
        git_repo_id: Optional[int] = None,
        git_url: Optional[str] = None,
        git_repo: Optional[str] = None,
        git_domain: Optional[str] = None,
        branch_name: Optional[str] = None,
    ) -> Kind:
        """Copy task and all its subtasks to new user"""
        from app.schemas.kind import Task, Team, Workspace

        # Get the new team to get its name and namespace
        new_team = (
            db.query(Kind)
            .filter(
                Kind.id == new_team_id,
                Kind.user_id == new_user_id,
                Kind.kind == "Team",
                Kind.is_active == True,
            )
            .first()
        )

        if not new_team:
            raise HTTPException(
                status_code=400,
                detail=f"Team with id {new_team_id} not found",
            )

        # Query the workspace if git_repo_id is provided
        new_workspace = None
        if git_repo_id is not None:
            logger.info(
                f"Looking for workspace with git_repo_id={git_repo_id}, "
                f"branch_name={branch_name}, git_repo={git_repo}, "
                f"git_url={git_url}, git_domain={git_domain}"
            )
            # Find workspace by gitRepoId in workspace JSON
            from app.models.task import TaskResource as TaskResourceModel

            all_workspaces = (
                db.query(TaskResourceModel)
                .filter(
                    TaskResourceModel.user_id == new_user_id,
                    TaskResourceModel.kind == "Workspace",
                    TaskResourceModel.is_active == True,
                )
                .all()
            )
            logger.info(
                f"Found {len(all_workspaces)} workspaces for user {new_user_id}"
            )

            # Find workspace with matching gitRepoId and branchName
            for ws in all_workspaces:
                try:
                    ws_crd = Workspace.model_validate(ws.json)
                    if ws_crd.spec.repository.gitRepoId == git_repo_id and (
                        branch_name is None
                        or ws_crd.spec.repository.branchName == branch_name
                    ):
                        new_workspace = ws
                        logger.info(f"Found matching workspace: {ws.name}")
                        break
                except Exception as e:
                    logger.warning(f"Failed to parse workspace {ws.id}: {e}")
                    continue

            # If workspace not found, create a new one automatically
            if (
                not new_workspace
                and branch_name
                and git_url
                and git_repo
                and git_domain
            ):
                logger.info(
                    f"No matching workspace found, attempting to create new workspace"
                )
                try:
                    from app.schemas.kind import (
                        ObjectMeta,
                        Repository,
                        WorkspaceSpec,
                    )

                    # Create workspace name with timestamp to ensure uniqueness
                    timestamp = datetime.now().strftime("%Y%m%d%H%M%S%f")
                    workspace_name = (
                        f"ws-{git_repo.replace('/', '-')}-{branch_name}-{timestamp}"
                    )

                    # Create workspace CRD using complete repository info from frontend
                    workspace_crd = Workspace(
                        apiVersion="agent.wecode.io/v1",
                        kind="Workspace",
                        metadata=ObjectMeta(
                            name=workspace_name,
                            namespace="default",
                        ),
                        spec=WorkspaceSpec(
                            repository=Repository(
                                gitUrl=git_url,
                                gitRepo=git_repo,
                                gitRepoId=git_repo_id,
                                branchName=branch_name,
                                gitDomain=git_domain,
                            )
                        ),
                    )

                    # Save workspace to database
                    new_workspace = TaskResourceModel(
                        kind="Workspace",
                        name=workspace_name,
                        user_id=new_user_id,
                        namespace="default",
                        json=workspace_crd.model_dump(mode="json", exclude_none=True),
                        is_active=True,
                        created_at=datetime.now(),
                        updated_at=datetime.now(),
                    )
                    db.add(new_workspace)
                    db.flush()  # Get new workspace ID

                    logger.info(
                        f"Auto-created workspace {workspace_name} for user {new_user_id} "
                        f"with repo {git_repo} (id={git_repo_id}) and branch {branch_name}"
                    )
                except Exception as e:
                    logger.error(f"Failed to auto-create workspace: {e}")
                    # If auto-creation fails, raise the original error
                    raise HTTPException(
                        status_code=400,
                        detail=f"Workspace with git_repo_id {git_repo_id} and branch {branch_name} not found, "
                        f"and failed to create automatically: {str(e)}",
                    )

            # Final check: if still no workspace found, raise error
            if not new_workspace:
                raise HTTPException(
                    status_code=400,
                    detail=f"Workspace with git_repo_id {git_repo_id} not found. "
                    "Please select a repository and branch, or create a workspace first.",
                )

        # Parse the original task JSON and update the team reference
        task_crd = Task.model_validate(original_task.json)
        task_crd.spec.teamRef.name = new_team.name
        task_crd.spec.teamRef.namespace = new_team.namespace

        # Check if this is a code task
        task_type = "chat"  # default
        try:
            task_json = (
                original_task.json if isinstance(original_task.json, dict) else {}
            )
            metadata = task_json.get("metadata", {})
            labels = metadata.get("labels", {})
            task_type = labels.get("taskType", "chat")
        except Exception:
            pass

        # For code tasks, workspace is REQUIRED and must belong to the new user
        if task_type == "code":
            if not new_workspace:
                raise HTTPException(
                    status_code=400,
                    detail="Repository and branch must be selected for code tasks. "
                    "Please ensure you have access to a repository.",
                )
            # Update workspace reference to the new user's workspace
            task_crd.spec.workspaceRef.name = new_workspace.name
            task_crd.spec.workspaceRef.namespace = new_workspace.namespace
        else:
            # For chat tasks, workspace is optional
            # Update workspace reference if user explicitly selected one during import
            if new_workspace:
                task_crd.spec.workspaceRef.name = new_workspace.name
                task_crd.spec.workspaceRef.namespace = new_workspace.namespace

        # Always remove the original task's modelId to allow user to choose their own model
        # This ensures imported tasks don't inherit the original task's model selection
        if task_crd.metadata.labels and "modelId" in task_crd.metadata.labels:
            del task_crd.metadata.labels["modelId"]

        # Remove forceOverrideBotModel from original task as well
        if (
            task_crd.metadata.labels
            and "forceOverrideBotModel" in task_crd.metadata.labels
        ):
            del task_crd.metadata.labels["forceOverrideBotModel"]

        # Update model configuration in metadata labels if provided by user during import
        if model_id or force_override_bot_model:
            if not task_crd.metadata.labels:
                task_crd.metadata.labels = {}
            if model_id:
                task_crd.metadata.labels["modelId"] = model_id
            if force_override_bot_model:
                task_crd.metadata.labels["forceOverrideBotModel"] = "true"

        # Generate unique task name with timestamp to avoid duplicate key errors
        timestamp = datetime.now().strftime("%Y%m%d%H%M%S%f")
        unique_task_name = f"Copy of {original_task.name}-{timestamp}"

        # Create new task with updated team reference
        from app.models.task import TaskResource

        new_task = TaskResource(
            kind="Task",
            name=unique_task_name,
            user_id=new_user_id,
            namespace=original_task.namespace,
            json=task_crd.model_dump(
                mode="json", exclude_none=True
            ),  # Use updated JSON
            is_active=True,
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )

        db.add(new_task)
        db.flush()  # Get new task ID

        # Get all subtasks from original task (ordered by message_id)
        original_subtasks = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == original_task.id,
                Subtask.status != "DELETE",
            )
            .order_by(Subtask.message_id)
            .all()
        )

        # Copy each subtask
        for original_subtask in original_subtasks:
            new_subtask = Subtask(
                user_id=new_user_id,
                task_id=new_task.id,
                team_id=new_team_id,
                title=original_subtask.title,
                bot_ids=original_subtask.bot_ids,
                role=original_subtask.role,
                executor_namespace=original_subtask.executor_namespace,
                executor_name="",  # Clear executor_name - each task should have its own executor
                executor_deleted_at=False,  # Reset executor_deleted_at
                prompt=original_subtask.prompt,
                message_id=original_subtask.message_id,
                parent_id=original_subtask.parent_id,
                status="COMPLETED",  # Set all copied subtasks to COMPLETED
                progress=100,  # Mark as fully completed
                result=original_subtask.result,
                error_message=original_subtask.error_message,
                # Copy group chat fields to preserve sender information
                sender_type=original_subtask.sender_type,
                sender_user_id=original_subtask.sender_user_id,
                reply_to_subtask_id=original_subtask.reply_to_subtask_id,
                # Use local time instead of UTC to match other subtask creation in the codebase
                created_at=datetime.now(),
                updated_at=datetime.now(),
                completed_at=datetime.now(),
            )

            db.add(new_subtask)
            db.flush()  # Get new subtask ID

            # Copy contexts (attachments) if any
            original_contexts = (
                db.query(SubtaskContext)
                .filter(SubtaskContext.subtask_id == original_subtask.id)
                .all()
            )

            for original_context in original_contexts:
                new_context = SubtaskContext(
                    subtask_id=new_subtask.id,
                    user_id=new_user_id,
                    context_type=original_context.context_type,
                    name=original_context.name,
                    status=original_context.status,
                    error_message=original_context.error_message,
                    binary_data=original_context.binary_data,
                    image_base64=original_context.image_base64,
                    extracted_text=original_context.extracted_text,
                    text_length=original_context.text_length,
                    type_data=original_context.type_data,
                    created_at=datetime.now(),
                    updated_at=datetime.now(),
                )
                db.add(new_context)

        db.commit()
        db.refresh(new_task)

        return new_task

    def join_shared_task(
        self,
        db: Session,
        share_token: str,
        user_id: int,
        team_id: int,
        model_id: Optional[str] = None,
        force_override_bot_model: bool = False,
        git_repo_id: Optional[int] = None,
        git_url: Optional[str] = None,
        git_repo: Optional[str] = None,
        git_domain: Optional[str] = None,
        branch_name: Optional[str] = None,
    ) -> JoinSharedTaskResponse:
        """Join a shared task by copying it to user's task list"""
        # Decode share token
        share_info = self.decode_share_token(share_token, db)

        if not share_info:
            raise HTTPException(status_code=400, detail="Invalid share token")

        # Check if share user is the same as current user
        if share_info.user_id == user_id:
            raise HTTPException(
                status_code=400, detail="Cannot copy your own shared task"
            )

        # Validate original task still exists and is active
        original_task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == share_info.task_id,
                TaskResource.user_id == share_info.user_id,
                TaskResource.kind == "Task",
                TaskResource.is_active == True,
            )
            .first()
        )

        if not original_task:
            raise HTTPException(
                status_code=404, detail="Task not found or no longer available"
            )

        # Check if user already has any share record for this task (active or inactive)
        existing_share = (
            db.query(SharedTask)
            .filter(
                SharedTask.user_id == user_id,
                SharedTask.original_task_id == share_info.task_id,
            )
            .first()
        )

        # If there's an active share record, check if the copied task still exists
        if existing_share and existing_share.is_active:
            # Verify that the copied task still exists and is active
            copied_task_check = (
                db.query(TaskResource)
                .filter(
                    TaskResource.id == existing_share.copied_task_id,
                    TaskResource.user_id == user_id,
                    TaskResource.kind == "Task",
                    TaskResource.is_active == True,
                )
                .first()
            )

            # If copied task still exists, cannot copy again
            if copied_task_check:
                raise HTTPException(
                    status_code=400,
                    detail="You have already copied this task",
                )

        # Copy the task and all subtasks to new user
        copied_task = self._copy_task_with_subtasks(
            db=db,
            original_task=original_task,
            new_user_id=user_id,
            new_team_id=team_id,
            model_id=model_id,
            force_override_bot_model=force_override_bot_model,
            git_repo_id=git_repo_id,
            git_url=git_url,
            git_repo=git_repo,
            git_domain=git_domain,
            branch_name=branch_name,
        )

        # Update existing share record or create new one
        if existing_share:
            # Reuse existing record to avoid unique constraint violation
            existing_share.copied_task_id = copied_task.id
            existing_share.is_active = True
            existing_share.updated_at = datetime.now()
            shared_task = existing_share
        else:
            # Create new share relationship record
            shared_task = SharedTask(
                user_id=user_id,
                original_user_id=share_info.user_id,
                original_task_id=share_info.task_id,
                copied_task_id=copied_task.id,
                is_active=True,
            )
            db.add(shared_task)

        db.commit()
        db.refresh(shared_task)

        return JoinSharedTaskResponse(
            message="Successfully copied shared task to your task list",
            task_id=copied_task.id,
        )

    def get_user_shared_tasks(self, db: Session, user_id: int) -> List[SharedTaskInDB]:
        """Get all shared tasks for a user"""
        shared_tasks = (
            db.query(SharedTask)
            .filter(SharedTask.user_id == user_id, SharedTask.is_active == True)
            .all()
        )

        return [SharedTaskInDB.model_validate(task) for task in shared_tasks]

    def remove_shared_task(
        self, db: Session, user_id: int, original_task_id: int
    ) -> bool:
        """Remove shared task relationship (soft delete)"""
        shared_task = (
            db.query(SharedTask)
            .filter(
                SharedTask.user_id == user_id,
                SharedTask.original_task_id == original_task_id,
                SharedTask.is_active == True,
            )
            .first()
        )

        if not shared_task:
            raise HTTPException(
                status_code=404, detail="Shared task relationship not found"
            )

        shared_task.is_active = False
        shared_task.updated_at = datetime.now()
        db.commit()

        return True

    def get_public_shared_task(
        self, db: Session, share_token: str
    ) -> PublicSharedTaskResponse:
        """Get public shared task data (no authentication required)"""
        # First try to decode the token format (without database check)
        try:
            decoded_token = urllib.parse.unquote(share_token)
            share_data_str = self._aes_decrypt(decoded_token)

            if not share_data_str or "#" not in share_data_str:
                raise HTTPException(status_code=400, detail="Invalid share link format")

            # Parse user_id and task_id
            user_id_str, task_id_str = share_data_str.split("#", 1)
            try:
                user_id = int(user_id_str)
                task_id = int(task_id_str)
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid share link format")
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid share link format")

        # Now check if task exists and is active
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.user_id == user_id,
                TaskResource.kind == "Task",
                TaskResource.is_active == True,
            )
            .first()
        )

        if not task:
            raise HTTPException(
                status_code=404,
                detail="This shared task is no longer available. It may have been deleted by the owner.",
            )

        # Get user info for sharer name
        user = db.query(User).filter(User.id == user_id, User.is_active == True).first()

        share_info = TaskShareInfo(
            user_id=user_id,
            user_name=user.user_name if user else f"User_{user_id}",
            task_id=task_id,
            task_title=task.name or "Untitled Task",
        )

        # Get all subtasks (only public data, no sensitive information)
        subtasks = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task.id,
                Subtask.status != "DELETE",
            )
            .order_by(Subtask.message_id)
            .all()
        )

        # Query sender user names for group chat messages
        sender_ids = set()
        for sub in subtasks:
            if sub.sender_user_id and sub.sender_user_id > 0:
                sender_ids.add(sub.sender_user_id)

        # Batch query users
        user_name_map = {}
        if sender_ids:
            users = db.query(User).filter(User.id.in_(sender_ids)).all()
            user_name_map = {u.id: u.user_name for u in users}

        # Convert to public subtask data (exclude sensitive fields)
        public_subtasks = []
        for sub in subtasks:
            # Get ALL contexts for this subtask (attachments and knowledge bases)
            contexts = (
                db.query(SubtaskContext)
                .filter(SubtaskContext.subtask_id == sub.id)
                .all()
            )

            # Convert contexts to public format (exclude binary data and image base64)
            public_contexts = []
            for ctx in contexts:
                ctx_dict = {
                    "id": ctx.id,
                    "context_type": ctx.context_type,
                    "name": ctx.name,
                    "status": ctx.status,
                }

                # Add type-specific fields
                if ctx.context_type == ContextType.ATTACHMENT.value:
                    ctx_dict.update(
                        {
                            "file_extension": ctx.file_extension,
                            "file_size": ctx.file_size,
                            "mime_type": ctx.mime_type,
                        }
                    )
                elif ctx.context_type == ContextType.KNOWLEDGE_BASE.value:
                    ctx_dict.update(
                        {
                            "document_count": ctx.document_count,
                        }
                    )

                public_contexts.append(ctx_dict)

            # Get sender user name if available
            sender_user_name = None
            if sub.sender_user_id and sub.sender_user_id > 0:
                sender_user_name = user_name_map.get(sub.sender_user_id)

            public_subtasks.append(
                PublicSubtaskData(
                    id=sub.id,
                    role=sub.role,
                    prompt=sub.prompt or "",
                    result=sub.result,
                    status=sub.status,
                    created_at=sub.created_at,
                    updated_at=sub.updated_at,
                    contexts=public_contexts,
                    sender_type=sub.sender_type,
                    sender_user_id=sub.sender_user_id,
                    sender_user_name=sender_user_name,
                    reply_to_subtask_id=sub.reply_to_subtask_id,
                )
            )

        return PublicSharedTaskResponse(
            task_title=task.name or "Untitled Task",
            sharer_name=share_info.user_name,
            sharer_id=share_info.user_id,
            subtasks=public_subtasks,
            created_at=task.created_at,
        )


shared_task_service = SharedTaskService()
