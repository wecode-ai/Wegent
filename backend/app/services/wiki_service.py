# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.sql import func

from app.core.cache import cache_manager
from app.core.wiki_config import wiki_settings
from app.core.wiki_prompts import get_wiki_task_prompt
from app.models.user import User
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
from app.services.user import user_service

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
        self,
        wiki_db: Session,
        obj_in: WikiGenerationCreate,
        user_id: int,
        current_user: Optional[User] = None,
    ) -> WikiGeneration:
        """
        Create wiki document generation task (system-level)

        Process:
        1. Verify current user has access to the repository
        2. Find or create project record
        3. Create generation record
        4. Create task using system-level configuration (team and model from backend config)
        5. Update generation record with task_id

        Note: Wiki generation is system-level, team and model are configured in backend,
        not selected by frontend users.

        The generation record's user_id is set to the system-bound user (WIKI_DEFAULT_USER_ID)
        when configured, so that all wiki generations are owned by the system user.
        This allows centralized management of wiki content.

        Args:
            wiki_db: Wiki database session
            obj_in: Wiki generation creation request
            user_id: User ID (may be overridden by admin)
            current_user: Current user object for repository access verification
        """
        # Import here to avoid circular imports
        from app.api.dependencies import get_db
        from app.models.user import User

        # Get main database session for user and team operations
        main_db = next(get_db())

        try:
            # 1. Verify current user has access to the repository (for GitLab/GitHub projects)
            # This ensures users can only create wiki generations for repositories they have access to
            if current_user and obj_in.source_type in ("gitlab", "github"):
                access_result = self._check_task_user_repo_access(
                    task_user=current_user,
                    source_type=obj_in.source_type,
                    source_url=obj_in.source_url,
                    source_id=obj_in.source_id,
                    source_domain=obj_in.source_domain,
                    project_name=obj_in.project_name,
                )
                if not access_result.get("has_access", False):
                    platform_name = (
                        "GitLab" if obj_in.source_type == "gitlab" else "GitHub"
                    )
                    error_msg = access_result.get("error", "No access")
                    raise HTTPException(
                        status_code=403,
                        detail=f"You do not have access to repository '{obj_in.project_name}' on {platform_name}. {error_msg}",
                    )
                logger.info(
                    f"User {current_user.id} has {access_result.get('access_level_name')} access to repository {obj_in.project_name}"
                )

            # 2. Find or create project record
            project = self._get_or_create_project(
                db=wiki_db,
                project_name=obj_in.project_name,
                source_url=obj_in.source_url,
                source_id=obj_in.source_id,
                source_domain=obj_in.source_domain,
                project_type=obj_in.project_type,
                source_type=obj_in.source_type,
            )

            # 3. Check if there's already a running or pending generation for this project (any user)
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

            # 4. Determine user ID for both generation record and task creation (system-level)
            # Use configured DEFAULT_USER_ID if set (non-zero), otherwise use current user
            # This ensures wiki generations are owned by the system-bound user
            system_user_id = (
                wiki_settings.DEFAULT_USER_ID
                if wiki_settings.DEFAULT_USER_ID > 0
                else user_id
            )
            task_user_id = system_user_id

            # 5. Determine team to use (always from backend configuration, ignore frontend input)
            # Use configured default team name to find team
            default_team_name = wiki_settings.DEFAULT_TEAM_NAME
            if not default_team_name:
                raise HTTPException(
                    status_code=400,
                    detail="WIKI_DEFAULT_TEAM_NAME is not configured. Please set it in your .env file",
                )

            # Find team by name and namespace
            team = team_kinds_service.get_team_by_name_and_namespace(
                db=main_db,
                team_name=default_team_name,
                team_namespace="default",
                user_id=task_user_id,
            )
            if not team:
                raise HTTPException(
                    status_code=404,
                    detail=f"Default wiki team '{default_team_name}' not found. Please check WIKI_DEFAULT_TEAM_NAME in your .env file",
                )
            team_id = team.id

            # 5.1 Check if task_user has access to the repository (for GitLab/GitHub projects)
            if obj_in.source_type in ("gitlab", "github") and task_user_id != user_id:
                task_user = user_service.get_user_by_id(main_db, task_user_id)

                if task_user:
                    access_result = self._check_task_user_repo_access(
                        task_user=task_user,
                        source_type=obj_in.source_type,
                        source_url=obj_in.source_url,
                        source_id=obj_in.source_id,
                        source_domain=obj_in.source_domain,
                        project_name=obj_in.project_name,
                    )
                    if not access_result.get("has_access", False):
                        # Get the Git username that needs to be added to the repository
                        git_username = access_result.get("username", "")
                        platform_name = (
                            "GitLab" if obj_in.source_type == "gitlab" else "GitHub"
                        )

                        # Build detailed error message
                        if git_username:
                            error_detail = (
                                f"Wiki task user does not have access to repository '{obj_in.project_name}'. "
                                f"Please add {platform_name} user '{git_username}' to the repository with at least Reporter/Read access level. "
                                f"Alternatively, set WIKI_DEFAULT_USER_ID=0 in your .env file to use the current user's credentials instead."
                            )
                        else:
                            error_detail = (
                                f"Wiki task user (ID: {task_user_id}) does not have access to repository '{obj_in.project_name}'. "
                                f"The task user may not have {platform_name} credentials configured. "
                                f"Please configure {platform_name} token for this user, or set WIKI_DEFAULT_USER_ID=0 to use the current user's credentials."
                            )

                        raise HTTPException(status_code=403, detail=error_detail)
                    logger.info(
                        f"Task user {task_user_id} has {access_result.get('access_level_name')} access to repository {obj_in.project_name}"
                    )

            # 6. Create generation record
            # Use system_user_id for generation ownership (not current user)
            source_snapshot_dict = obj_in.source_snapshot.model_dump()

            # Default completed_at for pending/running generations (epoch time)
            default_completed_at = datetime(1970, 1, 1, 0, 0, 0)

            generation = WikiGeneration(
                project_id=project.id,
                user_id=system_user_id,  # Use system-bound user ID for generation ownership
                task_id=0,  # Initialize with 0, will be updated after task creation
                team_id=team_id,
                generation_type=WikiGenerationType(obj_in.generation_type),
                source_snapshot=source_snapshot_dict,
                status=WikiGenerationStatus.PENDING,
                ext=obj_in.ext or {},
                completed_at=default_completed_at,  # Use epoch time as default for NOT NULL constraint
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

            # 7. Create task
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
                section_types=content_meta.get("default_section_types"),
                language=obj_in.language,
            )
            # Store wiki environment variables in generation ext for executor to use
            wiki_env = {
                "WIKI_ENDPOINT": content_meta.get("content_endpoint_url", ""),
                "WIKI_TOKEN": content_meta.get("auth_token", ""),
                "WIKI_GENERATION_ID": str(generation.id),
            }
            generation.ext["wiki_env"] = wiki_env

            # Note: model_id is not passed - wiki uses the team's bound model
            # The team's bot should have a model configured (bind_model or custom config)
            # Always use empty branch_name to clone the repository's default branch
            # This ensures wiki generation always uses the latest default branch
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
                branch_name="",  # Always use default branch
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

            # 8. Update generation record
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

    def _check_task_user_repo_access(
        self,
        task_user,
        source_type: str,
        source_url: str,
        source_id: Optional[str],
        source_domain: Optional[str],
        project_name: str,
    ) -> Dict[str, Any]:
        """
        Check if task_user has access to the specified repository.

        Args:
            task_user: User object for the task execution user
            source_type: Repository source type ('gitlab' or 'github')
            source_url: Repository source URL
            source_id: Repository ID (from source platform)
            source_domain: Git domain (e.g., gitlab.com, github.com)
            project_name: Repository name (e.g., "owner/repo")

        Returns:
            Dictionary with access check results:
            - has_access: bool
            - access_level: int
            - access_level_name: str
            - username: str
        """
        # If task_user has no git_info configured, they can't have access
        if not task_user.git_info:
            return {
                "has_access": False,
                "access_level": 0,
                "access_level_name": "No Access",
                "username": task_user.user_name,
                "error": "Git information not configured for task user",
            }

        # Find token for the task_user matching the source_type and source_domain
        git_token = None
        for git_info in task_user.git_info:
            if git_info.get("type") == source_type:
                if source_domain and git_info.get("git_domain") == source_domain:
                    git_token = git_info.get("git_token")
                    break
                elif not git_token:
                    # Fallback to first matching type token if no domain match
                    git_token = git_info.get("git_token")

        if not git_token:
            platform_name = "GitLab" if source_type == "gitlab" else "GitHub"
            return {
                "has_access": False,
                "access_level": 0,
                "access_level_name": "No Access",
                "username": task_user.user_name,
                "error": f"No {platform_name} token configured for task user for domain {source_domain}",
            }

        # Determine project identifier
        # For GitLab: use source_id (numeric project ID) or project path
        # For GitHub: use project_name (owner/repo format)
        project_identifier = source_id if source_id else project_name

        if not project_identifier:
            # Try to extract project path from source_url
            # URL format: https://gitlab.com/namespace/project.git or https://github.com/owner/repo.git
            try:
                import re

                match = re.search(r"(?:https?://[^/]+/)?(.+?)(?:\.git)?$", source_url)
                if match:
                    project_identifier = match.group(1)
            except Exception as e:
                logger.warning(f"Failed to extract project ID from URL: {e}")
                return {
                    "has_access": False,
                    "access_level": 0,
                    "access_level_name": "No Access",
                    "username": task_user.user_name,
                    "error": f"Could not determine project ID from URL: {source_url}",
                }

        if not project_identifier:
            return {
                "has_access": False,
                "access_level": 0,
                "access_level_name": "No Access",
                "username": task_user.user_name,
                "error": "Project identifier is required for access check",
            }

        try:
            if source_type == "gitlab":
                from app.repository.gitlab_provider import GitLabProvider

                provider = GitLabProvider()
                result = provider.check_user_project_access(
                    token=git_token,
                    git_domain=source_domain or "",
                    project_id=project_identifier,
                )
            elif source_type == "github":
                from app.repository.github_provider import GitHubProvider

                provider = GitHubProvider()
                result = provider.check_user_project_access(
                    token=git_token,
                    git_domain=source_domain or "",
                    repo_name=project_name,
                )
            elif source_type == "gitea":
                from app.repository.gitea_provider import GiteaProvider

                provider = GiteaProvider()
                result = provider.check_user_project_access(
                    token=git_token,
                    git_domain=source_domain or "",
                    repo_name=project_name,
                )
            else:
                return {
                    "has_access": True,  # Skip check for unsupported source types
                    "access_level": 0,
                    "access_level_name": "Unknown",
                    "username": task_user.user_name,
                    "error": f"Access check not supported for source type: {source_type}",
                }
            return result
        except Exception as e:
            logger.error(f"Failed to check repository access: {e}")
            return {
                "has_access": False,
                "access_level": 0,
                "access_level_name": "No Access",
                "username": task_user.user_name,
                "error": str(e),
            }

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
            description="",  # Default to empty string as description is NOT NULL
            ext={},  # Default to empty dict as ext is NOT NULL
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
        section_types: Optional[List[str]] = None,
        language: Optional[str] = None,
    ) -> str:
        """Generate wiki document preset prompt (using centralized config)"""
        return get_wiki_task_prompt(
            project_name=project_name,
            generation_type=generation_type,
            generation_id=generation_id,
            section_types=section_types or wiki_settings.DEFAULT_SECTION_TYPES,
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
                        parent_id=(
                            section.parent_id if section.parent_id is not None else 0
                        ),
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
            # For non-terminal statuses, keep the default epoch time (NOT NULL constraint)
            if status_enum == WikiGenerationStatus.FAILED:
                if summary.error_message:
                    content_meta["error_message"] = summary.error_message
            else:
                content_meta.pop("error_message", None)
        else:
            if generation.status != WikiGenerationStatus.RUNNING:
                generation.status = WikiGenerationStatus.RUNNING
                # Keep the default epoch time for completed_at (NOT NULL constraint)
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
        user: Optional[User] = None,
        skip: int = 0,
        limit: int = 10,
        project_type: Optional[str] = None,
        source_type: Optional[str] = None,
    ) -> Tuple[List[WikiProject], int]:
        """
        Get project list (paginated) with user access filtering.

        Args:
            db: Database session
            user: Current user for access filtering. If None, returns all projects (admin mode)
            skip: Number of records to skip
            limit: Maximum number of records to return
            project_type: Optional project type filter
            source_type: Optional source type filter

        Returns:
            Tuple of (filtered projects list, total count)
        """
        query = db.query(WikiProject).filter(WikiProject.is_active == True)

        if project_type:
            query = query.filter(WikiProject.project_type == project_type)

        if source_type:
            query = query.filter(WikiProject.source_type == source_type)

        # Get all projects first, then filter by user access
        all_projects = query.order_by(WikiProject.created_at.desc()).all()

        # If no user provided (admin mode), return all projects
        if user is None:
            total = len(all_projects)
            paginated_projects = all_projects[skip : skip + limit]
            return paginated_projects, total

        # Filter projects by user's repository access
        accessible_projects = self._filter_projects_by_user_access(all_projects, user)

        total = len(accessible_projects)
        paginated_projects = accessible_projects[skip : skip + limit]

        return paginated_projects, total

    def _filter_projects_by_user_access(
        self, projects: List[WikiProject], user: User
    ) -> List[WikiProject]:
        """
        Filter projects based on user's repository access permissions.

        Uses cached repository list from Redis for fast batch permission checking.
        First builds a lookup set from all cached repos, then batch matches all projects.
        Falls back to API calls only for projects where cache is not available.

        Args:
            projects: List of WikiProject objects to filter
            user: User object with git_info containing tokens

        Returns:
            List of projects the user has read access to
        """
        if not user.git_info:
            # User has no git info configured, return empty list
            logger.warning(
                f"User {user.id} has no git_info configured, returning empty project list"
            )
            return []

        # Build a map of user's git tokens by source_type and domain
        user_tokens: Dict[str, Dict[str, str]] = {}

        # Build lookup sets for fast batch matching from cached repos
        # Key: (source_type, domain) -> set of (repo_id, full_name_lower)
        cached_repo_ids: Dict[Tuple[str, str], set] = {}
        cached_repo_names: Dict[Tuple[str, str], set] = {}
        has_cache_for_domain: Dict[Tuple[str, str], bool] = {}

        for git_info in user.git_info:
            git_type = git_info.get("type", "")
            git_domain = git_info.get("git_domain", "")
            git_token = git_info.get("git_token", "")
            if git_type and git_token:
                if git_type not in user_tokens:
                    user_tokens[git_type] = {}
                user_tokens[git_type][git_domain] = git_token

                # Try to get cached repositories for this domain
                cache_key = (git_type, git_domain)
                cached_repos = cache_manager.get_user_repositories_sync(
                    user.id, git_domain
                )

                if cached_repos:
                    has_cache_for_domain[cache_key] = True
                    # Build lookup sets for batch matching
                    repo_ids = set()
                    repo_names = set()
                    for repo in cached_repos:
                        repo_id = str(repo.get("id", ""))
                        repo_full_name = repo.get("full_name", "").lower()
                        if repo_id:
                            repo_ids.add(repo_id)
                        if repo_full_name:
                            repo_names.add(repo_full_name)

                    cached_repo_ids[cache_key] = repo_ids
                    cached_repo_names[cache_key] = repo_names

                    logger.debug(
                        f"Built lookup sets for user {user.id}, domain {git_domain}: "
                        f"{len(repo_ids)} repo IDs, {len(repo_names)} repo names"
                    )
                else:
                    has_cache_for_domain[cache_key] = False

        # Batch filter projects using lookup sets
        accessible_projects = []
        projects_needing_api_check = []

        for project in projects:
            source_type = project.source_type
            source_domain = project.source_domain or ""
            source_id = project.source_id
            project_name = project.project_name

            # Check if user has token for this source type
            if source_type not in user_tokens:
                logger.debug(
                    f"User has no token for source_type '{source_type}', skipping project {project.id}"
                )
                continue

            # Find the best matching cache key
            cache_key = (source_type, source_domain)

            # If no exact domain match, try to find any cache for this source type
            if cache_key not in has_cache_for_domain:
                # Look for any cached domain for this source type
                for (
                    cached_type,
                    cached_domain,
                ), has_cache in has_cache_for_domain.items():
                    if cached_type == source_type and has_cache:
                        cache_key = (cached_type, cached_domain)
                        break

            # Check if we have cache for this domain
            if has_cache_for_domain.get(cache_key, False):
                # Fast batch lookup using sets
                repo_ids = cached_repo_ids.get(cache_key, set())
                repo_names = cached_repo_names.get(cache_key, set())

                # Match by source_id (numeric project ID)
                if source_id and source_id in repo_ids:
                    logger.debug(
                        f"User has access to project {project.id} (matched by source_id from cache)"
                    )
                    accessible_projects.append(project)
                    continue

                # Match by project_name (full path like "namespace/project")
                if project_name and project_name.lower() in repo_names:
                    logger.debug(
                        f"User has access to project {project.id} (matched by project_name from cache)"
                    )
                    accessible_projects.append(project)
                    continue

                # Project not found in cached repos, user doesn't have access
                logger.debug(
                    f"Project {project.id} ({project_name}) not found in user's cached repos, denying access"
                )
            else:
                # No cache available for this domain, need API check
                projects_needing_api_check.append(project)

        # Fallback: Check projects without cache via API (batch if possible)
        if projects_needing_api_check:
            logger.info(
                f"Checking {len(projects_needing_api_check)} projects via API (no cache available)"
            )
            for project in projects_needing_api_check:
                if self._check_user_project_access_via_api(project, user_tokens):
                    accessible_projects.append(project)

        logger.info(
            f"User {user.id} has access to {len(accessible_projects)}/{len(projects)} wiki projects"
        )
        return accessible_projects

    def _check_user_project_access_via_api(
        self, project: WikiProject, user_tokens: Dict[str, Dict[str, str]]
    ) -> bool:
        """
        Check if user has access to a specific wiki project's repository via API call.

        This is the fallback method when cached repository list is not available.

        Args:
            project: WikiProject object
            user_tokens: Dict mapping source_type -> {domain -> token}

        Returns:
            True if user has read access, False otherwise
        """
        source_type = project.source_type
        source_domain = project.source_domain or ""
        source_id = project.source_id
        project_name = project.project_name

        # Find matching token for the domain
        domain_tokens = user_tokens.get(source_type, {})
        git_token = None

        # Try exact domain match first
        if source_domain and source_domain in domain_tokens:
            git_token = domain_tokens[source_domain]
        else:
            # Fallback to first available token for this source type
            if domain_tokens:
                git_token = next(iter(domain_tokens.values()))

        if not git_token:
            logger.debug(
                f"No matching token found for project {project.id} (source_type={source_type}, domain={source_domain})"
            )
            return False

        try:
            if source_type == "gitlab":
                from app.repository.gitlab_provider import GitLabProvider

                provider = GitLabProvider()
                # Use source_id if available, otherwise use project_name
                project_identifier = source_id if source_id else project_name
                result = provider.check_user_project_access(
                    token=git_token,
                    git_domain=source_domain,
                    project_id=project_identifier,
                )
            elif source_type == "github":
                from app.repository.github_provider import GitHubProvider

                provider = GitHubProvider()
                result = provider.check_user_project_access(
                    token=git_token,
                    git_domain=source_domain,
                    repo_name=project_name,
                )
            else:
                # For unsupported source types, allow access by default
                logger.debug(
                    f"Unsupported source_type '{source_type}' for project {project.id}, allowing access"
                )
                return True

            has_access = result.get("has_access", False)
            if has_access:
                logger.debug(
                    f"User has {result.get('access_level_name', 'Unknown')} access to project {project.id}"
                )
            else:
                logger.debug(
                    f"User has no access to project {project.id}: {result.get('error', 'No access')}"
                )
            return has_access

        except Exception as e:
            # On error, deny access for security
            logger.warning(
                f"Error checking access for project {project.id}: {str(e)}, denying access"
            )
            return False

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
