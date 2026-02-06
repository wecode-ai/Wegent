# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Git Skill Import Service.

This module provides the main service class for scanning and importing
skills from Git repositories.
"""

import os
import tempfile
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.services.git_skill.models import (
    GitBatchUpdateResult,
    GitImportResult,
    GitSkillInfo,
)
from app.services.git_skill.utils import (
    download_repo_zip,
    extract_zip_safely,
    find_repo_root,
    get_auth_for_repo,
    package_skill_directory,
    parse_repo_url,
    scan_skills_in_directory,
    validate_skill_directory,
)


class GitSkillService:
    """Service for scanning and importing skills from Git repositories."""

    def scan_repository(
        self, repo_url: str, user_id: int = None, db: Session = None
    ) -> List[GitSkillInfo]:
        """
        Scan a Git repository for skills.

        Args:
            repo_url: Git repository URL
            user_id: User ID for authentication (optional)
            db: Database session (optional, required if user_id is provided)

        Returns:
            List of skills found in the repository
        """
        # Get authentication info
        if user_id and db:
            provider, owner, repo, auth_info = get_auth_for_repo(repo_url, user_id, db)
        else:
            parsed = parse_repo_url(repo_url)
            provider = parsed.provider
            owner = parsed.owner
            repo = parsed.repo
            auth_info = parsed.auth_info

        # Download repository ZIP with auth
        zip_content = download_repo_zip(provider, owner, repo, auth_info)

        # Extract to temporary directory and scan
        with tempfile.TemporaryDirectory() as temp_dir:
            extract_zip_safely(zip_content, temp_dir)

            # Scan for skills
            skills = scan_skills_in_directory(temp_dir)

        return skills

    def import_skills(
        self,
        repo_url: str,
        skill_paths: List[str],
        namespace: str,
        user_id: int,
        overwrite_names: Optional[List[str]] = None,
        db: Session = None,
    ) -> GitImportResult:
        """
        Import selected skills from a Git repository.

        Args:
            repo_url: Git repository URL
            skill_paths: List of skill paths to import
            namespace: Namespace for the skills
            user_id: User ID for the skills
            overwrite_names: List of skill names that can be overwritten
            db: Database session

        Returns:
            GitImportResult with success, skipped, and failed lists
        """
        from app.services.adapters.skill_kinds import skill_kinds_service

        if overwrite_names is None:
            overwrite_names = []

        # Get authentication info
        provider, owner, repo, auth_info = get_auth_for_repo(repo_url, user_id, db)

        # Download repository ZIP with auth
        zip_content = download_repo_zip(provider, owner, repo, auth_info)

        result = GitImportResult()

        # Build source info for git-imported skills
        source_info = {
            "type": "git",
            "repo_url": repo_url,
            "imported_at": datetime.utcnow().isoformat() + "Z",
        }

        # Extract to temporary directory
        with tempfile.TemporaryDirectory() as temp_dir:
            extract_zip_safely(zip_content, temp_dir)
            repo_root = find_repo_root(temp_dir)

            # Process each skill path
            for skill_path in skill_paths:
                self._process_skill_import(
                    repo_root=repo_root,
                    skill_path=skill_path,
                    namespace=namespace,
                    user_id=user_id,
                    overwrite_names=overwrite_names,
                    source_info=source_info,
                    result=result,
                    db=db,
                )

        return result

    def _process_skill_import(
        self,
        repo_root: str,
        skill_path: str,
        namespace: str,
        user_id: int,
        overwrite_names: List[str],
        source_info: Dict[str, Any],
        result: GitImportResult,
        db: Session,
    ) -> None:
        """
        Process a single skill import.

        Args:
            repo_root: Path to the repository root
            skill_path: Path to the skill within the repository
            namespace: Namespace for the skill
            user_id: User ID for the skill
            overwrite_names: List of skill names that can be overwritten
            source_info: Source information for the skill
            result: GitImportResult to update
            db: Database session
        """
        from app.services.adapters.skill_kinds import skill_kinds_service

        skill_dir = os.path.join(repo_root, skill_path)
        skill_name = os.path.basename(skill_path)

        if not os.path.isdir(skill_dir):
            result.failed.append(
                {
                    "name": skill_name,
                    "path": skill_path,
                    "error": f"Skill directory not found: {skill_path}",
                }
            )
            return

        skill_md_path = os.path.join(skill_dir, "SKILL.md")
        if not os.path.isfile(skill_md_path):
            result.failed.append(
                {
                    "name": skill_name,
                    "path": skill_path,
                    "error": "SKILL.md not found in skill directory",
                }
            )
            return

        try:
            # Check if skill already exists
            existing_skill = skill_kinds_service.get_skill_by_name(
                db=db, name=skill_name, namespace=namespace, user_id=user_id
            )

            if existing_skill and skill_name not in overwrite_names:
                result.skipped.append(
                    {
                        "name": skill_name,
                        "path": skill_path,
                        "reason": "Skill already exists",
                    }
                )
                return

            # Package skill directory into ZIP
            skill_zip = package_skill_directory(skill_dir, skill_name)
            file_name = f"{skill_name}.zip"

            # Add skill_path to source info for this specific skill
            skill_source_info = {**source_info, "skill_path": skill_path}

            if existing_skill and skill_name in overwrite_names:
                # Update existing skill
                skill_id = int(existing_skill.metadata.labels.get("id", 0))
                updated_skill = skill_kinds_service.update_skill(
                    db=db,
                    skill_id=skill_id,
                    user_id=user_id,
                    file_content=skill_zip,
                    file_name=file_name,
                    source=skill_source_info,
                )
                result.success.append(
                    {
                        "name": skill_name,
                        "path": skill_path,
                        "id": int(updated_skill.metadata.labels.get("id", 0)),
                        "action": "updated",
                    }
                )
            else:
                # Create new skill
                new_skill = skill_kinds_service.create_skill(
                    db=db,
                    name=skill_name,
                    namespace=namespace,
                    file_content=skill_zip,
                    file_name=file_name,
                    user_id=user_id,
                    source=skill_source_info,
                )
                result.success.append(
                    {
                        "name": skill_name,
                        "path": skill_path,
                        "id": int(new_skill.metadata.labels.get("id", 0)),
                        "action": "created",
                    }
                )

        except HTTPException as e:
            result.failed.append(
                {
                    "name": skill_name,
                    "path": skill_path,
                    "error": e.detail,
                }
            )
        except Exception as e:
            result.failed.append(
                {
                    "name": skill_name,
                    "path": skill_path,
                    "error": str(e),
                }
            )

    def update_skill_from_git(
        self,
        skill_id: int,
        user_id: int,
        db: Session = None,
    ) -> Dict[str, Any]:
        """
        Update a skill from its original Git repository source.

        Args:
            skill_id: Skill ID to update
            user_id: User ID
            db: Database session

        Returns:
            Dict with updated skill info

        Raises:
            HTTPException: If skill not found, not from git, or update fails
        """
        from app.models.kind import Kind
        from app.services.adapters.skill_kinds import skill_kinds_service

        # Get the skill
        skill_kind = (
            db.query(Kind)
            .filter(
                Kind.id == skill_id,
                Kind.user_id == user_id,
                Kind.kind == "Skill",
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )

        if not skill_kind:
            raise HTTPException(status_code=404, detail="Skill not found")

        # Check if skill has git source
        source = skill_kind.json.get("spec", {}).get("source")
        if not source or source.get("type") != "git":
            raise HTTPException(
                status_code=400,
                detail="Skill was not imported from Git repository",
            )

        repo_url = source.get("repo_url")
        skill_path = source.get("skill_path")

        if not repo_url or not skill_path:
            raise HTTPException(
                status_code=400,
                detail="Skill source information is incomplete",
            )

        # Get authentication info
        provider, owner, repo, auth_info = get_auth_for_repo(repo_url, user_id, db)

        # Download repository ZIP with auth
        zip_content = download_repo_zip(provider, owner, repo, auth_info)

        # Extract to temporary directory
        with tempfile.TemporaryDirectory() as temp_dir:
            extract_zip_safely(zip_content, temp_dir)
            repo_root = find_repo_root(temp_dir)

            # Find the skill directory
            skill_dir = os.path.join(repo_root, skill_path)
            skill_name = os.path.basename(skill_path)

            validate_skill_directory(skill_dir, skill_path)

            # Package skill directory into ZIP
            skill_zip = package_skill_directory(skill_dir, skill_name)
            file_name = f"{skill_name}.zip"

            # Update source info with new timestamp
            source_info = {
                "type": "git",
                "repo_url": repo_url,
                "skill_path": skill_path,
                "imported_at": datetime.utcnow().isoformat() + "Z",
            }

            # Update the skill
            updated_skill = skill_kinds_service.update_skill(
                db=db,
                skill_id=skill_id,
                user_id=user_id,
                file_content=skill_zip,
                file_name=file_name,
                source=source_info,
            )

            return {
                "id": int(updated_skill.metadata.labels.get("id", 0)),
                "name": updated_skill.metadata.name,
                "version": updated_skill.spec.version,
                "source": source_info,
            }

    def batch_update_skills_from_git(
        self,
        skill_ids: List[int],
        user_id: int,
        db: Session = None,
    ) -> GitBatchUpdateResult:
        """
        Batch update multiple skills from their original Git repository sources.

        This method optimizes the update process by:
        1. Grouping skills by their source repository
        2. Downloading each repository only once
        3. Updating all skills from the same repository in a single pass

        Args:
            skill_ids: List of skill IDs to update
            user_id: User ID
            db: Database session

        Returns:
            GitBatchUpdateResult with success, skipped, and failed lists
        """
        from app.models.kind import Kind

        result = GitBatchUpdateResult()

        if not skill_ids:
            return result

        # Step 1: Fetch all skills and group by repo_url
        repo_skills_map = self._group_skills_by_repo(skill_ids, user_id, db, result)

        # Step 2: Process each repository once
        for repo_url, skills_info in repo_skills_map.items():
            self._process_repo_batch_update(
                repo_url=repo_url,
                skills_info=skills_info,
                user_id=user_id,
                result=result,
                db=db,
            )

        return result

    def _group_skills_by_repo(
        self,
        skill_ids: List[int],
        user_id: int,
        db: Session,
        result: GitBatchUpdateResult,
    ) -> Dict[str, List[Tuple[Any, str]]]:
        """
        Group skills by their source repository URL.

        Args:
            skill_ids: List of skill IDs
            user_id: User ID
            db: Database session
            result: GitBatchUpdateResult to update with skipped skills

        Returns:
            Dictionary mapping repo_url to list of (skill_kind, skill_path) tuples
        """
        from app.models.kind import Kind

        repo_skills_map: Dict[str, List[Tuple[Kind, str]]] = {}

        for skill_id in skill_ids:
            skill_kind = (
                db.query(Kind)
                .filter(
                    Kind.id == skill_id,
                    Kind.user_id == user_id,
                    Kind.kind == "Skill",
                    Kind.is_active == True,  # noqa: E712
                )
                .first()
            )

            if not skill_kind:
                result.skipped.append(
                    {
                        "id": skill_id,
                        "name": None,
                        "reason": "Skill not found",
                    }
                )
                continue

            # Check if skill has git source
            source = skill_kind.json.get("spec", {}).get("source")
            if not source or source.get("type") != "git":
                result.skipped.append(
                    {
                        "id": skill_id,
                        "name": skill_kind.name,
                        "reason": "Skill was not imported from Git repository",
                    }
                )
                continue

            repo_url = source.get("repo_url")
            skill_path = source.get("skill_path")

            if not repo_url or not skill_path:
                result.skipped.append(
                    {
                        "id": skill_id,
                        "name": skill_kind.name,
                        "reason": "Skill source information is incomplete",
                    }
                )
                continue

            # Group by repo_url
            if repo_url not in repo_skills_map:
                repo_skills_map[repo_url] = []
            repo_skills_map[repo_url].append((skill_kind, skill_path))

        return repo_skills_map

    def _process_repo_batch_update(
        self,
        repo_url: str,
        skills_info: List[Tuple[Any, str]],
        user_id: int,
        result: GitBatchUpdateResult,
        db: Session,
    ) -> None:
        """
        Process batch update for all skills from a single repository.

        Args:
            repo_url: Repository URL
            skills_info: List of (skill_kind, skill_path) tuples
            user_id: User ID
            result: GitBatchUpdateResult to update
            db: Database session
        """
        try:
            # Get authentication info
            provider, owner, repo, auth_info = get_auth_for_repo(repo_url, user_id, db)

            # Download repository ZIP once for all skills from this repo
            zip_content = download_repo_zip(provider, owner, repo, auth_info)

            # Extract to temporary directory
            with tempfile.TemporaryDirectory() as temp_dir:
                extract_zip_safely(zip_content, temp_dir)

                try:
                    repo_root = find_repo_root(temp_dir)
                except HTTPException as e:
                    # Mark all skills from this repo as failed
                    for skill_kind, skill_path in skills_info:
                        result.failed.append(
                            {
                                "id": skill_kind.id,
                                "name": skill_kind.name,
                                "error": e.detail,
                            }
                        )
                    return

                # Process each skill from this repository
                for skill_kind, skill_path in skills_info:
                    self._update_single_skill(
                        repo_root=repo_root,
                        repo_url=repo_url,
                        skill_kind=skill_kind,
                        skill_path=skill_path,
                        user_id=user_id,
                        result=result,
                        db=db,
                    )

        except HTTPException as e:
            # Repository-level error: mark all skills from this repo as failed
            for skill_kind, skill_path in skills_info:
                result.failed.append(
                    {
                        "id": skill_kind.id,
                        "name": skill_kind.name,
                        "error": f"Failed to download repository: {e.detail}",
                    }
                )
        except Exception as e:
            # Repository-level error: mark all skills from this repo as failed
            for skill_kind, skill_path in skills_info:
                result.failed.append(
                    {
                        "id": skill_kind.id,
                        "name": skill_kind.name,
                        "error": f"Failed to download repository: {str(e)}",
                    }
                )

    def _update_single_skill(
        self,
        repo_root: str,
        repo_url: str,
        skill_kind: Any,
        skill_path: str,
        user_id: int,
        result: GitBatchUpdateResult,
        db: Session,
    ) -> None:
        """
        Update a single skill from the extracted repository.

        Args:
            repo_root: Path to the repository root
            repo_url: Repository URL
            skill_kind: Skill Kind model instance
            skill_path: Path to the skill within the repository
            user_id: User ID
            result: GitBatchUpdateResult to update
            db: Database session
        """
        from app.services.adapters.skill_kinds import skill_kinds_service

        try:
            skill_dir = os.path.join(repo_root, skill_path)
            skill_name = os.path.basename(skill_path)

            if not os.path.isdir(skill_dir):
                result.failed.append(
                    {
                        "id": skill_kind.id,
                        "name": skill_kind.name,
                        "error": f"Skill directory not found in repository: {skill_path}",
                    }
                )
                return

            skill_md_path = os.path.join(skill_dir, "SKILL.md")
            if not os.path.isfile(skill_md_path):
                result.failed.append(
                    {
                        "id": skill_kind.id,
                        "name": skill_kind.name,
                        "error": "SKILL.md not found in skill directory",
                    }
                )
                return

            # Package skill directory into ZIP
            skill_zip = package_skill_directory(skill_dir, skill_name)
            file_name = f"{skill_name}.zip"

            # Update source info with new timestamp
            source_info = {
                "type": "git",
                "repo_url": repo_url,
                "skill_path": skill_path,
                "imported_at": datetime.utcnow().isoformat() + "Z",
            }

            # Update the skill
            updated_skill = skill_kinds_service.update_skill(
                db=db,
                skill_id=skill_kind.id,
                user_id=user_id,
                file_content=skill_zip,
                file_name=file_name,
                source=source_info,
            )

            result.success.append(
                {
                    "id": int(updated_skill.metadata.labels.get("id", 0)),
                    "name": updated_skill.metadata.name,
                    "version": updated_skill.spec.version,
                    "source": source_info,
                }
            )

        except HTTPException as e:
            result.failed.append(
                {
                    "id": skill_kind.id,
                    "name": skill_kind.name,
                    "error": e.detail,
                }
            )
        except Exception as e:
            result.failed.append(
                {
                    "id": skill_kind.id,
                    "name": skill_kind.name,
                    "error": str(e),
                }
            )


# Singleton instance
git_skill_service = GitSkillService()
