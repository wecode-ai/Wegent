# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Utility functions for Git Skill Import Service.

This module contains helper functions for URL parsing, authentication,
ZIP handling, skill scanning, and SKILL.md parsing.
"""

import io
import logging
import os
import re
import tempfile
import zipfile
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

import httpx
import yaml
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.services.git_skill.models import (
    GitSkillInfo,
    ParsedRepoUrl,
    RepoAuthInfo,
)
from app.services.git_skill.providers import (
    GitRepoProvider,
    get_provider_by_host,
    get_provider_by_type,
)
from shared.utils.crypto import decrypt_git_token

logger = logging.getLogger(__name__)


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

        # Build base_url with protocol and port
        scheme = parsed.scheme or "https"
        port_str = (
            f":{parsed.port}" if parsed.port and parsed.port not in (80, 443) else ""
        )
        base_url = f"{scheme}://{host}{port_str}"

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
        # For GitLab, the path can be nested (e.g., group/subgroup/project)
        # We need to handle this by joining all parts except the last as "owner"
        # and the last part as "repo"
        path_parts = [p for p in path.split("/") if p]
        if len(path_parts) < 2:
            raise HTTPException(
                status_code=400,
                detail="Invalid repository URL format. Expected: https://host/owner/repo",
            )

        # For nested GitLab groups: weibo_rd/common/wecode/wegent-skills
        # owner = "weibo_rd/common/wecode", repo = "wegent-skills"
        repo = path_parts[-1]  # Last part is always the repo name
        owner = "/".join(path_parts[:-1])  # Everything else is the owner/group path

        # Determine provider based on host
        provider = get_provider_by_host(host, base_url)

        return ParsedRepoUrl(
            provider=provider,
            owner=owner,
            repo=repo,
            domain=host,
            auth_info=auth_info,
            base_url=base_url,
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to parse repository URL: {str(e)}",
        )


def get_user_git_info(
    user_id: int, domain: str, db: Session
) -> Optional[Dict[str, Any]]:
    """
    Get user's Git info for a specific domain.

    Args:
        user_id: User ID
        domain: Git domain (e.g., "github.com", "gitlab.company.com")
        db: Database session

    Returns:
        Git info dict with decrypted token, or None if not found
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
                return {
                    "type": git_info.get("type"),
                    "token": decrypt_git_token(encrypted_token),
                    "git_domain": git_info.get("git_domain"),
                }

    return None


def get_auth_for_repo(
    url: str, user_id: int, db: Session
) -> Tuple[GitRepoProvider, str, str, RepoAuthInfo]:
    """
    Get authentication information for a repository.

    Priority:
    1. URL embedded credentials (highest priority)
    2. Platform integration configured token (uses user's configured provider type)
    3. No authentication with URL-guessed provider (lowest priority)

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

    # Otherwise, try to get git info from platform integration
    domain = parsed.domain
    git_info = get_user_git_info(user_id, domain, db)

    if git_info:
        token = git_info.get("token")
        git_type = git_info.get("type")

        auth_info = RepoAuthInfo(
            username="git",  # Generic username for token-based auth
            password=token,
            auth_source="platform_integration",
        )

        # Use the provider type from user's configuration instead of guessing from URL
        if git_type:
            provider = get_provider_by_type(git_type, domain, parsed.base_url)
        else:
            provider = parsed.provider

        return (provider, parsed.owner, parsed.repo, auth_info)

    # No authentication available, use URL-guessed provider
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
    zip_headers = provider.get_zip_headers(auth) if auth else {}

    # Log download request
    logger.info(
        f"Downloading repository ZIP: url={download_url}, "
        f"provider={provider.name}, owner={owner}, repo={repo}, branch={branch}"
    )

    try:
        with httpx.Client(timeout=120.0, follow_redirects=True) as client:
            # Use headers for authentication (preferred for GitHub)
            # Fall back to basic auth for other providers
            if zip_headers:
                response = client.get(download_url, headers=zip_headers)
            elif zip_auth:
                response = client.get(download_url, auth=zip_auth)
            else:
                response = client.get(download_url)

            logger.info(
                f"Repository ZIP download response: status_code={response.status_code}, "
                f"content_type={response.headers.get('content-type', 'unknown')}, "
                f"content_length={len(response.content)}"
            )

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


# Maximum skill package size (10MB) - same as SkillValidator.MAX_SIZE
MAX_SKILL_SIZE = 10 * 1024 * 1024


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

    Raises:
        HTTPException: If the packaged ZIP exceeds the maximum size limit (10MB)
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

    zip_content = zip_buffer.getvalue()

    # Validate file size
    if len(zip_content) > MAX_SKILL_SIZE:
        raise HTTPException(
            status_code=413,
            detail=f"Skill '{skill_name}' package size ({len(zip_content)} bytes) "
            f"exceeds maximum allowed size ({MAX_SKILL_SIZE} bytes / 10MB)",
        )

    return zip_content


def extract_zip_safely(zip_content: bytes, temp_dir: str) -> None:
    """
    Extract ZIP content to a directory with security checks.

    Args:
        zip_content: ZIP file content as bytes
        temp_dir: Target directory for extraction

    Raises:
        HTTPException: If unsafe file paths are detected (Zip Slip attack)
    """
    with zipfile.ZipFile(io.BytesIO(zip_content), "r") as zip_file:
        # Security check: prevent Zip Slip attacks
        for file_info in zip_file.filelist:
            if file_info.filename.startswith("/") or ".." in file_info.filename:
                raise HTTPException(
                    status_code=400,
                    detail=f"Unsafe file path detected in ZIP: {file_info.filename}",
                )
        zip_file.extractall(temp_dir)


def find_repo_root(temp_dir: str) -> str:
    """
    Find the root directory of an extracted repository.

    Args:
        temp_dir: Directory containing extracted repository

    Returns:
        Path to the repository root directory

    Raises:
        HTTPException: If no root directory is found
    """
    root_dirs = [
        d for d in os.listdir(temp_dir) if os.path.isdir(os.path.join(temp_dir, d))
    ]
    if not root_dirs:
        raise HTTPException(
            status_code=400,
            detail="Invalid repository structure: no root directory found",
        )
    return os.path.join(temp_dir, root_dirs[0])


def validate_skill_directory(skill_dir: str, skill_path: str) -> None:
    """
    Validate that a skill directory exists and contains SKILL.md.

    Args:
        skill_dir: Path to the skill directory
        skill_path: Original skill path (for error messages)

    Raises:
        HTTPException: If directory or SKILL.md is missing
    """
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
