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
from app.services.knowledge.knowledge_service import (
    KnowledgeService,
    _is_organization_namespace,
)
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
            # Creator always has access
            if kb.user_id == user_id:
                return True
            # Check if KB is bound to any group chat that the user is a member of
            return self._is_kb_bound_to_user_group_chat(db, kb.id, user_id)

        # For organization knowledge base, all authenticated users have access
        if _is_organization_namespace(db, kb.namespace):
            return True

        # For team knowledge base, check group membership
        role = get_effective_role_in_group(db, user_id, kb.namespace)
        return role is not None

    def _is_kb_bound_to_user_group_chat(
        self, db: Session, kb_id: int, user_id: int
    ) -> bool:
        """Check if a knowledge base is bound to any group chat that the user is a member of.

        When a knowledge base is bound to a group chat, all members of that group chat
        should have access to the knowledge base (reporter permission level).

        This method uses the task_knowledge_base_bindings table for efficient indexed
        queries instead of scanning JSON data. It joins with TaskResource to ensure
        only active group chat tasks are considered.

        Args:
            db: Database session
            kb_id: Knowledge base Kind.id
            user_id: User ID to check

        Returns:
            True if KB is bound to at least one active group chat where user is a member
        """
        from sqlalchemy import or_, select

        from app.models.resource_member import MemberStatus, ResourceMember
        from app.models.share_link import ResourceType
        from app.models.task import TaskResource
        from app.models.task_kb_binding import TaskKnowledgeBaseBinding

        # Build query that joins TaskKnowledgeBaseBinding with TaskResource
        # to ensure only active group chat tasks are considered
        # Check if there's any binding where:
        # 1. The KB matches the given kb_id
        # 2. The task is an active "Task" kind (group chat)
        # 3. The user is either the task owner OR an approved member
        # Subquery: active tasks owned by user
        owned_task_subquery = select(TaskResource.id).where(
            TaskResource.user_id == user_id,
            TaskResource.is_active == True,
            TaskResource.kind == "Task",
        )

        # Subquery: tasks where user is approved member (join with TaskResource for active check)
        member_task_subquery = (
            select(ResourceMember.resource_id)
            .join(TaskResource, TaskResource.id == ResourceMember.resource_id)
            .where(
                ResourceMember.user_id == user_id,
                ResourceMember.resource_type == ResourceType.TASK,
                ResourceMember.status == MemberStatus.APPROVED,
                TaskResource.is_active == True,
                TaskResource.kind == "Task",
            )
        )

        # Main query: check if any binding exists with active group chat task
        exists_query = (
            db.query(TaskKnowledgeBaseBinding)
            .join(TaskResource, TaskResource.id == TaskKnowledgeBaseBinding.task_id)
            .filter(
                TaskKnowledgeBaseBinding.knowledge_base_id == kb_id,
                TaskResource.is_active == True,
                TaskResource.kind == "Task",
                or_(
                    TaskKnowledgeBaseBinding.task_id.in_(owned_task_subquery),
                    TaskKnowledgeBaseBinding.task_id.in_(member_task_subquery),
                ),
            )
            .exists()
        )

        result = db.query(exists_query).scalar()
        return bool(result)

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

    def get_knowledge_base_by_id(self, db: Session, kb_id: int) -> Optional[Kind]:
        """Get a knowledge base by Kind.id.

        Args:
            db: Database session
            kb_id: Knowledge base Kind.id

        Returns:
            Kind object if found, None otherwise
        """
        return (
            db.query(Kind)
            .filter(
                Kind.id == kb_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active == True,
            )
            .first()
        )

    def get_knowledge_bases_by_ids(
        self, db: Session, kb_ids: List[int]
    ) -> dict[int, Kind]:
        """Batch get knowledge bases by Kind.ids.

        This method performs a single database query for multiple IDs,
        avoiding the N+1 query problem.

        Args:
            db: Database session
            kb_ids: List of knowledge base Kind.ids

        Returns:
            Dictionary mapping kb_id to Kind object
        """
        if not kb_ids:
            return {}

        knowledge_bases = (
            db.query(Kind)
            .filter(
                Kind.id.in_(kb_ids),
                Kind.kind == "KnowledgeBase",
                Kind.is_active == True,
            )
            .all()
        )

        return {kb.id: kb for kb in knowledge_bases}

    def get_knowledge_base_by_ref(
        self, db: Session, ref: dict
    ) -> tuple[Optional[Kind], bool]:
        """Get knowledge base by reference (ID or name).

        This method implements ID-priority lookup with name fallback for
        backward compatibility with legacy data.

        Priority:
        1. If 'id' exists and is not None, query by Kind.id directly
        2. If 'id' not found or None, fall back to name + namespace lookup
        3. Returns a flag indicating if migration is needed (found by name only)

        Args:
            db: Database session
            ref: Dictionary with 'id', 'name', 'namespace' fields

        Returns:
            Tuple of (Kind object if found or None, needs_migration flag)
            needs_migration is True if KB was found by name-only (legacy data)
        """
        kb_id = ref.get("id")
        kb_name = ref.get("name")
        kb_namespace = ref.get("namespace", "default")

        # Priority 1: Look up by ID if available
        if kb_id is not None:
            kb = self.get_knowledge_base_by_id(db, kb_id)
            if kb:
                logger.debug(
                    f"[get_knowledge_base_by_ref] Found KB by ID: "
                    f"id={kb_id}, name={kb_name}"
                )
                return kb, False
            else:
                # ID exists but KB not found (possibly deleted)
                logger.warning(
                    f"[get_knowledge_base_by_ref] KB not found by ID: "
                    f"id={kb_id}, name={kb_name}, namespace={kb_namespace}"
                )
                return None, False

        # Priority 2: Fall back to name + namespace lookup (legacy data)
        if kb_name:
            kb = self.get_knowledge_base_by_name(db, kb_name, kb_namespace)
            if kb:
                logger.info(
                    f"[get_knowledge_base_by_ref] Found KB by name (legacy data): "
                    f"name={kb_name}, namespace={kb_namespace}, id={kb.id}"
                )
                return kb, True  # needs_migration = True
            else:
                logger.warning(
                    f"[get_knowledge_base_by_ref] KB not found by name: "
                    f"name={kb_name}, namespace={kb_namespace}"
                )
                return None, False

        return None, False

    def resolve_kb_refs_batch(
        self, db: Session, kb_refs: List[dict]
    ) -> tuple[List[tuple[int, Kind, bool]], List[tuple[int, str, str]]]:
        """Batch resolve knowledge base references with optimized queries.

        This method performs batch queries to avoid N+1 query problem:
        1. First batch query: Get all KBs by IDs (for refs with id field)
        2. Second batch query: Get all KBs by namespaces (for legacy name-only refs)
        3. Filter by name in Python for legacy refs

        Args:
            db: Database session
            kb_refs: List of KB reference dictionaries with 'id', 'name', 'namespace'

        Returns:
            Tuple of:
            - List of (index, Kind, needs_migration) for found KBs
            - List of (index, name, namespace) for not-found refs
        """
        if not kb_refs:
            return [], []

        # Separate refs by type: with-ID vs legacy (name-only)
        refs_with_id: List[tuple[int, int, str, str]] = []  # (idx, id, name, namespace)
        refs_legacy: List[tuple[int, str, str]] = []  # (idx, name, namespace)

        for idx, ref in enumerate(kb_refs):
            kb_id = ref.get("id")
            kb_name = ref.get("name")
            kb_namespace = ref.get("namespace", "default")

            if kb_id is not None:
                refs_with_id.append((idx, kb_id, kb_name or "", kb_namespace))
            elif kb_name:
                refs_legacy.append((idx, kb_name, kb_namespace))

        found_kbs: List[tuple[int, Kind, bool]] = []  # (idx, kb, needs_migration)
        not_found: List[tuple[int, str, str]] = []  # (idx, name, namespace)

        # Batch query 1: Get KBs by IDs
        if refs_with_id:
            kb_ids = [r[1] for r in refs_with_id]
            kb_map = self.get_knowledge_bases_by_ids(db, kb_ids)

            for idx, kb_id, kb_name, kb_namespace in refs_with_id:
                kb = kb_map.get(kb_id)
                if kb:
                    logger.debug(
                        f"[resolve_kb_refs_batch] Found KB by ID: id={kb_id}, name={kb_name}"
                    )
                    found_kbs.append((idx, kb, False))
                else:
                    logger.warning(
                        f"[resolve_kb_refs_batch] KB not found by ID: "
                        f"id={kb_id}, name={kb_name}, namespace={kb_namespace}"
                    )
                    not_found.append((idx, kb_name, kb_namespace))

        # Batch query 2: Get KBs for legacy refs (by namespace, then filter by name)
        if refs_legacy:
            # Group legacy refs by namespace for efficient querying
            namespace_groups: dict[str, List[tuple[int, str]]] = {}
            for idx, name, namespace in refs_legacy:
                if namespace not in namespace_groups:
                    namespace_groups[namespace] = []
                namespace_groups[namespace].append((idx, name))

            # Query each namespace once
            for namespace, name_refs in namespace_groups.items():
                namespace_kbs = (
                    db.query(Kind)
                    .filter(
                        Kind.kind == "KnowledgeBase",
                        Kind.namespace == namespace,
                        Kind.is_active == True,
                    )
                    .all()
                )

                # Build name -> KB mapping for this namespace
                name_to_kb: dict[str, Kind] = {}
                for kb in namespace_kbs:
                    kb_spec = kb.json.get("spec", {}) if kb.json else {}
                    display_name = kb_spec.get("name")
                    if display_name:
                        name_to_kb[display_name] = kb

                # Match legacy refs
                for idx, name in name_refs:
                    kb = name_to_kb.get(name)
                    if kb:
                        logger.info(
                            f"[resolve_kb_refs_batch] Found KB by name (legacy): "
                            f"name={name}, namespace={namespace}, id={kb.id}"
                        )
                        found_kbs.append((idx, kb, True))  # needs_migration=True
                    else:
                        logger.warning(
                            f"[resolve_kb_refs_batch] KB not found by name: "
                            f"name={name}, namespace={namespace}"
                        )
                        not_found.append((idx, name, namespace))

        # Sort by original index to maintain order
        found_kbs.sort(key=lambda x: x[0])

        return found_kbs, not_found

    def _migrate_kb_ref_to_include_id(
        self,
        db: Session,
        task: TaskResource,
        ref_index: int,
        kb_id: int,
    ) -> None:
        """Migrate a KB reference to include ID field.

        This is an internal helper method for lazy migration of legacy refs.

        Args:
            db: Database session
            task: TaskResource object
            ref_index: Index of the ref in knowledgeBaseRefs list
            kb_id: Knowledge base Kind.id to add
        """
        try:
            task_json = task.json if isinstance(task.json, dict) else {}
            spec = task_json.get("spec", {})
            kb_refs = spec.get("knowledgeBaseRefs", []) or []

            if 0 <= ref_index < len(kb_refs):
                old_name = kb_refs[ref_index].get("name")
                kb_refs[ref_index]["id"] = kb_id
                spec["knowledgeBaseRefs"] = kb_refs
                task_json["spec"] = spec
                task.json = task_json
                flag_modified(task, "json")
                db.commit()
                logger.info(
                    f"Migrated KB reference from name to ID: "
                    f"task_id={task.id}, kb_name={old_name}, kb_id={kb_id}"
                )
        except Exception as e:
            logger.warning(
                f"Failed to migrate KB ref to ID: task_id={task.id}, "
                f"ref_index={ref_index}, kb_id={kb_id}, error={e}"
            )
            db.rollback()

    def _batch_migrate_kb_refs(
        self,
        db: Session,
        task: TaskResource,
        refs_to_migrate: list[tuple[int, int]],
    ) -> None:
        """Batch migrate KB references to include ID field.

        This method performs a single DB commit for all migrations,
        which is more efficient than individual commits.

        Args:
            db: Database session
            task: TaskResource object
            refs_to_migrate: List of (ref_index, kb_id) tuples
        """
        if not refs_to_migrate:
            return

        try:
            task_json = task.json if isinstance(task.json, dict) else {}
            spec = task_json.get("spec", {})
            kb_refs = spec.get("knowledgeBaseRefs", []) or []

            migrated_names = []
            for ref_index, kb_id in refs_to_migrate:
                if 0 <= ref_index < len(kb_refs):
                    old_name = kb_refs[ref_index].get("name")
                    kb_refs[ref_index]["id"] = kb_id
                    migrated_names.append(f"{old_name}->id={kb_id}")

            spec["knowledgeBaseRefs"] = kb_refs
            task_json["spec"] = spec
            task.json = task_json
            flag_modified(task, "json")
            db.commit()

            logger.info(
                f"Batch migrated KB references from name to ID: "
                f"task_id={task.id}, refs=[{', '.join(migrated_names)}]"
            )
        except Exception as e:
            logger.warning(
                f"Failed to batch migrate KB refs: task_id={task.id}, "
                f"refs_count={len(refs_to_migrate)}, error={e}"
            )
            db.rollback()

    def get_bound_knowledge_bases(
        self, db: Session, task_id: int, user_id: int
    ) -> List[BoundKnowledgeBaseDetail]:
        """
        Get knowledge bases bound to a group chat task.

        This method uses batch queries to avoid N+1 query problem:
        - Single query for refs with ID field
        - Query per namespace for legacy name-only refs

        Legacy refs (name-only) are automatically migrated to include the ID field.

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

        if not kb_refs:
            return []

        # Use batch query to resolve all refs efficiently
        found_kbs, _ = self.resolve_kb_refs_batch(db, kb_refs)

        # Build result and collect refs needing migration
        result = []
        refs_to_migrate = []

        # Collect all KB IDs for batch document count query
        kb_ids = [kb.id for _, kb, _ in found_kbs]
        doc_counts = KnowledgeService.get_active_document_counts_batch(db, kb_ids)

        for idx, kb, needs_migration in found_kbs:
            ref = kb_refs[idx]
            kb_name = ref.get("name")
            kb_namespace = ref.get("namespace", "default")

            if needs_migration:
                refs_to_migrate.append((idx, kb.id))

            kb_spec = kb.json.get("spec", {})
            display_name = kb_spec.get("name", kb_name)
            description = kb_spec.get("description")
            document_count = doc_counts.get(kb.id, 0)

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

        # Perform batch migration for legacy refs
        if refs_to_migrate:
            self._batch_migrate_kb_refs(db, task, refs_to_migrate)

        return result

    def get_bound_knowledge_base_ids(self, db: Session, task_id: int) -> List[int]:
        """
        Get IDs of knowledge bases bound to a task.
        This method does not check permissions - used internally for AI integration.

        This method uses batch queries to avoid N+1 query problem:
        - Single query for refs with ID field
        - Query per namespace for legacy name-only refs

        Legacy refs (name-only) are automatically migrated to include the ID field.

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

        if not kb_refs:
            return []

        # Use batch query to resolve all refs efficiently
        found_kbs, _ = self.resolve_kb_refs_batch(db, kb_refs)

        # Build result and collect refs needing migration
        result = []
        refs_to_migrate = []

        for idx, kb, needs_migration in found_kbs:
            result.append(kb.id)
            if needs_migration:
                refs_to_migrate.append((idx, kb.id))

        # Perform batch migration for legacy refs
        if refs_to_migrate:
            self._batch_migrate_kb_refs(db, task, refs_to_migrate)

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

        # Check if already bound (by ID or by name+namespace)
        for ref in kb_refs:
            if (ref.get("id") == kb.id) or (
                ref.get("name") == kb_name
                and ref.get("namespace", "default") == kb_namespace
            ):
                raise HTTPException(
                    status_code=400, detail="Knowledge base is already bound"
                )

        # Get user info
        user = self.get_user(db, user_id)
        user_name = user.user_name if user else "Unknown"

        # Add new binding (include ID for stable references)
        new_ref = KnowledgeBaseTaskRef(
            id=kb.id,
            name=kb_name,
            namespace=kb_namespace,
            boundBy=user_name,
            boundAt=datetime.utcnow().isoformat() + "Z",
        )
        kb_refs.append(new_ref.model_dump())

        # Update task spec (JSON)
        spec["knowledgeBaseRefs"] = kb_refs
        task_json["spec"] = spec
        task.json = task_json
        flag_modified(task, "json")

        # Also write to bindings table for efficient queries
        from sqlalchemy.exc import IntegrityError

        from app.models.task_kb_binding import TaskKnowledgeBaseBinding

        binding = TaskKnowledgeBaseBinding(
            task_id=task_id,
            knowledge_base_id=kb.id,
            bound_by=user_name,
            bound_at=datetime.utcnow(),
        )
        try:
            db.add(binding)
            db.flush()
        except IntegrityError:
            # Binding already exists, rollback and continue
            db.rollback()
            logger.info(
                f"[bind_knowledge_base] Binding already exists for task {task_id} and KB {kb.id}"
            )

        task.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(task)

        logger.info(
            f"Knowledge base {kb_name}/{kb_namespace} bound to task {task_id} by user {user_id}"
        )

        # Return bound KB details
        kb_spec = kb.json.get("spec", {})
        # Use batch method for single KB (consistent API, no N+1 issue here)
        doc_counts = KnowledgeService.get_active_document_counts_batch(db, [kb.id])
        return BoundKnowledgeBaseDetail(
            id=kb.id,
            name=kb_name,
            namespace=kb_namespace,
            display_name=kb_spec.get("name", kb_name),
            description=kb_spec.get("description"),
            document_count=doc_counts.get(kb.id, 0),
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
        kb_id: Optional[int] = None,
    ) -> bool:
        """
        Unbind a knowledge base from a group chat task.

        This method supports unbinding by either ID or name+namespace.
        ID matching is preferred when kb_id is provided.

        Args:
            db: Database session
            task_id: Task ID
            kb_name: Knowledge base name
            kb_namespace: Knowledge base namespace
            user_id: User ID
            kb_id: Optional knowledge base ID (preferred for matching)

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

        # Find and remove the binding (by ID or by name+namespace)
        found = False
        found_kb_id = None
        new_refs = []
        for ref in kb_refs:
            # Match by ID (preferred) or by name+namespace
            is_match = False
            if kb_id is not None and ref.get("id") == kb_id:
                is_match = True
                found_kb_id = kb_id
            elif (
                ref.get("name") == kb_name
                and ref.get("namespace", "default") == kb_namespace
            ):
                is_match = True
                found_kb_id = ref.get("id")  # Get ID from ref for bindings table

            if is_match:
                found = True
            else:
                new_refs.append(ref)

        if not found:
            raise HTTPException(
                status_code=404, detail="Knowledge base is not bound to this task"
            )

        # Update task spec (JSON)
        spec["knowledgeBaseRefs"] = new_refs
        task_json["spec"] = spec
        task.json = task_json
        flag_modified(task, "json")

        # Also delete from bindings table
        if found_kb_id is not None:
            from app.models.task_kb_binding import TaskKnowledgeBaseBinding

            db.query(TaskKnowledgeBaseBinding).filter(
                TaskKnowledgeBaseBinding.task_id == task_id,
                TaskKnowledgeBaseBinding.knowledge_base_id == found_kb_id,
            ).delete()

        task.updated_at = datetime.utcnow()
        db.commit()

        logger.info(
            f"Knowledge base {kb_name}/{kb_namespace} unbound from task {task_id} by user {user_id}"
        )

        return True

    def sync_subtask_kb_to_task(
        self,
        db: Session,
        task: TaskResource,
        knowledge_id: int,
        user_id: int,
        user_name: str,
    ) -> bool:
        """
        Sync a subtask-level knowledge base to task-level knowledgeBaseRefs.

        This is an internal method that automatically syncs KB selected in subtask
        to the task level. It uses append mode with deduplication.

        Unlike bind_knowledge_base(), this method:
        - Does NOT require group chat check (works for all tasks)
        - Does NOT throw exceptions on failures (silent skip)
        - Skips if KB limit is reached (instead of raising error)
        - Skips if user has no access (instead of raising error)

        Args:
            db: Database session
            task: Pre-queried TaskResource object
            knowledge_id: Knowledge base Kind.id
            user_id: User ID who selected the KB
            user_name: Pre-queried user name for boundBy field

        Returns:
            True if synced successfully, False if skipped
        """
        try:
            # Get the knowledge base by ID
            kb = (
                db.query(Kind)
                .filter(
                    Kind.id == knowledge_id,
                    Kind.kind == "KnowledgeBase",
                    Kind.is_active == True,
                )
                .first()
            )

            if not kb:
                logger.debug(
                    f"[sync_subtask_kb_to_task] KB not found: knowledge_id={knowledge_id}"
                )
                return False

            # Extract KB display name and namespace
            kb_spec = kb.json.get("spec", {}) if kb.json else {}
            kb_name = kb_spec.get("name")
            kb_namespace = kb.namespace

            if not kb_name:
                logger.debug(
                    f"[sync_subtask_kb_to_task] KB has no display name: knowledge_id={knowledge_id}"
                )
                return False

            # Check user access to the knowledge base
            if not self.can_access_knowledge_base(db, user_id, kb_name, kb_namespace):
                logger.debug(
                    f"[sync_subtask_kb_to_task] User {user_id} has no access to KB "
                    f"{kb_name}/{kb_namespace}"
                )
                return False

            # Get current task spec
            task_json = task.json if isinstance(task.json, dict) else {}
            spec = task_json.get("spec", {})
            kb_refs = spec.get("knowledgeBaseRefs", []) or []

            # Check binding limit - skip silently if reached
            if len(kb_refs) >= self.MAX_BOUND_KNOWLEDGE_BASES:
                logger.debug(
                    f"[sync_subtask_kb_to_task] KB limit reached for task {task.id}, "
                    f"skipping sync of KB {kb_name}/{kb_namespace}"
                )
                return False

            # Check if already bound (deduplication by ID or by name+namespace)
            for ref in kb_refs:
                if (ref.get("id") == kb.id) or (
                    ref.get("name") == kb_name
                    and ref.get("namespace", "default") == kb_namespace
                ):
                    logger.debug(
                        f"[sync_subtask_kb_to_task] KB {kb_name}/{kb_namespace} "
                        f"already bound to task {task.id}"
                    )
                    return False

            # Add new binding with ID for stable references
            bound_at = datetime.utcnow()
            new_ref = KnowledgeBaseTaskRef(
                id=kb.id,
                name=kb_name,
                namespace=kb_namespace,
                boundBy=user_name,
                boundAt=bound_at.isoformat() + "Z",
            )
            kb_refs.append(new_ref.model_dump())

            # Update task spec (JSON)
            spec["knowledgeBaseRefs"] = kb_refs
            task_json["spec"] = spec
            task.json = task_json
            flag_modified(task, "json")

            # Also write to bindings table for efficient queries
            from sqlalchemy.exc import IntegrityError

            from app.models.task_kb_binding import TaskKnowledgeBaseBinding

            binding = TaskKnowledgeBaseBinding(
                task_id=task.id,
                knowledge_base_id=kb.id,
                bound_by=user_name,
                bound_at=bound_at,
            )
            try:
                db.add(binding)
                db.flush()
            except IntegrityError:
                # Binding already exists, rollback and continue
                db.rollback()
                logger.info(
                    f"[sync_subtask_kb_to_task] Binding already exists for task {task.id} and KB {kb.id}"
                )

            task.updated_at = datetime.utcnow()
            db.commit()
            db.refresh(task)

            logger.info(
                f"[sync_subtask_kb_to_task] Synced KB {kb_name}/{kb_namespace} "
                f"to task {task.id} (selected by user {user_id})"
            )
            return True

        except Exception as e:
            logger.warning(
                f"[sync_subtask_kb_to_task] Failed to sync KB {knowledge_id} "
                f"to task {task.id}: {e}"
            )
            db.rollback()
            return False


task_knowledge_base_service = TaskKnowledgeBaseService()
