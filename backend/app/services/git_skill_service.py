# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Git Skill Import Service

This module provides functionality to scan and import skills from Git repositories.
Supports GitHub, GitLab, Gitee, and Gitea platforms.
"""

import io
import os
import re
import tempfile
import zipfile
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

import httpx
import yaml
from fastapi import HTTPException

from shared.utils.crypto import decrypt_git_token


@dataclass
class GitSkillInfo:
    """Information about a skill found in a Git repository"""

    path: str  # Path in the repository (e.g., "skills/pdf-reader")
    name: str  # Skill name extracted from path (directory name)
    description: str  # Description from SKILL.md frontmatter
    version: Optional[str] = None
    author: Optional[str] = None
    display_name: Optional[str] = None
    tags: Optional[List[str]] = None


@dataclass
class GitImportResult:
    """Result of importing skills from a Git repository"""

    success: List[Dict[str, Any]]  # Successfully imported skills
    skipped: List[Dict[str, Any]]  # Skipped due to name conflict
    failed: List[Dict[str, Any]]  # Failed to import


@dataclass
class GitBatchUpdateResult:
    """Result of batch updating skills from Git repositories"""

    success: List[Dict[str, Any]]  # Successfully updated skills
    skipped: List[Dict[str, Any]]  # Skipped (not found, not from git, etc.)
    failed: List[Dict[str, Any]]  # Failed to update


@dataclass
class RepoAuthInfo:
    """Authentication information for a repository"""

    username: Optional[str] = None
    password: Optional[str] = None  # Can be token or password
    auth_source: str = "none"  # "url_credentials", "platform_integration", or "none"


@dataclass
class ParsedRepoUrl:
    """Parsed repository URL with all components"""

    provider: "GitRepoProvider"
    owner: str
    repo: str
    domain: str
    auth_info: RepoAuthInfo


class GitRepoProvider(ABC):
    """Abstract base class for Git repository providers"""

    @abstractmethod
    def get_default_branch(
        self, owner: str, repo: str, auth: Optional[RepoAuthInfo] = None
    ) -> str:
        """Get the default branch name for a repository"""
        pass

    @abstractmethod
    def get_zip_download_url(self, owner: str, repo: str, branch: str) -> str:
        """Get the URL to download the repository as a ZIP file"""
        pass

    @abstractmethod
    def get_api_headers(self, auth: RepoAuthInfo) -> Dict[str, str]:
        """Get API headers for authentication"""
        pass

    @abstractmethod
    def get_zip_auth(self, auth: RepoAuthInfo) -> Optional[Tuple[str, str]]:
        """Get authentication tuple for ZIP download (username, password)"""
        pass

    @property
    @abstractmethod
    def name(self) -> str:
        """Provider name for display"""
        pass


class GitHubProvider(GitRepoProvider):
    """GitHub repository provider"""

    def __init__(self, host: str = "github.com"):
        self.host = host
        self.api_host = "api.github.com"

    @property
    def name(self) -> str:
        return "GitHub"

    def get_api_headers(self, auth: RepoAuthInfo) -> Dict[str, str]:
        """Get API headers for GitHub authentication"""
        headers = {"Accept": "application/vnd.github.v3+json"}
        if auth and auth.password:
            headers["Authorization"] = f"Bearer {auth.password}"
        return headers

    def get_zip_auth(self, auth: RepoAuthInfo) -> Optional[Tuple[str, str]]:
        """Get authentication for ZIP download"""
        if auth and auth.username and auth.password:
            return (auth.username, auth.password)
        if auth and auth.password:
            # Use token as password with empty username for GitHub
            return ("", auth.password)
        return None

    def get_default_branch(
        self, owner: str, repo: str, auth: Optional[RepoAuthInfo] = None
    ) -> str:
        """Get default branch from GitHub API"""
        url = f"https://{self.api_host}/repos/{owner}/{repo}"
        headers = self.get_api_headers(auth) if auth else {}
        try:
            with httpx.Client(timeout=30.0) as client:
                response = client.get(url, headers=headers if headers else None)
                if response.status_code == 404:
                    raise HTTPException(
                        status_code=404,
                        detail="Repository not found or not accessible",
                    )
                if response.status_code == 401 or response.status_code == 403:
                    raise HTTPException(
                        status_code=403,
                        detail="Authentication failed. Please check your access token.",
                    )
                if response.status_code != 200:
                    raise HTTPException(
                        status_code=response.status_code,
                        detail=f"Failed to get repository info: {response.text}",
                    )
                data = response.json()
                return data.get("default_branch", "main")
        except httpx.RequestError as e:
            raise HTTPException(
                status_code=503,
                detail=f"Failed to connect to GitHub API: {str(e)}",
            )

    def get_zip_download_url(self, owner: str, repo: str, branch: str) -> str:
        return f"https://{self.host}/{owner}/{repo}/archive/refs/heads/{branch}.zip"


class GitLabProvider(GitRepoProvider):
    """GitLab repository provider (supports gitlab.com and self-hosted)"""

    def __init__(self, host: str = "gitlab.com"):
        self.host = host

    @property
    def name(self) -> str:
        return "GitLab"

    def get_api_headers(self, auth: RepoAuthInfo) -> Dict[str, str]:
        """Get API headers for GitLab authentication"""
        headers = {}
        if auth and auth.password:
            headers["PRIVATE-TOKEN"] = auth.password
        return headers

    def get_zip_auth(self, auth: RepoAuthInfo) -> Optional[Tuple[str, str]]:
        """Get authentication for ZIP download"""
        if auth and auth.username and auth.password:
            return (auth.username, auth.password)
        if auth and auth.password:
            # For GitLab, use token as password with empty username
            return ("", auth.password)
        return None

    def get_default_branch(
        self, owner: str, repo: str, auth: Optional[RepoAuthInfo] = None
    ) -> str:
        """Get default branch from GitLab API"""
        # URL encode the project path
        project_path = f"{owner}%2F{repo}"
        url = f"https://{self.host}/api/v4/projects/{project_path}"
        headers = self.get_api_headers(auth) if auth else {}
        try:
            with httpx.Client(timeout=30.0) as client:
                response = client.get(url, headers=headers if headers else None)
                if response.status_code == 404:
                    raise HTTPException(
                        status_code=404,
                        detail="Repository not found or not accessible",
                    )
                if response.status_code == 401:
                    raise HTTPException(
                        status_code=403,
                        detail="Authentication failed. Please check your access token.",
                    )
                if response.status_code != 200:
                    raise HTTPException(
                        status_code=response.status_code,
                        detail=f"Failed to get repository info: {response.text}",
                    )
                data = response.json()
                return data.get("default_branch", "main")
        except httpx.RequestError as e:
            raise HTTPException(
                status_code=503,
                detail=f"Failed to connect to GitLab API: {str(e)}",
            )

    def get_zip_download_url(self, owner: str, repo: str, branch: str) -> str:
        return (
            f"https://{self.host}/{owner}/{repo}/-/archive/{branch}/{repo}-{branch}.zip"
        )


class GiteeProvider(GitRepoProvider):
    """Gitee repository provider"""

    def __init__(self, host: str = "gitee.com"):
        self.host = host

    @property
    def name(self) -> str:
        return "Gitee"

    def get_api_headers(self, auth: RepoAuthInfo) -> Dict[str, str]:
        """Get API headers for Gitee authentication"""
        headers = {}
        if auth and auth.password:
            headers["Authorization"] = f"Bearer {auth.password}"
        return headers

    def get_zip_auth(self, auth: RepoAuthInfo) -> Optional[Tuple[str, str]]:
        """Get authentication for ZIP download"""
        if auth and auth.username and auth.password:
            return (auth.username, auth.password)
        if auth and auth.password:
            # For Gitee, use token as password with empty username
            return ("", auth.password)
        return None

    def get_default_branch(
        self, owner: str, repo: str, auth: Optional[RepoAuthInfo] = None
    ) -> str:
        """Get default branch from Gitee API"""
        url = f"https://{self.host}/api/v5/repos/{owner}/{repo}"
        headers = self.get_api_headers(auth) if auth else {}
        try:
            with httpx.Client(timeout=30.0) as client:
                response = client.get(url, headers=headers if headers else None)
                if response.status_code == 404:
                    raise HTTPException(
                        status_code=404,
                        detail="Repository not found or not accessible",
                    )
                if response.status_code == 401:
                    raise HTTPException(
                        status_code=403,
                        detail="Authentication failed. Please check your access token.",
                    )
                if response.status_code != 200:
                    raise HTTPException(
                        status_code=response.status_code,
                        detail=f"Failed to get repository info: {response.text}",
                    )
                data = response.json()
                return data.get("default_branch", "master")
        except httpx.RequestError as e:
            raise HTTPException(
                status_code=503,
                detail=f"Failed to connect to Gitee API: {str(e)}",
            )

    def get_zip_download_url(self, owner: str, repo: str, branch: str) -> str:
        return f"https://{self.host}/{owner}/{repo}/repository/archive/{branch}.zip"


class GiteaProvider(GitRepoProvider):
    """Gitea repository provider (self-hosted)"""

    def __init__(self, host: str):
        self.host = host

    @property
    def name(self) -> str:
        return "Gitea"

    def get_api_headers(self, auth: RepoAuthInfo) -> Dict[str, str]:
        """Get API headers for Gitea authentication"""
        headers = {}
        if auth and auth.password:
            headers["Authorization"] = f"token {auth.password}"
        return headers

    def get_zip_auth(self, auth: RepoAuthInfo) -> Optional[Tuple[str, str]]:
        """Get authentication for ZIP download"""
        if auth and auth.username and auth.password:
            return (auth.username, auth.password)
        if auth and auth.password:
            # For Gitea, use token as password with empty username
            return ("", auth.password)
        return None

    def get_default_branch(
        self, owner: str, repo: str, auth: Optional[RepoAuthInfo] = None
    ) -> str:
        """Get default branch from Gitea API"""
        url = f"https://{self.host}/api/v1/repos/{owner}/{repo}"
        headers = self.get_api_headers(auth) if auth else {}
        try:
            with httpx.Client(timeout=30.0) as client:
                response = client.get(url, headers=headers if headers else None)
                if response.status_code == 404:
                    raise HTTPException(
                        status_code=404,
                        detail="Repository not found or not accessible",
                    )
                if response.status_code == 401:
                    raise HTTPException(
                        status_code=403,
                        detail="Authentication failed. Please check your access token.",
                    )
                if response.status_code != 200:
                    raise HTTPException(
                        status_code=response.status_code,
                        detail=f"Failed to get repository info: {response.text}",
                    )
                data = response.json()
                return data.get("default_branch", "main")
        except httpx.RequestError as e:
            raise HTTPException(
                status_code=503,
                detail=f"Failed to connect to Gitea API: {str(e)}",
            )

    def get_zip_download_url(self, owner: str, repo: str, branch: str) -> str:
        return f"https://{self.host}/{owner}/{repo}/archive/{branch}.zip"


def parse_repo_url(url: str) -> ParsedRepoUrl:
    """
    Parse a Git repository URL and return the appropriate provider with auth info.

    Args:
        url: Git repository URL (e.g., "https://github.com/owner/repo")
               or with credentials: "https://user:pass@github.com/owner/repo"

    Returns:
        ParsedRepoUrl with provider, owner, repo, domain, and auth_info

    Raises:
        HTTPException: If URL format is invalid or platform is not supported
    """
    # Normalize URL - add https:// if missing
    if not url.startswith(("http://", "https://")):
        url = f"https://{url}"

    try:
        parsed = urlparse(url)
        # Use hostname instead of netloc to avoid including credentials
        host = parsed.hostname.lower() if parsed.hostname else ""

        # Extract credentials from URL (if present)
        username = parsed.username
        password = parsed.password

        # Determine auth source
        # Support formats:
        # - https://user:pass@host/owner/repo (both username and password)
        # - https://token@host/owner/repo (token as username, no password)
        if username and password:
            auth_source = "url_credentials"
            auth_info = RepoAuthInfo(
                username=username, password=password, auth_source=auth_source
            )
        elif username:
            # Token-only format: https://token@host/owner/repo
            auth_source = "url_credentials"
            auth_info = RepoAuthInfo(
                username="", password=username, auth_source=auth_source
            )
        else:
            auth_source = "none"
            auth_info = RepoAuthInfo(auth_source=auth_source)

        # Remove trailing .git if present
        path = parsed.path.rstrip("/")
        if path.endswith(".git"):
            path = path[:-4]

        # Extract owner and repo from path
        path_parts = [p for p in path.split("/") if p]
        if len(path_parts) < 2:
            raise HTTPException(
                status_code=400,
                detail="Invalid repository URL format. Expected: https://host/owner/repo",
            )

        owner = path_parts[0]
        repo = path_parts[1]

        # Determine provider based on host
        if "github.com" in host:
            provider = GitHubProvider(host)
        elif "gitlab.com" in host:
            provider = GitLabProvider(host)
        elif "gitee.com" in host:
            provider = GiteeProvider(host)
        else:
            # Try as Gitea for unknown hosts
            # Could also be self-hosted GitLab, but Gitea API is more common
            provider = GiteaProvider(host)

        return ParsedRepoUrl(
            provider=provider,
            owner=owner,
            repo=repo,
            domain=host,
            auth_info=auth_info,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to parse repository URL: {str(e)}",
        )


def get_user_git_token(user_id: int, domain: str, db) -> Optional[str]:
    """
    Get user's Git token for a specific domain.

    Args:
        user_id: User ID
        domain: Git domain (e.g., "github.com", "gitlab.company.com")
        db: Database session

    Returns:
        Decrypted token string or None if not found
    """
    from shared.models.db.user import User

    user = db.query(User).filter(User.id == user_id).first()
    if not user or not user.git_info:
        return None

    # git_info is a list of GitInfo objects
    for git_info in user.git_info:
        if git_info.get("git_domain") == domain:
            encrypted_token = git_info.get("git_token")
            if encrypted_token:
                return decrypt_git_token(encrypted_token)

    return None


def get_auth_for_repo(
    url: str, user_id: int, db
) -> Tuple[GitRepoProvider, str, str, RepoAuthInfo]:
    """
    Get authentication information for a repository.

    Priority:
    1. URL embedded credentials (highest priority)
    2. Platform integration configured token
    3. No authentication (lowest priority)

    Args:
        url: Git repository URL
        user_id: User ID for looking up platform integration tokens
        db: Database session

    Returns:
        Tuple of (provider, owner, repo, auth_info)

    Raises:
        HTTPException: If URL format is invalid
    """
    parsed = parse_repo_url(url)

    # If URL has embedded credentials, use them directly
    if parsed.auth_info.auth_source == "url_credentials":
        return (parsed.provider, parsed.owner, parsed.repo, parsed.auth_info)

    # Otherwise, try to get token from platform integration
    domain = parsed.domain
    token = get_user_git_token(user_id, domain, db)

    if token:
        auth_info = RepoAuthInfo(
            username="git",  # Generic username for token-based auth
            password=token,
            auth_source="platform_integration",
        )
        return (parsed.provider, parsed.owner, parsed.repo, auth_info)

    # No authentication available
    return (parsed.provider, parsed.owner, parsed.repo, parsed.auth_info)


def check_private_repo_error(domain: str, auth_source: str) -> HTTPException:
    """
    Create an appropriate error for private repository access failure.

    Args:
        domain: Git domain (e.g., "github.com")
        auth_source: Current authentication source

    Returns:
        HTTPException with appropriate message
    """
    if auth_source == "none":
        return HTTPException(
            status_code=403,
            detail=f"This repository may be private. Please configure a Git token for {domain} "
            f"in Settings > Platform Integration, or provide credentials in the URL "
            f"(e.g., https://token@{domain}/owner/repo)",
        )
    else:
        return HTTPException(
            status_code=403,
            detail="Authentication failed. Please check your Git token or credentials.",
        )


def download_repo_zip(
    provider: GitRepoProvider,
    owner: str,
    repo: str,
    auth: Optional[RepoAuthInfo] = None,
) -> bytes:
    """
    Download a repository as a ZIP file.

    Args:
        provider: Git repository provider
        owner: Repository owner
        repo: Repository name
        auth: Optional authentication info

    Returns:
        ZIP file content as bytes

    Raises:
        HTTPException: If download fails
    """
    # Get default branch with auth
    branch = provider.get_default_branch(owner, repo, auth)

    # Get download URL
    download_url = provider.get_zip_download_url(owner, repo, branch)

    # Get authentication for ZIP download
    zip_auth = provider.get_zip_auth(auth) if auth else None

    try:
        with httpx.Client(timeout=120.0, follow_redirects=True) as client:
            if zip_auth:
                response = client.get(download_url, auth=zip_auth)
            else:
                response = client.get(download_url)

            if response.status_code == 404:
                raise HTTPException(
                    status_code=404,
                    detail="Repository not found or not accessible",
                )
            if response.status_code in (401, 403):
                auth_source = auth.auth_source if auth else "none"
                domain = provider.host
                raise check_private_repo_error(domain, auth_source)
            if response.status_code != 200:
                raise HTTPException(
                    status_code=response.status_code,
                    detail=f"Failed to download repository: {response.text}",
                )
            return response.content
    except httpx.RequestError as e:
        raise HTTPException(
            status_code=503,
            detail=f"Failed to download repository: {str(e)}",
        )


def parse_skill_md(content: str) -> Dict[str, Any]:
    """
    Parse SKILL.md content and extract metadata from YAML frontmatter.

    Args:
        content: SKILL.md file content

    Returns:
        Dictionary with parsed metadata

    Raises:
        ValueError: If frontmatter is missing or invalid
    """
    # Extract YAML frontmatter between --- markers
    frontmatter_pattern = re.compile(
        r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL | re.MULTILINE
    )
    match = frontmatter_pattern.search(content)

    if not match:
        raise ValueError("SKILL.md must contain YAML frontmatter between --- markers")

    yaml_content = match.group(1)

    try:
        metadata = yaml.safe_load(yaml_content)
        if not isinstance(metadata, dict):
            raise ValueError("YAML frontmatter must be a dictionary")

        if "description" not in metadata:
            raise ValueError("SKILL.md frontmatter must include 'description' field")

        return metadata

    except yaml.YAMLError as e:
        raise ValueError(f"Invalid YAML frontmatter: {str(e)}")


def scan_skills_in_directory(temp_dir: str) -> List[GitSkillInfo]:
    """
    Recursively scan a directory for skills (directories containing SKILL.md).

    Args:
        temp_dir: Path to the temporary directory containing extracted repository

    Returns:
        List of GitSkillInfo objects for found skills
    """
    skills = []

    # Walk through all directories
    for root, dirs, files in os.walk(temp_dir):
        if "SKILL.md" in files:
            skill_md_path = os.path.join(root, "SKILL.md")

            try:
                with open(skill_md_path, "r", encoding="utf-8") as f:
                    content = f.read()

                metadata = parse_skill_md(content)

                # Calculate relative path from temp_dir
                # Skip the first directory level (repo-branch folder)
                rel_path = os.path.relpath(root, temp_dir)
                path_parts = rel_path.split(os.sep)

                # Skip the root repo folder (e.g., "repo-main")
                if len(path_parts) > 1:
                    skill_path = os.path.join(*path_parts[1:])
                else:
                    skill_path = path_parts[0]

                # Extract skill name from directory name
                skill_name = os.path.basename(root)

                skills.append(
                    GitSkillInfo(
                        path=skill_path,
                        name=skill_name,
                        description=metadata.get("description", ""),
                        version=metadata.get("version"),
                        author=metadata.get("author"),
                        display_name=metadata.get("displayName"),
                        tags=metadata.get("tags"),
                    )
                )

            except Exception:
                # Skip invalid skills
                continue

    return skills


def package_skill_directory(skill_dir: str, skill_name: str) -> bytes:
    """
    Package a skill directory into a ZIP file with the correct structure.

    The ZIP structure should be:
    skill_name.zip
      └── skill_name/
          ├── SKILL.md
          └── other files...

    Args:
        skill_dir: Path to the skill directory
        skill_name: Name of the skill

    Returns:
        ZIP file content as bytes
    """
    zip_buffer = io.BytesIO()

    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
        for root, dirs, files in os.walk(skill_dir):
            for file in files:
                file_path = os.path.join(root, file)
                # Calculate archive path: skill_name/relative_path
                rel_path = os.path.relpath(file_path, skill_dir)
                archive_path = os.path.join(skill_name, rel_path)
                zip_file.write(file_path, archive_path)

    return zip_buffer.getvalue()


class GitSkillService:
    """Service for scanning and importing skills from Git repositories"""

    def scan_repository(
        self, repo_url: str, user_id: int = None, db=None
    ) -> Tuple[List[GitSkillInfo], Dict[str, Any]]:
        """
        Scan a Git repository for skills.

        Args:
            repo_url: Git repository URL
            user_id: User ID for authentication (optional)
            db: Database session (optional, required if user_id is provided)

        Returns:
            Tuple of (skills list, repo_info dict)
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

        # Extract to temporary directory and scan
        with tempfile.TemporaryDirectory() as temp_dir:
            # Extract ZIP
            with zipfile.ZipFile(io.BytesIO(zip_content), "r") as zip_file:
                # Security check: prevent Zip Slip attacks
                for file_info in zip_file.filelist:
                    if file_info.filename.startswith("/") or ".." in file_info.filename:
                        raise HTTPException(
                            status_code=400,
                            detail=f"Unsafe file path detected in ZIP: {file_info.filename}",
                        )
                zip_file.extractall(temp_dir)

            # Scan for skills
            skills = scan_skills_in_directory(temp_dir)

        # Build repo_info
        repo_info = {
            "domain": provider.host,
            "has_token_configured": auth_info.auth_source != "none",
            "auth_source": auth_info.auth_source,
        }

        return skills, repo_info

    def import_skills(
        self,
        repo_url: str,
        skill_paths: List[str],
        namespace: str,
        user_id: int,
        overwrite_names: Optional[List[str]] = None,
        db=None,
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
        from datetime import datetime

        from app.services.adapters.skill_kinds import skill_kinds_service

        if overwrite_names is None:
            overwrite_names = []

        # Get authentication info
        provider, owner, repo, auth_info = get_auth_for_repo(repo_url, user_id, db)

        # Download repository ZIP with auth
        zip_content = download_repo_zip(provider, owner, repo, auth_info)

        result = GitImportResult(success=[], skipped=[], failed=[])

        # Build source info for git-imported skills
        source_info = {
            "type": "git",
            "repo_url": repo_url,
            "imported_at": datetime.utcnow().isoformat() + "Z",
        }

        # Extract to temporary directory
        with tempfile.TemporaryDirectory() as temp_dir:
            # Extract ZIP
            with zipfile.ZipFile(io.BytesIO(zip_content), "r") as zip_file:
                # Security check
                for file_info in zip_file.filelist:
                    if file_info.filename.startswith("/") or ".." in file_info.filename:
                        raise HTTPException(
                            status_code=400,
                            detail=f"Unsafe file path detected in ZIP: {file_info.filename}",
                        )
                zip_file.extractall(temp_dir)

            # Find the root directory (repo-branch folder)
            root_dirs = [
                d
                for d in os.listdir(temp_dir)
                if os.path.isdir(os.path.join(temp_dir, d))
            ]
            if not root_dirs:
                raise HTTPException(
                    status_code=400,
                    detail="Invalid repository structure: no root directory found",
                )
            repo_root = os.path.join(temp_dir, root_dirs[0])

            # Process each skill path
            for skill_path in skill_paths:
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
                    continue

                skill_md_path = os.path.join(skill_dir, "SKILL.md")
                if not os.path.isfile(skill_md_path):
                    result.failed.append(
                        {
                            "name": skill_name,
                            "path": skill_path,
                            "error": "SKILL.md not found in skill directory",
                        }
                    )
                    continue

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
                        continue

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

        return result

    def update_skill_from_git(
        self,
        skill_id: int,
        user_id: int,
        db=None,
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
        from datetime import datetime

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
            # Extract ZIP
            with zipfile.ZipFile(io.BytesIO(zip_content), "r") as zip_file:
                # Security check
                for file_info in zip_file.filelist:
                    if file_info.filename.startswith("/") or ".." in file_info.filename:
                        raise HTTPException(
                            status_code=400,
                            detail=f"Unsafe file path detected in ZIP: {file_info.filename}",
                        )
                zip_file.extractall(temp_dir)

            # Find the root directory (repo-branch folder)
            root_dirs = [
                d
                for d in os.listdir(temp_dir)
                if os.path.isdir(os.path.join(temp_dir, d))
            ]
            if not root_dirs:
                raise HTTPException(
                    status_code=400,
                    detail="Invalid repository structure: no root directory found",
                )
            repo_root = os.path.join(temp_dir, root_dirs[0])

            # Find the skill directory
            skill_dir = os.path.join(repo_root, skill_path)
            skill_name = os.path.basename(skill_path)

            if not os.path.isdir(skill_dir):
                raise HTTPException(
                    status_code=404,
                    detail=f"Skill directory not found in repository: {skill_path}",
                )

            skill_md_path = os.path.join(skill_dir, "SKILL.md")
            if not os.path.isfile(skill_md_path):
                raise HTTPException(
                    status_code=400,
                    detail="SKILL.md not found in skill directory",
                )

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
        db=None,
    ) -> "GitBatchUpdateResult":
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
        from datetime import datetime

        from app.models.kind import Kind
        from app.services.adapters.skill_kinds import skill_kinds_service

        result = GitBatchUpdateResult(success=[], skipped=[], failed=[])

        if not skill_ids:
            return result

        # Step 1: Fetch all skills and group by repo_url
        repo_skills_map: Dict[str, List[Tuple[Kind, str]]] = (
            {}
        )  # repo_url -> [(skill_kind, skill_path), ...]

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

        # Step 2: Process each repository once
        for repo_url, skills_info in repo_skills_map.items():
            try:
                # Get authentication info
                provider, owner, repo, auth_info = get_auth_for_repo(
                    repo_url, user_id, db
                )

                # Download repository ZIP once for all skills from this repo
                zip_content = download_repo_zip(provider, owner, repo, auth_info)

                # Extract to temporary directory
                with tempfile.TemporaryDirectory() as temp_dir:
                    # Extract ZIP
                    with zipfile.ZipFile(io.BytesIO(zip_content), "r") as zip_file:
                        # Security check
                        for file_info in zip_file.filelist:
                            if (
                                file_info.filename.startswith("/")
                                or ".." in file_info.filename
                            ):
                                raise HTTPException(
                                    status_code=400,
                                    detail=f"Unsafe file path detected in ZIP: {file_info.filename}",
                                )
                        zip_file.extractall(temp_dir)

                    # Find the root directory (repo-branch folder)
                    root_dirs = [
                        d
                        for d in os.listdir(temp_dir)
                        if os.path.isdir(os.path.join(temp_dir, d))
                    ]
                    if not root_dirs:
                        # Mark all skills from this repo as failed
                        for skill_kind, skill_path in skills_info:
                            result.failed.append(
                                {
                                    "id": skill_kind.id,
                                    "name": skill_kind.name,
                                    "error": "Invalid repository structure: no root directory found",
                                }
                            )
                        continue

                    repo_root = os.path.join(temp_dir, root_dirs[0])

                    # Process each skill from this repository
                    for skill_kind, skill_path in skills_info:
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
                                continue

                            skill_md_path = os.path.join(skill_dir, "SKILL.md")
                            if not os.path.isfile(skill_md_path):
                                result.failed.append(
                                    {
                                        "id": skill_kind.id,
                                        "name": skill_kind.name,
                                        "error": "SKILL.md not found in skill directory",
                                    }
                                )
                                continue

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
                                    "id": int(
                                        updated_skill.metadata.labels.get("id", 0)
                                    ),
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

        return result


# Singleton instance
git_skill_service = GitSkillService()
