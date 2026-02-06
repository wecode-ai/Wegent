# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Data models for Git Skill Import Service.

This module contains all dataclasses used for representing skill information,
import results, and authentication data.
"""

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple

if TYPE_CHECKING:
    from app.services.git_skill.providers.base import GitRepoProvider


@dataclass
class GitSkillInfo:
    """Information about a skill found in a Git repository."""

    path: str  # Path in the repository (e.g., "skills/pdf-reader")
    name: str  # Skill name extracted from path (directory name)
    description: str  # Description from SKILL.md frontmatter
    version: Optional[str] = None
    author: Optional[str] = None
    display_name: Optional[str] = None
    tags: Optional[List[str]] = None


@dataclass
class GitImportResult:
    """Result of importing skills from a Git repository."""

    success: List[Dict[str, Any]] = field(
        default_factory=list
    )  # Successfully imported skills
    skipped: List[Dict[str, Any]] = field(
        default_factory=list
    )  # Skipped due to name conflict
    failed: List[Dict[str, Any]] = field(default_factory=list)  # Failed to import


@dataclass
class GitBatchUpdateResult:
    """Result of batch updating skills from Git repositories."""

    success: List[Dict[str, Any]] = field(
        default_factory=list
    )  # Successfully updated skills
    skipped: List[Dict[str, Any]] = field(
        default_factory=list
    )  # Skipped (not found, not from git, etc.)
    failed: List[Dict[str, Any]] = field(default_factory=list)  # Failed to update


@dataclass
class RepoAuthInfo:
    """Authentication information for a repository."""

    username: Optional[str] = None
    password: Optional[str] = None  # Can be token or password
    auth_source: str = "none"  # "url_credentials", "platform_integration", or "none"


@dataclass
class ParsedRepoUrl:
    """Parsed repository URL with all components."""

    provider: "GitRepoProvider"
    owner: str
    repo: str
    domain: str
    auth_info: RepoAuthInfo
    base_url: str = (
        ""  # Full base URL with protocol and port (e.g., "http://localhost:6000")
    )
