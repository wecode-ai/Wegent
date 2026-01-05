# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Service for task knowledge base (group chat) binding management.
"""

import logging
from datetime import datetime
from typing import List, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import KnowledgeBaseTaskRef
from app.services.group_permission import get_effective_role_in_group
from app.services.knowledge_service import KnowledgeService
from app.services.task_member_service import task_member_service

logger = logging.getLogger(__name__)


class BoundKnowledgeBaseDetail:
    """Detail information for a bound knowledge base"""

    def __init__(
        self,
        id: int,
        name: str,
        namespace: str,
        display_name: str,
        description: Optional[str],
        document_count: int,
        bound_by: str,
        bound_at: str,
    ):
        self.id = id
        self.name = name
        self.namespace = namespace
        self.display_name = display_name
        self.description = description
        self.document_count = document_count
        self.bound_by = bound_by
        self.bound_at = bound_at

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "namespace": self.namespace,
            "display_name": self.display_name,
            "description": self.description,
            "document_count": self.document_count,
            "bound_by": self.bound_by,
            "bound_at": self.bound_at,
        }


class TaskKnowledgeBaseService:
    """Service for managing knowledge bases bound to group chat tasks."""

    MAX_BOUND_KNOWLEDGE_BASES = 10

    def get_task(self, db: Session, task_id: int) -> Optional[TaskResource]:
        """Get a task by ID"""
        return (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active == True,
            )
            .first()
        )

    def get_user(self, db: Session, user_id: int) -> Optional[User]:
        """Get a user by ID"""
        return db.query(User).filter(User.id == user_id, User.is_active == True).first()

    def is_group_chat(self, db: Session, task_id: int) -> bool:
        """Check if a task is configured as a group chat"""
        task = self.get_task(db, task_id)
        if not task:
            return False

        task_json = task.json if isinstance(task.json, dict) else {}
        spec = task_json.get("spec", {})
        return spec.get("is_group_chat", False)

    def can_access_knowledge_base(
        self, db: Session, user_id: int, kb_name: str, kb_namespace: str
    ) -> bool:
        """Check if user has access to a knowledge base.

        Args:
            db: Database session
            user_id: User ID
            kb_name: Knowledge base display name (spec.name)
            kb_namespace: Knowledge base namespace

        Returns:
            True if user has access to the knowledge base
        """
        # Find the knowledge base by display name (spec.name)
        kb = self.get_knowledge_base_by_name(db, kb_name, kb_namespace)

        if not kb:
            return False

        # For personal knowledge base (default namespace)
        if kb.namespace == "default":
            return kb.user_id == user_id

        # For team knowledge base, check group membership
        role = get_effective_role_in_group(db, user_id, kb.namespace)
        return role is not None

    def get_knowledge_base_by_name(
        self, db: Session, name: str, namespace: str
    ) -> Optional[Kind]:
        """Get a knowledge base by display name (spec.name) and namespace.

        Note: The 'name' parameter is the display name stored in spec.name,
        not the Kind.name which has format 'kb-{user_id}-{namespace}-{display_name}'.

        Args:
            db: Database session
            name: Knowledge base display name (spec.name)
            namespace: Knowledge base namespace

        Returns:
            Kind object if found, None otherwise
        """
        # Query all knowledge bases in the namespace and filter by spec.name
        knowledge_bases = (
            db.query(Kind)
            .filter(
                Kind.kind == "KnowledgeBase",
                Kind.namespace == namespace,
                Kind.is_active == True,
            )
            .all()
        )

        # Find the one with matching display name in spec
        for kb in knowledge_bases:
            kb_spec = kb.json.get("spec", {})
            if kb_spec.get("name") == name:
                return kb

        return None

    def get_bound_knowledge_bases(
        self, db: Session, task_id: int, user_id: int
    ) -> List[BoundKnowledgeBaseDetail]:
        """
        Get knowledge bases bound to a group chat task.

        Args:
            db: Database session
            task_id: Task ID
            user_id: Requesting user ID

        Returns:
            List of BoundKnowledgeBaseDetail

        Raises:
            HTTPException: If user is not a member or task not found
        """
        # Verify user is a member of the group chat
        if not task_member_service.is_member(db, task_id, user_id):
            raise HTTPException(
                status_code=403, detail="You are not a member of this group chat"
            )

        task = self.get_task(db, task_id)
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")

        # Get knowledgeBaseRefs from task spec
        task_json = task.json if isinstance(task.json, dict) else {}
        spec = task_json.get("spec", {})
        kb_refs = spec.get("knowledgeBaseRefs", []) or []

        result = []
        for ref in kb_refs:
            kb_name = ref.get("name")
            kb_namespace = ref.get("namespace", "default")

            # Get knowledge base details
            kb = self.get_knowledge_base_by_name(db, kb_name, kb_namespace)
            if kb:
                kb_spec = kb.json.get("spec", {})
                display_name = kb_spec.get("name", kb_name)
                description = kb_spec.get("description")
                document_count = KnowledgeService.get_active_document_count(db, kb.id)

                result.append(
                    BoundKnowledgeBaseDetail(
                        id=kb.id,
                        name=kb_name,
                        namespace=kb_namespace,
                        display_name=display_name,
                        description=description,
                        document_count=document_count,
                        bound_by=ref.get("boundBy", "Unknown"),
                        bound_at=ref.get("boundAt", ""),
                    )
                )

        return result

    def get_bound_knowledge_base_ids(self, db: Session, task_id: int) -> List[int]:
        """
        Get IDs of knowledge bases bound to a task.
        This method does not check permissions - used internally for AI integration.

        Args:
            db: Database session
            task_id: Task ID

        Returns:
            List of knowledge base IDs
        """
        task = self.get_task(db, task_id)
        if not task:
            return []

        task_json = task.json if isinstance(task.json, dict) else {}
        spec = task_json.get("spec", {})
        kb_refs = spec.get("knowledgeBaseRefs", []) or []

        result = []
        for ref in kb_refs:
            kb_name = ref.get("name")
            kb_namespace = ref.get("namespace", "default")
            kb = self.get_knowledge_base_by_name(db, kb_name, kb_namespace)
            if kb:
                result.append(kb.id)

        return result

    def bind_knowledge_base(
        self,
        db: Session,
        task_id: int,
        kb_name: str,
        kb_namespace: str,
        user_id: int,
    ) -> BoundKnowledgeBaseDetail:
        """
        Bind a knowledge base to a group chat task.

        Args:
            db: Database session
            task_id: Task ID
            kb_name: Knowledge base name
            kb_namespace: Knowledge base namespace
            user_id: User ID

        Returns:
            BoundKnowledgeBaseDetail

        Raises:
            HTTPException: On validation or permission errors
        """
        # Verify task exists and is a group chat
        task = self.get_task(db, task_id)
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")

        if not self.is_group_chat(db, task_id):
            raise HTTPException(status_code=400, detail="This task is not a group chat")

        # Verify user is a member
        if not task_member_service.is_member(db, task_id, user_id):
            raise HTTPException(
                status_code=403, detail="You are not a member of this group chat"
            )

        # Verify user has access to the knowledge base
        if not self.can_access_knowledge_base(db, user_id, kb_name, kb_namespace):
            raise HTTPException(
                status_code=403,
                detail="You do not have access to this knowledge base",
            )

        # Get knowledge base details
        kb = self.get_knowledge_base_by_name(db, kb_name, kb_namespace)
        if not kb:
            raise HTTPException(status_code=404, detail="Knowledge base not found")

        # Get current task spec
        task_json = task.json if isinstance(task.json, dict) else {}
        spec = task_json.get("spec", {})
        kb_refs = spec.get("knowledgeBaseRefs", []) or []

        # Check binding limit
        if len(kb_refs) >= self.MAX_BOUND_KNOWLEDGE_BASES:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot bind more than {self.MAX_BOUND_KNOWLEDGE_BASES} knowledge bases",
            )

        # Check if already bound
        for ref in kb_refs:
            if (
                ref.get("name") == kb_name
                and ref.get("namespace", "default") == kb_namespace
            ):
                raise HTTPException(
                    status_code=400, detail="Knowledge base is already bound"
                )

        # Get user info
        user = self.get_user(db, user_id)
        user_name = user.user_name if user else "Unknown"

        # Add new binding
        new_ref = KnowledgeBaseTaskRef(
            name=kb_name,
            namespace=kb_namespace,
            boundBy=user_name,
            boundAt=datetime.utcnow().isoformat() + "Z",
        )
        kb_refs.append(new_ref.model_dump())

        # Update task spec
        spec["knowledgeBaseRefs"] = kb_refs
        task_json["spec"] = spec
        task.json = task_json
        flag_modified(task, "json")

        task.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(task)

        logger.info(
            f"Knowledge base {kb_name}/{kb_namespace} bound to task {task_id} by user {user_id}"
        )

        # Return bound KB details
        kb_spec = kb.json.get("spec", {})
        return BoundKnowledgeBaseDetail(
            id=kb.id,
            name=kb_name,
            namespace=kb_namespace,
            display_name=kb_spec.get("name", kb_name),
            description=kb_spec.get("description"),
            document_count=KnowledgeService.get_active_document_count(db, kb.id),
            bound_by=user_name,
            bound_at=new_ref.boundAt,
        )

    def unbind_knowledge_base(
        self,
        db: Session,
        task_id: int,
        kb_name: str,
        kb_namespace: str,
        user_id: int,
    ) -> bool:
        """
        Unbind a knowledge base from a group chat task.

        Args:
            db: Database session
            task_id: Task ID
            kb_name: Knowledge base name
            kb_namespace: Knowledge base namespace
            user_id: User ID

        Returns:
            True if unbound successfully

        Raises:
            HTTPException: On validation or permission errors
        """
        # Verify user is a member
        if not task_member_service.is_member(db, task_id, user_id):
            raise HTTPException(
                status_code=403, detail="You are not a member of this group chat"
            )

        task = self.get_task(db, task_id)
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")

        # Get current task spec
        task_json = task.json if isinstance(task.json, dict) else {}
        spec = task_json.get("spec", {})
        kb_refs = spec.get("knowledgeBaseRefs", []) or []

        # Find and remove the binding
        found = False
        new_refs = []
        for ref in kb_refs:
            if (
                ref.get("name") == kb_name
                and ref.get("namespace", "default") == kb_namespace
            ):
                found = True
            else:
                new_refs.append(ref)

        if not found:
            raise HTTPException(
                status_code=404, detail="Knowledge base is not bound to this task"
            )

        # Update task spec
        spec["knowledgeBaseRefs"] = new_refs
        task_json["spec"] = spec
        task.json = task_json
        flag_modified(task, "json")

        task.updated_at = datetime.utcnow()
        db.commit()

        logger.info(
            f"Knowledge base {kb_name}/{kb_namespace} unbound from task {task_id} by user {user_id}"
        )

        return True


task_knowledge_base_service = TaskKnowledgeBaseService()
