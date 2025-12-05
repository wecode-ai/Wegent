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
from app.models.subtask_attachment import SubtaskAttachment
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
                    db.query(Kind)
                    .filter(
                        Kind.id == task_id,
                        Kind.kind == "Task",
                        Kind.is_active == True,
                    )
                    .first()
                )

                if not user or not task:
                    logger.info("User or task not found in the database.")
                    return None

                return TaskShareInfo(
                    user_id=user_id,
                    user_name=user.user_name,
                    task_id=task_id,
                    task_title=task.name or "Untitled Task",
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
        base_url = settings.TEAM_SHARE_BASE_URL  # Reuse the base URL
        return f"{base_url}/shared/task?token={share_token}"

    def validate_task_exists(self, db: Session, task_id: int, user_id: int) -> bool:
        """Validate that task exists and belongs to user"""
        task = (
            db.query(Kind)
            .filter(
                Kind.id == task_id,
                Kind.user_id == user_id,
                Kind.kind == "Task",
                Kind.is_active == True,
            )
            .first()
        )

        return task is not None

    def share_task(self, db: Session, task_id: int, user_id: int) -> TaskShareResponse:
        """Generate task share link"""

        # Get task
        task = (
            db.query(Kind)
            .filter(
                Kind.id == task_id,
                Kind.user_id == user_id,
                Kind.kind == "Task",
                Kind.is_active == True,
            )
            .first()
        )

        if task is None:
            raise HTTPException(status_code=404, detail="Task not found")

        # Generate share token
        share_token = self.generate_share_token(
            user_id=user_id,
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
            db.query(Kind)
            .filter(
                Kind.id == share_info.task_id,
                Kind.user_id == share_info.user_id,
                Kind.kind == "Task",
                Kind.is_active == True,
            )
            .first()
        )

        if not task:
            raise HTTPException(
                status_code=404, detail="Task not found or no longer available"
            )

        return share_info

    def _copy_task_with_subtasks(
        self, db: Session, original_task: Kind, new_user_id: int, new_team_id: int,
        model_id: Optional[str] = None, force_override_bot_model: bool = False
    ) -> Kind:
        """Copy task and all its subtasks to new user"""
        from app.schemas.kind import Task, Team

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

        # Parse the original task JSON and update the team reference
        task_crd = Task.model_validate(original_task.json)
        task_crd.spec.teamRef.name = new_team.name
        task_crd.spec.teamRef.namespace = new_team.namespace

        # Update model configuration in metadata labels if provided
        if model_id or force_override_bot_model:
            if not task_crd.metadata.labels:
                task_crd.metadata.labels = {}
            if model_id:
                task_crd.metadata.labels["modelId"] = model_id
            if force_override_bot_model:
                task_crd.metadata.labels["forceOverrideBotModel"] = "true"

        # Generate unique task name with timestamp to avoid duplicate key errors
        timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S%f")
        unique_task_name = f"Copy of {original_task.name}-{timestamp}"

        # Create new task with updated team reference
        new_task = Kind(
            kind="Task",
            name=unique_task_name,
            user_id=new_user_id,
            namespace=original_task.namespace,
            json=task_crd.model_dump(mode="json", exclude_none=True),  # Use updated JSON
            is_active=True,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
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
                executor_name=original_subtask.executor_name,
                executor_deleted_at=original_subtask.executor_deleted_at,
                prompt=original_subtask.prompt,
                message_id=original_subtask.message_id,
                parent_id=original_subtask.parent_id,
                status="COMPLETED",  # Set all copied subtasks to COMPLETED
                progress=100,  # Mark as fully completed
                result=original_subtask.result,
                error_message=original_subtask.error_message,
                # Remove created_at and updated_at to use database defaults (current timestamp)
                completed_at=datetime.utcnow(),
            )

            db.add(new_subtask)
            db.flush()  # Get new subtask ID

            # Copy attachments if any
            original_attachments = (
                db.query(SubtaskAttachment)
                .filter(SubtaskAttachment.subtask_id == original_subtask.id)
                .all()
            )

            for original_attachment in original_attachments:
                new_attachment = SubtaskAttachment(
                    subtask_id=new_subtask.id,
                    user_id=new_user_id,
                    original_filename=original_attachment.original_filename,
                    file_extension=original_attachment.file_extension,
                    file_size=original_attachment.file_size,
                    mime_type=original_attachment.mime_type,
                    binary_data=original_attachment.binary_data,
                    image_base64=original_attachment.image_base64,
                    extracted_text=original_attachment.extracted_text,
                    text_length=original_attachment.text_length,
                    status=original_attachment.status,
                    error_message=original_attachment.error_message,
                    created_at=datetime.utcnow(),
                )
                db.add(new_attachment)

        db.commit()
        db.refresh(new_task)

        return new_task

    def join_shared_task(
        self, db: Session, share_token: str, user_id: int, team_id: int,
        model_id: Optional[str] = None, force_override_bot_model: bool = False
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
            db.query(Kind)
            .filter(
                Kind.id == share_info.task_id,
                Kind.user_id == share_info.user_id,
                Kind.kind == "Task",
                Kind.is_active == True,
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
                db.query(Kind)
                .filter(
                    Kind.id == existing_share.copied_task_id,
                    Kind.user_id == user_id,
                    Kind.kind == "Task",
                    Kind.is_active == True,
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
        )

        # Update existing share record or create new one
        if existing_share:
            # Reuse existing record to avoid unique constraint violation
            existing_share.copied_task_id = copied_task.id
            existing_share.is_active = True
            existing_share.updated_at = datetime.utcnow()
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

    def get_user_shared_tasks(
        self, db: Session, user_id: int
    ) -> List[SharedTaskInDB]:
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
        shared_task.updated_at = datetime.utcnow()
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
                raise HTTPException(
                    status_code=400,
                    detail="Invalid share link format"
                )

            # Parse user_id and task_id
            user_id_str, task_id_str = share_data_str.split("#", 1)
            try:
                user_id = int(user_id_str)
                task_id = int(task_id_str)
            except ValueError:
                raise HTTPException(
                    status_code=400,
                    detail="Invalid share link format"
                )
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(
                status_code=400,
                detail="Invalid share link format"
            )

        # Now check if task exists and is active
        task = (
            db.query(Kind)
            .filter(
                Kind.id == task_id,
                Kind.user_id == user_id,
                Kind.kind == "Task",
                Kind.is_active == True,
            )
            .first()
        )

        if not task:
            raise HTTPException(
                status_code=404,
                detail="This shared task is no longer available. It may have been deleted by the owner."
            )

        # Get user info for sharer name
        user = (
            db.query(User)
            .filter(User.id == user_id, User.is_active == True)
            .first()
        )

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

        # Convert to public subtask data (exclude sensitive fields)
        public_subtasks = []
        for sub in subtasks:
            # Get attachments for this subtask
            attachments = (
                db.query(SubtaskAttachment)
                .filter(SubtaskAttachment.subtask_id == sub.id)
                .all()
            )

            # Convert attachments to public format (exclude binary data and image base64)
            public_attachments = [
                {
                    "id": att.id,
                    "original_filename": att.original_filename,
                    "file_extension": att.file_extension,
                    "file_size": att.file_size,
                    "mime_type": att.mime_type,
                    "extracted_text": att.extracted_text or "",
                    "text_length": att.text_length,
                    "status": att.status.value if hasattr(att.status, 'value') else str(att.status),
                }
                for att in attachments
            ]

            public_subtasks.append(
                PublicSubtaskData(
                    id=sub.id,
                    role=sub.role,
                    prompt=sub.prompt or "",
                    result=sub.result,
                    status=sub.status,
                    created_at=sub.created_at,
                    updated_at=sub.updated_at,
                    attachments=public_attachments,
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
