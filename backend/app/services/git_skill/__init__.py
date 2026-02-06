# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Git Skill Import Service Package.

This package provides functionality to scan and import skills from Git repositories.
Supports GitHub, GitLab, Gitee, and Gitea platforms.

Usage:
    from app.services.git_skill import git_skill_service

    # Scan a repository for skills
    skills, repo_info = git_skill_service.scan_repository(repo_url, user_id, db)

    # Import skills from a repository
    result = git_skill_service.import_skills(repo_url, skill_paths, namespace, user_id, db=db)

    # Update a skill from its Git source
    updated = git_skill_service.update_skill_from_git(skill_id, user_id, db)

    # Batch update skills from Git
    result = git_skill_service.batch_update_skills_from_git(skill_ids, user_id, db)
"""

from app.services.git_skill.models import (
    GitBatchUpdateResult,
    GitImportResult,
    GitSkillInfo,
    ParsedRepoUrl,
    RepoAuthInfo,
)
from app.services.git_skill.providers import (
    GiteaProvider,
    GiteeProvider,
    GitHubProvider,
    GitLabProvider,
    GitRepoProvider,
    get_provider_by_host,
    get_provider_by_type,
)
from app.services.git_skill.service import GitSkillService, git_skill_service
from app.services.git_skill.utils import (
    MAX_SKILL_SIZE,
    check_private_repo_error,
    download_repo_zip,
    extract_zip_safely,
    find_repo_root,
    get_auth_for_repo,
    get_user_git_info,
    package_skill_directory,
    parse_repo_url,
    parse_skill_md,
    scan_skills_in_directory,
    validate_skill_directory,
)

__all__ = [
    # Main service
    "GitSkillService",
    "git_skill_service",
    # Models
    "GitSkillInfo",
    "GitImportResult",
    "GitBatchUpdateResult",
    "RepoAuthInfo",
    "ParsedRepoUrl",
    # Providers
    "GitRepoProvider",
    "GitHubProvider",
    "GitLabProvider",
    "GiteeProvider",
    "GiteaProvider",
    "get_provider_by_type",
    "get_provider_by_host",
    # Utility functions
    "parse_repo_url",
    "get_user_git_info",
    "get_auth_for_repo",
    "check_private_repo_error",
    "download_repo_zip",
    "parse_skill_md",
    "scan_skills_in_directory",
    "package_skill_directory",
    "extract_zip_safely",
    "find_repo_root",
    "validate_skill_directory",
    # Constants
    "MAX_SKILL_SIZE",
]
