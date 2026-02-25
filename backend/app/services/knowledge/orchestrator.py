# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge Orchestrator - Unified business layer for knowledge base operations.

This module provides a unified service layer for both REST API and MCP tools,
handling complete business flows without FastAPI-specific dependencies.

Key responsibilities:
- Orchestrate complete workflows (e.g., create document = upload + create + index)
- Auto-select default retrievers and embedding models (following frontend logic)
- Schedule async tasks via Celery for both indexing and summary generation

Architecture:
- REST API and MCP tools both call Orchestrator methods
- Orchestrator uses Celery tasks for async operations (unified approach)
- Shared indexing logic lives in `app/services/knowledge/indexing.py`
"""

import base64
import logging
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.knowledge import (
    KnowledgeBaseCreate,
    KnowledgeBaseListResponse,
    KnowledgeBaseResponse,
    KnowledgeDocumentCreate,
    KnowledgeDocumentListResponse,
    KnowledgeDocumentResponse,
    ResourceScope,
)
from app.services.knowledge.knowledge_service import KnowledgeService

logger = logging.getLogger(__name__)

DEFAULT_TEXT_FILE_EXTENSION = "txt"


def _normalize_file_extension(file_extension: Optional[str]) -> str:
    """Normalize file extension to a safe, dot-less form.

    Args:
        file_extension: File extension provided by caller (may include leading dot)

    Returns:
        Normalized file extension without leading dot (e.g., "txt")
    """
    ext = (file_extension or "").strip()
    ext = ext.lstrip(".")
    if not ext:
        return DEFAULT_TEXT_FILE_EXTENSION
    # Basic safety checks (avoid path injection / invalid filenames)
    if "/" in ext or "\\" in ext or ".." in ext:
        raise ValueError("Invalid file_extension")
    return ext


def _build_filename(name: str, file_extension: str) -> str:
    """Build a safe filename for attachment upload."""
    ext = _normalize_file_extension(file_extension)
    return f"{name}.{ext}"


class KnowledgeOrchestrator:
    """
    Knowledge base operations orchestrator.

    This service layer unifies REST API and MCP tool implementations,
    providing complete business workflows without FastAPI dependencies.

    All async tasks (indexing, summary generation) are handled via Celery,
    providing a unified approach across REST API and MCP tools.

    Usage:
        orchestrator = KnowledgeOrchestrator()

        # Create document with indexing (uses Celery internally)
        doc = orchestrator.create_document_with_content(
            db=db,
            user=user,
            knowledge_base_id=123,
            name="My Document",
            source_type="text",
            content="Document content...",
            trigger_indexing=True,
        )

        # Update document content with re-indexing
        result = orchestrator.update_document_content(
            db=db,
            user=user,
            document_id=456,
            content="Updated content...",
            trigger_reindex=True,
        )
    """

    def _get_available_models(
        self,
        db: Session,
        user: User,
        namespace: str,
        model_category_type: str,
    ) -> List[Dict[str, Any]]:
        """
        Get available models for the user.

        This is a shared helper method for both embedding and LLM model selection.

        Args:
            db: Database session
            user: User object
            namespace: Knowledge base namespace
            model_category_type: Model category type (embedding, llm, etc.)

        Returns:
            List of available models
        """
        from app.services.model_aggregation_service import model_aggregation_service

        scope = "personal" if namespace == "default" else "group"
        group_name = None if namespace == "default" else namespace

        return model_aggregation_service.list_available_models(
            db=db,
            current_user=user,
            shell_type=None,
            include_config=False,
            scope=scope,
            group_name=group_name,
            model_category_type=model_category_type,
        )

    def get_default_retriever(
        self,
        db: Session,
        user_id: int,
        namespace: str = "default",
    ) -> Optional[Dict[str, str]]:
        """
        Get default retriever following frontend auto-selection logic.

        Priority:
        - Personal scope (namespace="default"): user > public
        - Group scope: group > public

        Args:
            db: Database session
            user_id: User ID
            namespace: Knowledge base namespace

        Returns:
            Dict with retriever_name and retriever_namespace, or None if not found
        """
        from app.services.adapters.retriever_kinds import retriever_kinds_service

        scope = "personal" if namespace == "default" else "group"
        group_name = None if namespace == "default" else namespace

        retrievers = retriever_kinds_service.list_retrievers(
            db=db,
            user_id=user_id,
            scope=scope,
            group_name=group_name,
        )

        if not retrievers:
            logger.warning(
                f"[Orchestrator] No retrievers found: user_id={user_id}, namespace={namespace}"
            )
            return None

        # Frontend sorts by type: user > group > public
        # The service already returns sorted results, take the first one
        first = retrievers[0]
        logger.info(
            f"[Orchestrator] Auto-selected retriever: name={first['name']}, "
            f"namespace={first['namespace']}, type={first.get('type', 'unknown')}"
        )
        return {
            "retriever_name": first["name"],
            "retriever_namespace": first["namespace"],
        }

    def get_default_embedding_model(
        self,
        db: Session,
        user_id: int,
        namespace: str = "default",
    ) -> Optional[Dict[str, str]]:
        """
        Get default embedding model following frontend auto-selection logic.

        Priority: user > public

        Args:
            db: Database session
            user_id: User ID
            namespace: Knowledge base namespace

        Returns:
            Dict with model_name and model_namespace, or None if not found
        """
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            logger.warning(f"[Orchestrator] User not found: user_id={user_id}")
            return None

        models = self._get_available_models(db, user, namespace, "embedding")

        if not models:
            logger.warning(
                f"[Orchestrator] No embedding models found: user_id={user_id}, namespace={namespace}"
            )
            return None

        # Take the first available embedding model
        first = models[0]
        logger.info(
            f"[Orchestrator] Auto-selected embedding model: name={first['name']}, "
            f"namespace={first.get('namespace', 'default')}, type={first.get('type', 'unknown')}"
        )
        return {
            "model_name": first["name"],
            "model_namespace": first.get("namespace", "default"),
        }

    def get_task_model_as_summary_model(
        self,
        db: Session,
        task_id: int,
        user_id: int,
    ) -> Optional[Dict[str, str]]:
        """
        Get the model used by a Task for use as summary model.

        Resolution priority:
        1. Task.metadata.labels.modelId (runtime model override)
        2. Task → Team → Bot → modelRef (static configuration)

        Args:
            db: Database session
            task_id: Task ID
            user_id: User ID

        Returns:
            Dict with name, namespace, and type, or None if not found
        """
        from app.schemas.kind import Bot, Task, Team

        logger.debug(
            f"[Orchestrator] Resolving summary model from task: task_id={task_id}, user_id={user_id}"
        )

        # 1. Get Task
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
            )
            .first()
        )
        if not task:
            logger.warning(f"[Orchestrator] Task not found: task_id={task_id}")
            return None

        try:
            task_crd = Task.model_validate(task.json)

            # 2. Try to get model from Task.metadata.labels (runtime override)
            model_from_labels = self._get_model_from_task_labels(db, task_crd, user_id)
            if model_from_labels:
                logger.info(
                    f"[Orchestrator] Resolved summary model from task labels: task_id={task_id}, "
                    f"model={model_from_labels['name']}, type={model_from_labels['type']}"
                )
                return model_from_labels

            # 3. Fallback: resolve from Task → Team → Bot → Model chain
            model_from_chain = self._get_model_from_bot_chain(
                db, task_crd, task_id, user_id
            )
            if model_from_chain:
                return model_from_chain

            logger.warning(
                f"[Orchestrator] Could not resolve model from task: task_id={task_id}"
            )
            return None

        except Exception as e:
            logger.warning(
                f"[Orchestrator] Failed to resolve model from task: task_id={task_id}, error={e}"
            )
            return None

    def _get_model_from_task_labels(
        self,
        db: Session,
        task_crd: Any,
        user_id: int,
    ) -> Optional[Dict[str, str]]:
        """
        Extract model info from Task.metadata.labels.

        Labels used:
        - modelId: Model name
        - forceOverrideBotModelType: Model type (user/public/group)

        Args:
            db: Database session
            task_crd: Task CRD object
            user_id: User ID

        Returns:
            Dict with name, namespace, and type, or None if not found in labels
        """
        if not task_crd.metadata or not task_crd.metadata.labels:
            return None

        labels = task_crd.metadata.labels
        model_id = labels.get("modelId")

        if not model_id:
            return None

        # Get model type from labels, default to "public"
        model_type = labels.get("forceOverrideBotModelType", "public")
        namespace = task_crd.metadata.namespace or "default"

        logger.debug(
            f"[Orchestrator] Found model in task labels: modelId={model_id}, "
            f"type={model_type}, namespace={namespace}"
        )

        # Validate the model exists in DB
        validated_type = self._determine_model_type(db, user_id, model_id, namespace)
        if not validated_type:
            # Model not found with task namespace, try "default" namespace
            validated_type = self._determine_model_type(
                db, user_id, model_id, "default"
            )

        if not validated_type:
            logger.warning(
                f"[Orchestrator] Model from task labels not found in DB: "
                f"modelId={model_id}, user_id={user_id}"
            )
            return None

        return {
            "name": model_id,
            "namespace": namespace if validated_type != "public" else "default",
            "type": validated_type,
        }

    def _get_model_from_bot_chain(
        self,
        db: Session,
        task_crd: Any,
        task_id: int,
        user_id: int,
    ) -> Optional[Dict[str, str]]:
        """
        Resolve model from Task → Team → Bot → modelRef chain.

        Args:
            db: Database session
            task_crd: Task CRD object
            task_id: Task ID (for logging)
            user_id: User ID

        Returns:
            Dict with name, namespace, and type, or None if not found
        """
        from app.schemas.kind import Bot, Team

        if not task_crd.spec or not task_crd.spec.teamRef:
            logger.debug(f"[Orchestrator] Task {task_id} has no teamRef")
            return None

        team_ref = task_crd.spec.teamRef
        logger.debug(
            f"[Orchestrator] Task {task_id} -> teamRef: name={team_ref.name}, "
            f"namespace={team_ref.namespace}"
        )

        # Get Team
        team = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Team",
                Kind.name == team_ref.name,
                Kind.namespace == (team_ref.namespace or "default"),
                Kind.is_active == True,
            )
            .first()
        )
        if not team:
            logger.debug(
                f"[Orchestrator] Team not found: name={team_ref.name}, "
                f"namespace={team_ref.namespace}"
            )
            return None

        # Get Bot from Team
        team_crd = Team.model_validate(team.json)
        if not team_crd.spec or not team_crd.spec.members:
            logger.debug(f"[Orchestrator] Team {team_ref.name} has no members")
            return None

        bot_ref = team_crd.spec.members[0].botRef
        if not bot_ref:
            logger.debug(f"[Orchestrator] Team {team_ref.name} member has no botRef")
            return None

        logger.debug(
            f"[Orchestrator] Team {team_ref.name} -> botRef: name={bot_ref.name}, "
            f"namespace={bot_ref.namespace}"
        )

        # Get Bot
        bot = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Bot",
                Kind.name == bot_ref.name,
                Kind.namespace == (bot_ref.namespace or "default"),
                Kind.is_active == True,
            )
            .first()
        )
        if not bot:
            logger.debug(
                f"[Orchestrator] Bot not found: name={bot_ref.name}, "
                f"namespace={bot_ref.namespace}"
            )
            return None

        # Get Model from Bot
        bot_crd = Bot.model_validate(bot.json)
        if not bot_crd.spec or not bot_crd.spec.modelRef:
            logger.debug(f"[Orchestrator] Bot {bot_ref.name} has no modelRef")
            return None

        model_ref = bot_crd.spec.modelRef
        model_name = model_ref.name
        model_namespace = model_ref.namespace or "default"

        logger.debug(
            f"[Orchestrator] Bot {bot_ref.name} -> modelRef: name={model_name}, "
            f"namespace={model_namespace}"
        )

        # Validate model exists
        model_type = self._determine_model_type(
            db, user_id, model_name, model_namespace
        )
        if not model_type:
            logger.warning(
                f"[Orchestrator] Model from bot chain not found in DB: "
                f"name={model_name}, namespace={model_namespace}"
            )
            return None

        logger.info(
            f"[Orchestrator] Resolved summary model from bot chain: task_id={task_id}, "
            f"model={model_name}, namespace={model_namespace}, type={model_type}"
        )
        return {
            "name": model_name,
            "namespace": model_namespace,
            "type": model_type,
        }

    def _determine_model_type(
        self,
        db: Session,
        user_id: int,
        model_name: str,
        model_namespace: str,
    ) -> Optional[str]:
        """
        Determine the type of a model by checking where it exists.

        Priority: user > group > public

        Args:
            db: Database session
            user_id: User ID
            model_name: Model name
            model_namespace: Model namespace

        Returns:
            Model type ('user', 'group', 'public') or None if not found
        """
        # Check user model first
        user_model = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Model",
                Kind.name == model_name,
                Kind.namespace == model_namespace,
                Kind.is_active == True,
            )
            .first()
        )
        if user_model:
            # Determine if it's a user model or group model based on namespace
            if model_namespace == "default":
                return "user"
            else:
                return "group"

        # Check public model (user_id = 0)
        public_model = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Model",
                Kind.name == model_name,
                Kind.is_active == True,
            )
            .first()
        )
        if public_model:
            return "public"

        return None

    def list_knowledge_bases(
        self,
        db: Session,
        user: User,
        scope: str = "all",
        group_name: Optional[str] = None,
    ) -> KnowledgeBaseListResponse:
        """
        List knowledge bases accessible to the user.

        Args:
            db: Database session
            user: Current user
            scope: Resource scope (personal, group, all)
            group_name: Group name for group scope

        Returns:
            KnowledgeBaseListResponse with knowledge base list
        """
        try:
            resource_scope = ResourceScope(scope)
        except ValueError:
            resource_scope = ResourceScope.ALL

        knowledge_bases = KnowledgeService.list_knowledge_bases(
            db=db,
            user_id=user.id,
            scope=resource_scope,
            group_name=group_name,
        )

        return KnowledgeBaseListResponse(
            total=len(knowledge_bases),
            items=[
                KnowledgeBaseResponse.from_kind(
                    kb, KnowledgeService.get_document_count(db, kb.id)
                )
                for kb in knowledge_bases
            ],
        )

    def list_documents(
        self,
        db: Session,
        user: User,
        knowledge_base_id: int,
    ) -> KnowledgeDocumentListResponse:
        """
        List documents in a knowledge base.

        Args:
            db: Database session
            user: Current user
            knowledge_base_id: Knowledge base ID

        Returns:
            KnowledgeDocumentListResponse with document list

        Raises:
            ValueError: If knowledge base not found or access denied
        """
        # Verify access
        kb = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=user.id,
        )
        if not kb:
            raise ValueError("Knowledge base not found or access denied")

        documents = KnowledgeService.list_documents(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=user.id,
        )

        return KnowledgeDocumentListResponse(
            total=len(documents),
            items=[KnowledgeDocumentResponse.model_validate(doc) for doc in documents],
        )

    def get_knowledge_base(
        self,
        db: Session,
        user: User,
        knowledge_base_id: int,
    ) -> KnowledgeBaseResponse:
        """
        Get a knowledge base by ID.

        Args:
            db: Database session
            user: Current user
            knowledge_base_id: Knowledge base ID

        Returns:
            KnowledgeBaseResponse

        Raises:
            ValueError: If knowledge base not found or access denied
        """
        knowledge_base = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=user.id,
        )

        if not knowledge_base:
            raise ValueError("Knowledge base not found or access denied")

        return KnowledgeBaseResponse.from_kind(
            knowledge_base, KnowledgeService.get_document_count(db, knowledge_base.id)
        )

    def update_knowledge_base(
        self,
        db: Session,
        user: User,
        knowledge_base_id: int,
        name: Optional[str] = None,
        description: Optional[str] = None,
        retrieval_config: Optional[Dict[str, Any]] = None,
        summary_enabled: Optional[bool] = None,
        summary_model_ref: Optional[Dict[str, str]] = None,
    ) -> KnowledgeBaseResponse:
        """
        Update a knowledge base.

        Args:
            db: Database session
            user: Current user
            knowledge_base_id: Knowledge base ID
            name: New name (optional)
            description: New description (optional)
            retrieval_config: New retrieval config (optional)
            summary_enabled: New summary enabled flag (optional)
            summary_model_ref: New summary model reference (optional)

        Returns:
            KnowledgeBaseResponse

        Raises:
            ValueError: If knowledge base not found, access denied, or validation fails
        """
        from app.schemas.knowledge import KnowledgeBaseUpdate

        # Build update data with only provided fields
        update_data = KnowledgeBaseUpdate(
            name=name,
            description=description,
            retrieval_config=retrieval_config,
            summary_enabled=summary_enabled,
            summary_model_ref=summary_model_ref,
        )

        knowledge_base = KnowledgeService.update_knowledge_base(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=user.id,
            data=update_data,
        )

        if not knowledge_base:
            raise ValueError("Knowledge base not found or access denied")

        return KnowledgeBaseResponse.from_kind(
            knowledge_base, KnowledgeService.get_document_count(db, knowledge_base.id)
        )

    def create_knowledge_base(
        self,
        db: Session,
        user: User,
        name: str,
        description: Optional[str] = None,
        namespace: str = "default",
        kb_type: str = "notebook",
        summary_enabled: bool = False,
        # REST API scenario: pass complete config
        retrieval_config: Optional[Dict[str, Any]] = None,
        # MCP scenario: auto-select or explicitly specify
        retriever_name: Optional[str] = None,
        retriever_namespace: Optional[str] = None,
        embedding_model_name: Optional[str] = None,
        embedding_model_namespace: Optional[str] = None,
        summary_model_ref: Optional[Dict[str, str]] = None,
        # MCP context: for getting task's model as summary_model
        task_id: Optional[int] = None,
    ) -> KnowledgeBaseResponse:
        """
        Create a knowledge base with auto-configuration support.

        Supports two modes:
        1. REST API mode: Pass complete retrieval_config dict
        2. MCP mode: Auto-select or specify individual retriever/embedding params

        Auto-selection logic (when retrieval_config is None):
        1. retriever: If not specified, auto-select using get_default_retriever()
        2. embedding: If not specified, auto-select using get_default_embedding_model()
        3. summary_model: If not specified and summary_enabled=True:
           - If task_id provided, use get_task_model_as_summary_model()
           - Otherwise use first available LLM model

        Args:
            db: Database session
            user: Current user
            name: Knowledge base name
            description: Optional description
            namespace: Namespace (default for personal, group name for group)
            kb_type: Type (notebook or classic)
            summary_enabled: Enable summary generation
            retrieval_config: Complete retrieval config dict (REST API mode)
            retriever_name: Optional retriever name (MCP mode)
            retriever_namespace: Optional retriever namespace (MCP mode)
            embedding_model_name: Optional embedding model name (MCP mode)
            embedding_model_namespace: Optional embedding model namespace (MCP mode)
            summary_model_ref: Optional summary model reference
            task_id: Optional task ID for resolving summary model

        Returns:
            KnowledgeBaseResponse

        Raises:
            ValueError: If validation fails
        """
        logger.info(
            f"[Orchestrator] create_knowledge_base called: name={name}, namespace={namespace}, "
            f"kb_type={kb_type}, summary_enabled={summary_enabled}, task_id={task_id}, "
            f"user_id={user.id}, has_retrieval_config={retrieval_config is not None}, "
            f"has_summary_model_ref={summary_model_ref is not None}"
        )

        # Use provided retrieval_config or build one from individual params
        resolved_retrieval_config = retrieval_config

        if resolved_retrieval_config is None:
            # MCP mode: auto-select or use provided individual params
            # Auto-select retriever if not specified
            if retriever_name is None:
                default_retriever = self.get_default_retriever(db, user.id, namespace)
                if default_retriever:
                    retriever_name = default_retriever["retriever_name"]
                    retriever_namespace = default_retriever["retriever_namespace"]

            # Auto-select embedding model if not specified
            if embedding_model_name is None:
                default_embedding = self.get_default_embedding_model(
                    db, user.id, namespace
                )
                if default_embedding:
                    embedding_model_name = default_embedding["model_name"]
                    embedding_model_namespace = default_embedding["model_namespace"]

            # Build retrieval_config if we have both retriever and embedding
            if retriever_name and embedding_model_name:
                resolved_retrieval_config = {
                    "retriever_name": retriever_name,
                    "retriever_namespace": retriever_namespace or "default",
                    "embedding_config": {
                        "model_name": embedding_model_name,
                        "model_namespace": embedding_model_namespace or "default",
                    },
                    "retrieval_mode": "vector",
                    "top_k": 5,
                    "score_threshold": 0.5,
                }
                logger.info(
                    f"[Orchestrator] Built retrieval_config: retriever={retriever_name}, "
                    f"embedding={embedding_model_name}"
                )
            else:
                logger.warning(
                    f"[Orchestrator] Could not build retrieval_config: "
                    f"retriever={retriever_name}, embedding={embedding_model_name}"
                )

        # Auto-select summary model if summary_enabled and not specified
        resolved_summary_model_ref = summary_model_ref
        if summary_enabled and not resolved_summary_model_ref:
            logger.info(
                f"[Orchestrator] Auto-selecting summary model: task_id={task_id}"
            )
            if task_id:
                task_model = self.get_task_model_as_summary_model(db, task_id, user.id)
                if task_model:
                    resolved_summary_model_ref = task_model
            # Fallback: use first available LLM model
            if not resolved_summary_model_ref:
                logger.info(
                    f"[Orchestrator] Task model not found, falling back to first available LLM"
                )
                models = self._get_available_models(db, user, namespace, "llm")
                if models:
                    first_model = models[0]
                    resolved_summary_model_ref = {
                        "name": first_model["name"],
                        "namespace": first_model.get("namespace", "default"),
                        "type": first_model.get("type", "public"),  # Include model type
                    }
                    logger.info(
                        f"[Orchestrator] Auto-selected summary model from available LLMs: "
                        f"name={resolved_summary_model_ref['name']}, "
                        f"type={resolved_summary_model_ref['type']}"
                    )
                else:
                    logger.warning(
                        f"[Orchestrator] No LLM models available for user_id={user.id}, "
                        f"namespace={namespace}"
                    )

        # Fallback: if summary_enabled but no model found, disable summary
        if summary_enabled and not resolved_summary_model_ref:
            logger.warning(
                f"[Orchestrator] No LLM model available for summary generation, "
                f"disabling summary for KB: name={name}"
            )
            summary_enabled = False

        # Create knowledge base
        data = KnowledgeBaseCreate(
            name=name,
            description=description,
            namespace=namespace,
            kb_type=kb_type,
            retrieval_config=resolved_retrieval_config,
            summary_enabled=summary_enabled,
            summary_model_ref=resolved_summary_model_ref,
        )

        kb_id = KnowledgeService.create_knowledge_base(
            db=db,
            user_id=user.id,
            data=data,
        )
        db.commit()

        # Fetch and return created knowledge base
        knowledge_base = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=kb_id,
            user_id=user.id,
        )
        if not knowledge_base:
            raise ValueError("Failed to retrieve created knowledge base")

        return KnowledgeBaseResponse.from_kind(
            knowledge_base, KnowledgeService.get_document_count(db, knowledge_base.id)
        )

    def create_document_with_content(
        self,
        db: Session,
        user: User,
        knowledge_base_id: int,
        name: str,
        source_type: str,
        content: Optional[str] = None,
        file_base64: Optional[str] = None,
        file_extension: Optional[str] = None,
        url: Optional[str] = None,
        trigger_indexing: bool = True,
        trigger_summary: bool = True,
        splitter_config: Optional[Dict[str, Any]] = None,
    ) -> KnowledgeDocumentResponse:
        """
        Create a document with complete workflow.

        Flow: Upload attachment → Create document → Schedule indexing via Celery

        Args:
            db: Database session
            user: Current user
            knowledge_base_id: Target knowledge base ID
            name: Document name
            source_type: Source type (text, file, web)
            content: Text content for source_type="text"
            file_base64: Base64 encoded file for source_type="file"
            file_extension: File extension for source_type="file"
            url: URL for source_type="web"
            trigger_indexing: Whether to trigger RAG indexing
            trigger_summary: Whether to trigger summary generation
            splitter_config: Optional splitter configuration dict

        Returns:
            KnowledgeDocumentResponse

        Raises:
            ValueError: If validation fails or access denied
        """
        from app.services.context import context_service

        # Verify access
        kb = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=user.id,
        )
        if not kb:
            raise ValueError("Knowledge base not found or access denied")

        # Validate input based on source_type
        normalized_ext: str = DEFAULT_TEXT_FILE_EXTENSION
        binary_data: bytes = b""

        if source_type == "text":
            if not content:
                raise ValueError("content is required for source_type='text'")
            normalized_ext = _normalize_file_extension(file_extension)
            binary_data = content.encode("utf-8")

        elif source_type == "file":
            if not file_base64 or not file_extension:
                raise ValueError(
                    "file_base64 and file_extension are required for source_type='file'"
                )
            normalized_ext = _normalize_file_extension(file_extension)
            try:
                binary_data = base64.b64decode(file_base64)
            except Exception as e:
                raise ValueError(f"Invalid base64 encoding: {e}")

        elif source_type == "web":
            if not url:
                raise ValueError("url is required for source_type='web'")
            # Scrape URL content
            binary_data, normalized_ext = self._scrape_url_content(url)

        else:
            raise ValueError(f"Invalid source_type: {source_type}")

        # Upload attachment
        filename = _build_filename(name, normalized_ext)
        attachment, _ = context_service.upload_attachment(
            db=db,
            user_id=user.id,
            filename=filename,
            binary_data=binary_data,
            subtask_id=0,
        )

        # Create document using shared helper
        doc_data = KnowledgeDocumentCreate(
            name=name,
            source_type=source_type,
            attachment_id=attachment.id,
            file_extension=normalized_ext,
            file_size=len(binary_data),
        )

        return self._create_and_index_document(
            db=db,
            user=user,
            knowledge_base=kb,
            knowledge_base_id=knowledge_base_id,
            data=doc_data,
            trigger_indexing=trigger_indexing,
            trigger_summary=trigger_summary,
            splitter_config=splitter_config,
        )

    def create_document_from_attachment(
        self,
        db: Session,
        user: User,
        knowledge_base_id: int,
        data: KnowledgeDocumentCreate,
        trigger_indexing: bool = True,
        trigger_summary: bool = True,
    ) -> KnowledgeDocumentResponse:
        """
        Create a document from an already uploaded attachment.

        This method is used by REST API where attachment is uploaded separately
        via /api/attachments/upload endpoint.

        Flow: Verify access → Create document → Schedule indexing via Celery

        Args:
            db: Database session
            user: Current user
            knowledge_base_id: Target knowledge base ID
            data: Document creation data with attachment_id
            trigger_indexing: Whether to trigger RAG indexing
            trigger_summary: Whether to trigger summary generation

        Returns:
            KnowledgeDocumentResponse

        Raises:
            ValueError: If validation fails or access denied
        """
        # Verify access
        kb = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=user.id,
        )
        if not kb:
            raise ValueError("Knowledge base not found or access denied")

        # Get splitter config from data if provided
        splitter_config_dict = None
        if data.splitter_config:
            splitter_config_dict = data.splitter_config.model_dump()

        return self._create_and_index_document(
            db=db,
            user=user,
            knowledge_base=kb,
            knowledge_base_id=knowledge_base_id,
            data=data,
            trigger_indexing=trigger_indexing,
            trigger_summary=trigger_summary,
            splitter_config=splitter_config_dict,
        )

    def _create_and_index_document(
        self,
        db: Session,
        user: User,
        knowledge_base: Kind,
        knowledge_base_id: int,
        data: KnowledgeDocumentCreate,
        trigger_indexing: bool = True,
        trigger_summary: bool = True,
        splitter_config: Optional[Dict[str, Any]] = None,
    ) -> KnowledgeDocumentResponse:
        """
        Shared helper to create document and schedule indexing.

        This method contains the common logic for document creation and
        indexing scheduling, used by both create_document_with_content
        and create_document_from_attachment.

        Args:
            db: Database session
            user: Current user
            knowledge_base: Knowledge base Kind object (already verified)
            knowledge_base_id: Knowledge base ID
            data: Document creation data
            trigger_indexing: Whether to trigger RAG indexing
            trigger_summary: Whether to trigger summary generation
            splitter_config: Optional splitter configuration dict

        Returns:
            KnowledgeDocumentResponse
        """
        from app.schemas.knowledge import DocumentSourceType

        # Create document
        document = KnowledgeService.create_document(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=user.id,
            data=data,
        )

        logger.info(
            f"[Orchestrator] Created document {document.id} in KB {knowledge_base_id}"
        )

        # Schedule indexing via Celery if enabled
        # Skip RAG indexing for TABLE source type as table data should be queried in real-time
        if trigger_indexing and data.source_type != DocumentSourceType.TABLE:
            self._schedule_indexing_celery(
                db=db,
                knowledge_base=knowledge_base,
                document=document,
                user=user,
                trigger_summary=trigger_summary,
                splitter_config=splitter_config,
            )

        return KnowledgeDocumentResponse.model_validate(document)

    def update_document_content(
        self,
        db: Session,
        user: User,
        document_id: int,
        content: str,
        trigger_reindex: bool = True,
    ) -> Dict[str, Any]:
        """
        Update document content and optionally trigger re-indexing via Celery.

        Args:
            db: Database session
            user: Current user
            document_id: Document ID
            content: New content
            trigger_reindex: Whether to trigger RAG re-indexing

        Returns:
            Dict with success status and document_id

        Raises:
            ValueError: If validation fails or access denied
        """
        # Update document content
        document = KnowledgeService.update_document_content(
            db=db,
            document_id=document_id,
            content=content,
            user_id=user.id,
        )

        if not document:
            raise ValueError("Document not found or access denied")

        logger.info(f"[Orchestrator] Updated document {document_id} content")

        # Get knowledge base for indexing config
        kb = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=document.kind_id,
            user_id=user.id,
        )

        # Schedule re-indexing via Celery if enabled
        if trigger_reindex and kb:
            self._schedule_indexing_celery(
                db=db,
                knowledge_base=kb,
                document=document,
                user=user,
                trigger_summary=False,  # Don't re-generate summary on update
            )

        return {
            "success": True,
            "document_id": document.id,
            "message": "Document content updated successfully",
        }

    def _scrape_url_content(self, url: str) -> tuple[bytes, str]:
        """
        Scrape content from URL.

        Args:
            url: URL to scrape

        Returns:
            Tuple of (binary content, file extension)
        """
        import httpx
        from bs4 import BeautifulSoup

        try:
            with httpx.Client(timeout=30.0, follow_redirects=True) as client:
                response = client.get(url)
                response.raise_for_status()

            content_type = response.headers.get("content-type", "")
            if "text/html" in content_type:
                # Parse HTML and extract text
                soup = BeautifulSoup(response.text, "html.parser")
                # Remove script and style elements
                for element in soup(["script", "style", "nav", "footer", "header"]):
                    element.decompose()
                text = soup.get_text(separator="\n", strip=True)
                return text.encode("utf-8"), "txt"
            else:
                # Return raw content
                return response.content, "txt"

        except Exception as e:
            logger.error(f"Failed to scrape URL {url}: {e}")
            raise ValueError(f"Failed to scrape URL: {e}") from e

    def _schedule_indexing_celery(
        self,
        db: Session,
        knowledge_base: Kind,
        document: Any,
        user: User,
        trigger_summary: bool = True,
        splitter_config: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Schedule RAG indexing for a document via Celery.

        This method extracts the retrieval configuration from the knowledge base
        and schedules the indexing task via Celery.

        Args:
            db: Database session
            knowledge_base: Knowledge base Kind
            document: Document model
            user: Current user
            trigger_summary: Whether to trigger summary after indexing
            splitter_config: Optional splitter configuration dict
        """
        from app.services.knowledge.indexing import is_organization_namespace
        from app.tasks.knowledge_tasks import index_document_task

        spec = (knowledge_base.json or {}).get("spec", {})
        retrieval_config = spec.get("retrievalConfig")

        if not retrieval_config:
            logger.info(
                f"[Orchestrator] Skipping indexing for document {document.id}: no retrieval_config"
            )
            return

        retriever_name = retrieval_config.get("retriever_name")
        retriever_namespace = retrieval_config.get("retriever_namespace", "default")
        embedding_config = retrieval_config.get("embedding_config")

        if not retriever_name or not embedding_config:
            logger.warning(
                f"[Orchestrator] Incomplete retrieval_config for KB {knowledge_base.id}: "
                f"retriever_name={retriever_name}, embedding_config={embedding_config}"
            )
            return

        embedding_model_name = embedding_config.get("model_name")
        embedding_model_namespace = embedding_config.get("model_namespace", "default")

        if not embedding_model_name:
            logger.warning(
                f"[Orchestrator] Missing embedding model_name in KB {knowledge_base.id}"
            )
            return

        # Determine index owner user_id
        if knowledge_base.namespace == "default":
            index_owner_user_id = user.id
        elif is_organization_namespace(db, knowledge_base.namespace):
            index_owner_user_id = user.id
        else:
            # Group KB - use creator's user_id for shared index
            index_owner_user_id = knowledge_base.user_id

        logger.info(
            f"[Orchestrator] Scheduling RAG indexing via Celery for document {document.id}: "
            f"retriever={retriever_name}, embedding={embedding_model_name}, "
            f"index_owner_user_id={index_owner_user_id}"
        )

        # Schedule indexing via Celery
        index_document_task.delay(
            knowledge_base_id=str(knowledge_base.id),
            attachment_id=document.attachment_id,
            retriever_name=retriever_name,
            retriever_namespace=retriever_namespace,
            embedding_model_name=embedding_model_name,
            embedding_model_namespace=embedding_model_namespace,
            user_id=index_owner_user_id,
            user_name=user.user_name,
            document_id=document.id,
            splitter_config_dict=splitter_config,
            trigger_summary=trigger_summary,
        )

    def reindex_document(
        self,
        db: Session,
        user: User,
        document_id: int,
        trigger_summary: bool = False,
    ) -> Dict[str, Any]:
        """
        Trigger re-indexing for a document via Celery.

        Re-indexes the document using the knowledge base's configured retriever
        and embedding model. Only works for documents in knowledge bases with
        RAG configured.

        Args:
            db: Database session
            user: Current user
            document_id: Document ID to reindex
            trigger_summary: Whether to trigger summary generation after indexing

        Returns:
            Dict with success status and message

        Raises:
            ValueError: If document not found, access denied, or RAG not configured
        """
        from app.models.knowledge import KnowledgeDocument
        from app.schemas.knowledge import DocumentSourceType
        from app.services.knowledge.indexing import (
            extract_rag_config_from_knowledge_base,
        )
        from app.tasks.knowledge_tasks import index_document_task

        # Get document with access check
        document = (
            db.query(KnowledgeDocument)
            .filter(KnowledgeDocument.id == document_id)
            .first()
        )

        if not document:
            raise ValueError("Document not found")

        # TABLE documents do not support RAG indexing (real-time query instead)
        if document.source_type == DocumentSourceType.TABLE.value:
            raise ValueError("Table documents do not support indexing")

        # Check access permission via knowledge base
        knowledge_base = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=document.kind_id,
            user_id=user.id,
        )

        if not knowledge_base:
            raise ValueError("Access denied to this document")

        # Extract RAG config using shared helper
        rag_params = extract_rag_config_from_knowledge_base(db, knowledge_base, user.id)

        if not rag_params:
            raise ValueError(
                "Knowledge base has no or incomplete retrieval configuration"
            )

        # Schedule re-indexing via Celery
        index_document_task.delay(
            knowledge_base_id=str(document.kind_id),
            attachment_id=document.attachment_id,
            retriever_name=rag_params.retriever_name,
            retriever_namespace=rag_params.retriever_namespace,
            embedding_model_name=rag_params.embedding_model_name,
            embedding_model_namespace=rag_params.embedding_model_namespace,
            user_id=rag_params.kb_index_info.index_owner_user_id,
            user_name=user.user_name,
            document_id=document.id,
            splitter_config_dict=document.splitter_config,
            trigger_summary=trigger_summary,
        )

        logger.info(
            f"[Orchestrator] Scheduled reindex via Celery for document {document.id}"
        )

        return {
            "success": True,
            "document_id": document.id,
            "message": "Reindex started",
        }

    async def create_web_document(
        self,
        db: Session,
        user: User,
        url: str,
        knowledge_base_id: int,
        name: Optional[str] = None,
        trigger_indexing: bool = True,
        trigger_summary: bool = True,
    ) -> Dict[str, Any]:
        """
        Create a document from a web page by scraping the URL.

        Flow:
        1. Scrape the web page and convert to Markdown
        2. Save the content as an attachment using context_service
        3. Create a document record in the knowledge base
        4. Trigger RAG indexing via Celery

        Args:
            db: Database session
            user: Current user
            url: URL to scrape
            knowledge_base_id: Knowledge base ID to add document to
            name: Optional document name (uses page title if not provided)
            trigger_indexing: Whether to trigger RAG indexing
            trigger_summary: Whether to trigger summary generation

        Returns:
            Dict with success status and document info

        Raises:
            ValueError: If scraping fails, access denied, or creation fails
        """
        from urllib.parse import urlparse

        from app.schemas.knowledge import DocumentSourceType, KnowledgeDocumentCreate
        from app.services.context import context_service
        from app.services.web_scraper import get_web_scraper_service

        logger.info(
            f"[Orchestrator] Creating web document from URL: {url} "
            f"in knowledge base {knowledge_base_id}"
        )

        # Verify knowledge base access
        knowledge_base = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=user.id,
        )
        if not knowledge_base:
            raise ValueError("Knowledge base not found or access denied")

        # Scrape the web page (async)
        service = get_web_scraper_service()
        result = await service.scrape_url(url)

        if not result.success:
            logger.warning(
                f"[Orchestrator] Scrape failed for {url}: {result.error_code} - {result.error_message}"
            )
            return {
                "success": False,
                "document": None,
                "error_code": result.error_code,
                "error_message": result.error_message,
            }

        # Determine document name
        doc_name = name
        if not doc_name:
            doc_name = result.title or urlparse(url).netloc
        # Ensure name has .md extension for proper handling
        if not doc_name.endswith(".md"):
            doc_name = f"{doc_name}.md"

        # Create attachment using context_service (handles storage_key and binary storage)
        content_bytes = result.content.encode("utf-8")
        content_size = len(content_bytes)

        attachment, _ = context_service.upload_attachment(
            db=db,
            user_id=user.id,
            filename=doc_name,
            binary_data=content_bytes,
            subtask_id=0,  # Unlinked attachment for knowledge base
        )

        logger.info(
            f"[Orchestrator] Created attachment {attachment.id} for web document"
        )

        # Create document record
        try:
            doc_data = KnowledgeDocumentCreate(
                attachment_id=attachment.id,
                name=doc_name,
                file_extension="md",
                file_size=content_size,
                source_type=DocumentSourceType.WEB,
                source_config={
                    "url": result.url,
                    "scraped_at": result.scraped_at.isoformat(),
                    "title": result.title,
                    "description": result.description,
                },
            )

            document = KnowledgeService.create_document(
                db=db,
                knowledge_base_id=knowledge_base_id,
                user_id=user.id,
                data=doc_data,
            )

            logger.info(
                f"[Orchestrator] Created web document {document.id} in knowledge base {knowledge_base_id}"
            )

            # Trigger RAG indexing via Celery if enabled
            if trigger_indexing:
                self._schedule_indexing_celery(
                    db=db,
                    knowledge_base=knowledge_base,
                    document=document,
                    user=user,
                    trigger_summary=trigger_summary,
                )

            return {
                "success": True,
                "document": KnowledgeDocumentResponse.model_validate(document),
                "error_code": None,
                "error_message": None,
            }

        except ValueError as e:
            # Rollback attachment creation on error
            db.rollback()
            logger.error(f"[Orchestrator] Failed to create web document: {e}")
            return {
                "success": False,
                "document": None,
                "error_code": "CREATE_FAILED",
                "error_message": str(e),
            }

    async def refresh_web_document(
        self,
        db: Session,
        user: User,
        document_id: int,
        trigger_indexing: bool = True,
        trigger_summary: bool = False,
    ) -> Dict[str, Any]:
        """
        Refresh a web document by re-scraping its URL.

        Flow:
        1. Get the document and its source URL
        2. Re-scrape the web page
        3. Update the attachment content using context_service
        4. Update the document metadata
        5. Re-trigger RAG indexing via Celery

        Args:
            db: Database session
            user: Current user
            document_id: Document ID to refresh
            trigger_indexing: Whether to trigger RAG re-indexing
            trigger_summary: Whether to trigger summary generation

        Returns:
            Dict with success status and document info

        Raises:
            ValueError: If document not found, not a web document, or refresh fails
        """
        from app.models.knowledge import KnowledgeDocument
        from app.models.subtask_context import SubtaskContext
        from app.schemas.knowledge import DocumentSourceType
        from app.services.context import context_service
        from app.services.web_scraper import get_web_scraper_service

        logger.info(f"[Orchestrator] Refreshing web document {document_id}")

        # Get the document and verify it's a web document
        document = KnowledgeService.get_document(
            db=db,
            document_id=document_id,
            user_id=user.id,
        )

        if not document:
            return {
                "success": False,
                "document": None,
                "error_code": "NOT_FOUND",
                "error_message": "Document not found or access denied",
            }

        if document.source_type != DocumentSourceType.WEB.value:
            return {
                "success": False,
                "document": None,
                "error_code": "INVALID_TYPE",
                "error_message": "Only web documents can be refreshed",
            }

        # Get the source URL from source_config
        source_config = document.source_config or {}
        url = source_config.get("url")

        if not url:
            return {
                "success": False,
                "document": None,
                "error_code": "NO_URL",
                "error_message": "Document has no source URL",
            }

        # Re-scrape the web page (async)
        service = get_web_scraper_service()
        result = await service.scrape_url(url)

        if not result.success:
            logger.warning(
                f"[Orchestrator] Scrape failed for {url}: {result.error_code} - {result.error_message}"
            )
            return {
                "success": False,
                "document": None,
                "error_code": result.error_code,
                "error_message": result.error_message,
            }

        # Update or create attachment using context_service
        content_bytes = result.content.encode("utf-8")
        content_size = len(content_bytes)

        if document.attachment_id:
            # Try to overwrite existing attachment
            try:
                attachment, _ = context_service.overwrite_attachment(
                    db=db,
                    context_id=document.attachment_id,
                    user_id=user.id,
                    filename=document.name,
                    binary_data=content_bytes,
                )
                logger.info(
                    f"[Orchestrator] Updated attachment {attachment.id} for web document"
                )
            except Exception as e:
                logger.warning(
                    f"[Orchestrator] Failed to overwrite attachment {document.attachment_id}: {e}, "
                    f"creating new one"
                )
                # Create new attachment if overwrite fails
                attachment, _ = context_service.upload_attachment(
                    db=db,
                    user_id=user.id,
                    filename=document.name,
                    binary_data=content_bytes,
                    subtask_id=0,
                )
                document.attachment_id = attachment.id
                logger.info(
                    f"[Orchestrator] Created new attachment {attachment.id} for web document"
                )
        else:
            # Create new attachment if no attachment_id exists
            attachment, _ = context_service.upload_attachment(
                db=db,
                user_id=user.id,
                filename=document.name,
                binary_data=content_bytes,
                subtask_id=0,
            )
            document.attachment_id = attachment.id
            logger.info(
                f"[Orchestrator] Created new attachment {attachment.id} for web document"
            )

        # Update document metadata
        document.file_size = content_size
        document.source_config = {
            "url": result.url,
            "scraped_at": result.scraped_at.isoformat(),
            "title": result.title,
            "description": result.description,
        }
        # Reset is_active to False, will be set to True after re-indexing
        document.is_active = False

        try:
            db.commit()
            db.refresh(document)
            logger.info(f"[Orchestrator] Updated web document {document.id} metadata")

            # Trigger RAG re-indexing via Celery if enabled
            if trigger_indexing:
                knowledge_base = KnowledgeService.get_knowledge_base(
                    db=db,
                    knowledge_base_id=document.kind_id,
                    user_id=user.id,
                )
                if knowledge_base:
                    self._schedule_indexing_celery(
                        db=db,
                        knowledge_base=knowledge_base,
                        document=document,
                        user=user,
                        trigger_summary=trigger_summary,
                    )

            return {
                "success": True,
                "document": KnowledgeDocumentResponse.model_validate(document),
                "error_code": None,
                "error_message": None,
            }

        except Exception as e:
            db.rollback()
            logger.error(f"[Orchestrator] Failed to refresh web document: {e}")
            return {
                "success": False,
                "document": None,
                "error_code": "REFRESH_FAILED",
                "error_message": str(e),
            }


# Singleton instance
knowledge_orchestrator = KnowledgeOrchestrator()
