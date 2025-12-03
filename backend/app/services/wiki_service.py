# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.sql import func

from app.core.wiki_config import wiki_settings
from app.core.wiki_prompts import get_wiki_task_prompt
from app.models.wiki import (
    WikiContent,
    WikiGeneration,
    WikiGenerationStatus,
    WikiGenerationType,
    WikiProject,
)
from app.schemas.task import TaskCreate
from app.schemas.wiki import (
    WikiContentWriteRequest,
    WikiGenerationCreate,
    WikiProjectCreate,
)
from app.services.adapters.task_kinds import task_kinds_service
from app.services.adapters.team_kinds import team_kinds_service

logger = logging.getLogger(__name__)

INTERNAL_CONTENT_WRITE_TOKEN = wiki_settings.INTERNAL_API_TOKEN


class WikiService:
    """Wiki document service"""

    def _build_generation_ext(
        self,
        generation: WikiGeneration,
        base_ext: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Compose ext field for wiki generation, injecting runtime metadata.

        Args:
            generation: Current generation entity
            base_ext: Original ext provided by request

        Returns:
            Updated ext dictionary
        """
        ext = base_ext.copy() if isinstance(base_ext, dict) else {}
        content_meta = ext.get("content_write", {})

        base_url = (wiki_settings.CONTENT_WRITE_BASE_URL or "").rstrip("/")
        if not base_url:
            raise HTTPException(
                status_code=400,
                detail="Wiki content writer server address is not configured",
            )

        endpoint_path = (
            wiki_settings.CONTENT_WRITE_ENDPOINT
            or "/api/internal/wiki/generations/contents"
        )
        content_meta.update(
            {
                "content_server": base_url,
                "content_endpoint_path": endpoint_path,
                "content_endpoint_url": f"{base_url}{endpoint_path}",
                "default_section_types": wiki_settings.DEFAULT_SECTION_TYPES,
                "generation_id": generation.id,
                "auth_token": INTERNAL_CONTENT_WRITE_TOKEN,
            }
        )
        ext["content_write"] = content_meta
        return ext

    def create_wiki_generation(
        self, wiki_db: Session, obj_in: WikiGenerationCreate, user_id: int
    ) -> WikiGeneration:
        """
        Create wiki document generation task

        Process:
        1. Find or create project record
        2. Create generation record
        3. Create task
        4. Update generation record with task_id
        """
        # Import here to avoid circular imports
        from app.api.dependencies import get_db
        from app.models.user import User

        # Get main database session for user and team operations
        main_db = next(get_db())

        try:
            # 1. Find or create project record
            project = self._get_or_create_project(
                db=wiki_db,
                project_name=obj_in.project_name,
                source_url=obj_in.source_url,
                source_id=obj_in.source_id,
                source_domain=obj_in.source_domain,
                project_type=obj_in.project_type,
                source_type=obj_in.source_type,
            )

            # 2. Check if there's already a running or pending generation for this project (any user)
            existing_active_generation = (
                wiki_db.query(WikiGeneration)
                .filter(
                    WikiGeneration.project_id == project.id,
                    WikiGeneration.status.in_(
                        [WikiGenerationStatus.PENDING, WikiGenerationStatus.RUNNING]
                    ),
                )
                .first()
            )

            if existing_active_generation:
                raise HTTPException(
                    status_code=400,
                    detail=f"A wiki generation task for this project is already {existing_active_generation.status.lower()}. "
                    f"Please wait for it to complete or cancel it (generation ID: {existing_active_generation.id}) before creating a new one.",
                )

            # 3. Determine team to use
            team_id = obj_in.team_id
            if not team_id:
                # Use configured default team ID
                team_id = wiki_settings.DEFAULT_TEAM_ID

                # Verify team exists
                team = team_kinds_service.get_team_by_id(
                    db=main_db, team_id=team_id, user_id=user_id
                )
                if not team:
                    raise HTTPException(
                        status_code=404,
                        detail=f"Default wiki team (ID: {team_id}) not found. Please check WIKI_DEFAULT_TEAM_ID in your .env file",
                    )

            # 4. Create generation record
            source_snapshot_dict = obj_in.source_snapshot.model_dump()

            generation = WikiGeneration(
                project_id=project.id,
                user_id=user_id,
                team_id=team_id,
                generation_type=WikiGenerationType(obj_in.generation_type),
                source_snapshot=source_snapshot_dict,
                status=WikiGenerationStatus.PENDING,
                ext=obj_in.ext or {},
            )
            wiki_db.add(generation)
            wiki_db.flush()

            generation.ext = self._build_generation_ext(
                generation=generation,
                base_ext=obj_in.ext,
            )

            logger.info(
                f"Created wiki generation {generation.id} for project {project.id}"
            )

            # 5. Determine user ID for task creation
            # Use configured DEFAULT_USER_ID if set (non-zero), otherwise use current user
            task_user_id = (
                wiki_settings.DEFAULT_USER_ID
                if wiki_settings.DEFAULT_USER_ID > 0
                else user_id
            )

            # 6. Create task
            task_id = task_kinds_service.create_task_id(main_db, task_user_id)

            content_meta = (
                generation.ext.get("content_write", {})
                if isinstance(generation.ext, dict)
                else {}
            )
            wiki_prompt = self._generate_wiki_prompt(
                project_name=obj_in.project_name,
                generation_type=obj_in.generation_type,
                generation_id=generation.id,
                content_endpoint_url=content_meta.get("content_endpoint_url"),
                section_types=content_meta.get("default_section_types"),
                auth_token=content_meta.get("auth_token"),
                language=obj_in.language,
            )

            task_create = TaskCreate(
                title=f"Generate Wiki: {obj_in.project_name}",
                team_id=team_id,
                git_url=obj_in.source_url,
                git_repo=obj_in.project_name,
                git_repo_id=(
                    int(obj_in.source_id)
                    if obj_in.source_id and obj_in.source_id.isdigit()
                    else 0
                ),
                git_domain=obj_in.source_domain or "",
                branch_name=obj_in.source_snapshot.branch_name or "main",
                prompt=wiki_prompt,
                type="online",
                task_type="code",
                auto_delete_executor="false",
                source="wiki_generator",
            )

            # Get the user for task creation (using task_user_id)
            task_user = main_db.query(User).filter(User.id == task_user_id).first()
            if not task_user:
                raise HTTPException(
                    status_code=404,
                    detail=f"Wiki task user (ID: {task_user_id}) not found. Please check WIKI_DEFAULT_USER_ID in your .env file",
                )

            try:
                task_kinds_service.create_task_or_append(
                    db=main_db, obj_in=task_create, user=task_user, task_id=task_id
                )
            except Exception as e:
                logger.error(f"Failed to create task: {e}")
                wiki_db.rollback()
                main_db.rollback()
                raise HTTPException(
                    status_code=400, detail=f"Failed to create task: {str(e)}"
                )

            # 7. Update generation record
            generation.task_id = task_id
            generation.status = WikiGenerationStatus.RUNNING

            wiki_db.commit()
            wiki_db.refresh(generation)
            main_db.commit()

            logger.info(
                f"Wiki generation {generation.id} is now RUNNING with task {task_id}"
            )

            return generation

        finally:
            main_db.close()

    def _get_or_create_project(
        self,
        db: Session,
        project_name: str,
        source_url: str,
        source_id: Optional[str] = None,
        source_domain: Optional[str] = None,
        project_type: str = "git",
        source_type: str = "github",
    ) -> WikiProject:
        """Get or create project record"""
        # First check if it already exists
        project = (
            db.query(WikiProject).filter(WikiProject.source_url == source_url).first()
        )

        if project:
            return project

        # Create if not exists
        project = WikiProject(
            project_name=project_name,
            project_type=project_type,
            source_type=source_type,
            source_url=source_url,
            source_id=source_id,
            source_domain=source_domain,
            is_active=True,
        )
        db.add(project)
        db.flush()  # Ensure the project gets an ID
        logger.info(f"Created new wiki project {project.id}: {project_name}")

        return project

    def _generate_wiki_prompt(
        self,
        project_name: str,
        generation_type: str,
        generation_id: Optional[int] = None,
        content_endpoint_url: Optional[str] = None,
        content_server: Optional[str] = None,
        section_types: Optional[List[str]] = None,
        auth_token: Optional[str] = None,
        language: Optional[str] = None,
    ) -> str:
        """Generate wiki document preset prompt (using centralized config)"""
        endpoint = (content_endpoint_url or "").strip()
        if not endpoint:
            server = (content_server or "").rstrip("/")
            if not server:
                raise HTTPException(
                    status_code=400,
                    detail="Wiki content writer server address is not configured",
                )
            endpoint_path = (
                wiki_settings.CONTENT_WRITE_ENDPOINT
                or "/internal/wiki/generations/contents"
            )
            endpoint = f"{server}{endpoint_path}"

        return get_wiki_task_prompt(
            project_name=project_name,
            generation_type=generation_type,
            generation_id=generation_id,
            content_endpoint=endpoint,
            section_types=section_types or wiki_settings.DEFAULT_SECTION_TYPES,
            auth_token=auth_token or INTERNAL_CONTENT_WRITE_TOKEN,
            language=language or "en",
        )

    def save_generation_contents(
        self,
        wiki_db: Session,
        payload: WikiContentWriteRequest,
    ) -> None:
        """
        Persist wiki generation contents with incremental write support.

        This method is intended for internal agent usage and therefore performs:
        - Strict validation on payload schema and size
        - Incremental upsert behaviour (update existing sections, insert new ones)
        - Summary-aware status transitions and metadata bookkeeping with support for retries
        - Resilient writes regardless of current generation status so reruns can overwrite results
        """
        has_sections = bool(payload.sections)
        if not has_sections and not payload.summary:
            raise HTTPException(
                status_code=400,
                detail="No sections or summary provided",
            )

        total_payload_size = (
            sum(len(section.content.encode("utf-8")) for section in payload.sections)
            if has_sections
            else 0
        )
        if total_payload_size > wiki_settings.MAX_CONTENT_SIZE:
            raise HTTPException(
                status_code=400,
                detail="Content payload exceeds maximum allowed size",
            )

        generation = (
            wiki_db.query(WikiGeneration)
            .filter(WikiGeneration.id == payload.generation_id)
            .with_for_update()
            .first()
        )
        if not generation:
            raise HTTPException(status_code=404, detail="Generation not found")

        now = datetime.utcnow()
        created_sections = 0
        updated_sections = 0
        titles: List[str] = []
        existing_contents: List[WikiContent] = []

        if has_sections:
            titles = [section.title for section in payload.sections]
            existing_contents = (
                wiki_db.query(WikiContent)
                .filter(
                    WikiContent.generation_id == generation.id,
                    WikiContent.title.in_(titles),
                )
                .with_for_update()
                .all()
            )

            existing_by_key: Dict[Tuple[str, str], WikiContent] = {
                (content.type, content.title): content for content in existing_contents
            }
            existing_by_title: Dict[str, WikiContent] = {
                content.title: content for content in existing_contents
            }

            for section in payload.sections:
                content_item = existing_by_key.get(
                    (section.type, section.title)
                ) or existing_by_title.get(section.title)

                if content_item:
                    content_item.type = section.type
                    content_item.title = section.title
                    content_item.content = section.content
                    content_item.ext = section.ext or None
                    content_item.updated_at = now
                    updated_sections += 1
                else:
                    content_record = WikiContent(
                        generation_id=generation.id,
                        type=section.type,
                        title=section.title,
                        content=section.content,
                        ext=section.ext or None,
                        created_at=now,
                        updated_at=now,
                    )
                    wiki_db.add(content_record)
                    created_sections += 1

            try:
                wiki_db.flush()
            except Exception as exc:
                wiki_db.rollback()
                logger.error(
                    "[wiki] failed to write contents for generation %s: %s",
                    generation.id,
                    exc,
                )
                raise HTTPException(
                    status_code=400, detail="Failed to persist wiki contents"
                )

        summary = payload.summary
        previous_status = generation.status
        ext = generation.ext.copy() if isinstance(generation.ext, dict) else {}
        content_meta = dict(ext.get("content_write") or {})
        content_meta["last_write_at"] = now.isoformat()
        content_meta["last_write_titles"] = titles
        content_meta["created_sections"] = created_sections
        content_meta["updated_sections"] = updated_sections
        content_meta["status_before_write"] = (
            previous_status.value
            if isinstance(previous_status, WikiGenerationStatus)
            else (str(previous_status) if previous_status is not None else "UNKNOWN")
        )
        content_meta["total_sections"] = (
            wiki_db.query(WikiContent)
            .filter(WikiContent.generation_id == generation.id)
            .count()
        )

        if summary:
            summary_dict = summary.model_dump(exclude_none=True)
            content_meta["summary"] = summary_dict
            if summary.model:
                content_meta["model"] = summary.model
            if summary.tokens_used is not None:
                content_meta["tokens_used"] = summary.tokens_used

        ext["content_write"] = content_meta
        generation.ext = ext
        generation.updated_at = now

        if summary and summary.status:
            try:
                status_enum = WikiGenerationStatus(summary.status)
            except ValueError as exc:
                logger.error(
                    "[wiki] unsupported summary status %s for generation %s",
                    summary.status,
                    generation.id,
                )
                raise HTTPException(
                    status_code=400,
                    detail=f"Unsupported summary status: {summary.status}",
                ) from exc
            generation.status = status_enum
            if status_enum in {
                WikiGenerationStatus.COMPLETED,
                WikiGenerationStatus.FAILED,
                WikiGenerationStatus.CANCELLED,
            }:
                generation.completed_at = now
            else:
                generation.completed_at = None
            if status_enum == WikiGenerationStatus.FAILED:
                if summary.error_message:
                    content_meta["error_message"] = summary.error_message
            else:
                content_meta.pop("error_message", None)
        else:
            if generation.status != WikiGenerationStatus.RUNNING:
                generation.status = WikiGenerationStatus.RUNNING
                generation.completed_at = None
            content_meta.pop("error_message", None)

        content_meta["status_after_write"] = (
            generation.status.value
            if isinstance(generation.status, WikiGenerationStatus)
            else (
                str(generation.status) if generation.status is not None else "UNKNOWN"
            )
        )

        try:
            wiki_db.commit()
        except Exception as exc:
            wiki_db.rollback()
            logger.error(
                "[wiki] failed to commit contents for generation %s: %s",
                generation.id,
                exc,
            )
            raise HTTPException(
                status_code=400, detail="Failed to commit wiki contents"
            )

        logger.info(
            "[wiki] saved contents for generation %s (created=%s, updated=%s, titles=%s, status %s -> %s)",
            generation.id,
            created_sections,
            updated_sections,
            titles,
            content_meta.get("status_before_write"),
            content_meta.get("status_after_write"),
        )

    def get_generations(
        self,
        db: Session,
        user_id: int,
        project_id: Optional[int] = None,
        skip: int = 0,
        limit: int = 10,
    ) -> Tuple[List[WikiGeneration], int]:
        """
        Get generation records list (paginated)

        Args:
            user_id: User ID to filter by. If 0, returns all users' generations
            project_id: Optional project ID to filter by
            skip: Number of records to skip
            limit: Maximum number of records to return
        """
        query = db.query(WikiGeneration)

        # Only filter by user_id when it's not 0 (0 means query all users)
        if user_id != 0:
            query = query.filter(WikiGeneration.user_id == user_id)

        if project_id:
            query = query.filter(WikiGeneration.project_id == project_id)

        total = query.count()
        generations = (
            query.order_by(WikiGeneration.created_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )

        return generations, total

    def get_generation_detail(
        self, db: Session, generation_id: int, user_id: int
    ) -> WikiGeneration:
        """
        Get generation record detail

        Args:
            user_id: User ID to filter by. If 0, returns generation for all users
        """
        query = db.query(WikiGeneration).filter(WikiGeneration.id == generation_id)

        # Only filter by user_id when it's not 0 (0 means query all users)
        if user_id != 0:
            query = query.filter(WikiGeneration.user_id == user_id)

        generation = query.first()

        if not generation:
            raise HTTPException(status_code=404, detail="Generation not found")

        return generation

    def get_generation_contents(
        self, db: Session, generation_id: int, user_id: int
    ) -> List[WikiContent]:
        """
        Get all contents of a wiki generation

        Args:
            user_id: User ID to filter by. If 0, returns contents for all users
        """
        # First verify the generation exists (and belongs to user if user_id != 0)
        generation = self.get_generation_detail(db, generation_id, user_id)

        contents = (
            db.query(WikiContent)
            .filter(WikiContent.generation_id == generation_id)
            .order_by(WikiContent.created_at)
            .all()
        )

        return contents

    def get_projects(
        self,
        db: Session,
        skip: int = 0,
        limit: int = 10,
        project_type: Optional[str] = None,
        source_type: Optional[str] = None,
    ) -> Tuple[List[WikiProject], int]:
        """Get project list (paginated)"""
        query = db.query(WikiProject).filter(WikiProject.is_active == True)

        if project_type:
            query = query.filter(WikiProject.project_type == project_type)

        if source_type:
            query = query.filter(WikiProject.source_type == source_type)

        total = query.count()
        projects = (
            query.order_by(WikiProject.created_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )

        return projects, total

    def get_project_detail(self, db: Session, project_id: int) -> WikiProject:
        """Get project detail"""
        project = (
            db.query(WikiProject)
            .filter(WikiProject.id == project_id, WikiProject.is_active == True)
            .first()
        )

        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        return project

    def cancel_wiki_generation(
        self, wiki_db: Session, generation_id: int, user_id: int
    ) -> WikiGeneration:
        """
        Cancel a wiki generation task

        Process:
        1. Verify generation belongs to user
        2. Check if generation can be cancelled (PENDING or RUNNING status)
        3. Stop related task execution first
        4. Update generation status to CANCELLED
        """
        # Import here to avoid circular imports
        from app.api.dependencies import get_db
        from app.services.adapters.task_kinds import task_kinds_service

        # Get main database session for task operations
        main_db = next(get_db())

        try:
            # 1. Get generation and verify ownership
            generation = (
                wiki_db.query(WikiGeneration)
                .filter(
                    WikiGeneration.id == generation_id,
                    WikiGeneration.user_id == user_id,
                )
                .first()
            )

            if not generation:
                raise HTTPException(status_code=404, detail="Generation not found")

            # 2. Check if generation can be cancelled
            if generation.status not in [
                WikiGenerationStatus.PENDING,
                WikiGenerationStatus.RUNNING,
            ]:
                raise HTTPException(
                    status_code=400,
                    detail=f"Cannot cancel generation with status {generation.status}. Only PENDING or RUNNING generations can be cancelled.",
                )

            # 3. Stop related task execution first (before updating generation status)
            if generation.task_id:
                try:
                    # Delete the task to stop execution
                    task_kinds_service.delete_task(
                        db=main_db, task_id=generation.task_id, user_id=user_id
                    )
                    logger.info(
                        f"Stopped task {generation.task_id} for generation {generation_id}"
                    )
                except HTTPException as e:
                    # If task not found (404), it's already deleted, continue with cancellation
                    if e.status_code == 404:
                        logger.warning(
                            f"Task {generation.task_id} not found, already deleted. Continuing with cancellation."
                        )
                    else:
                        # For other HTTP errors, raise the error
                        logger.error(
                            f"Failed to stop task {generation.task_id}: {str(e)}"
                        )
                        raise
                except Exception as e:
                    # For unexpected errors, log warning but continue with cancellation
                    logger.warning(
                        f"Error stopping task {generation.task_id}: {str(e)}. Continuing with cancellation."
                    )

            # 4. Update generation status to CANCELLED (only after task is stopped)
            generation.status = WikiGenerationStatus.CANCELLED
            generation.completed_at = func.now()

            wiki_db.commit()
            wiki_db.refresh(generation)
            main_db.commit()

            logger.info(f"Cancelled wiki generation {generation_id}")

            return generation

        except HTTPException:
            wiki_db.rollback()
            main_db.rollback()
            raise
        except Exception as e:
            wiki_db.rollback()
            main_db.rollback()
            logger.error(f"Failed to cancel generation {generation_id}: {e}")
            raise HTTPException(
                status_code=500, detail=f"Failed to cancel generation: {str(e)}"
            )
        finally:
            main_db.close()


wiki_service = WikiService()
