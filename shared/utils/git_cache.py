# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Git cache utility for local repository caching using --reference mode.

This module provides functionality to cache git repositories locally and use them
as reference repositories when cloning, which significantly reduces network
transfer and disk usage.

Cache isolation is based on database user_id for complete separation between users.
"""

import os
import subprocess
from urllib.parse import urlparse

from shared.logger import setup_logger

logger = setup_logger(__name__)

# Environment variables
ENV_CACHE_ENABLED = "GIT_CACHE_ENABLED"
ENV_CACHE_AUTO_UPDATE = "GIT_CACHE_AUTO_UPDATE"
ENV_CACHE_USER_ID = "GIT_CACHE_USER_ID"
ENV_CACHE_USER_BASE_DIR = "GIT_CACHE_USER_BASE_DIR"


def is_cache_enabled() -> bool:
    """
    Check if git cache is enabled via environment variable.

    Returns:
        True if cache is enabled, False otherwise.
    """
    return os.getenv(ENV_CACHE_ENABLED, "false").lower() == "true"


def get_user_cache_base_dir() -> str:
    """
    Get the user-specific cache base directory from environment variable.

    In the physical isolation design:
    - Each user has their own volume mounted at: /git-cache
    - The volume itself provides isolation (no user subdirectory needed)
    - This function returns: /git-cache

    GIT_CACHE_USER_BASE_DIR must be set by executor_manager when starting the container.

    Returns:
        User-specific cache base directory path (always /git-cache in the new design).

    Raises:
        ValueError: If GIT_CACHE_USER_BASE_DIR is not set
    """
    user_base_dir = os.getenv(ENV_CACHE_USER_BASE_DIR)
    if not user_base_dir:
        raise ValueError(
            "GIT_CACHE_USER_BASE_DIR environment variable is required. "
            "This should be set by executor_manager when starting the container."
        )
    return user_base_dir


def is_auto_update_enabled() -> bool:
    """
    Check if cache auto-update is enabled via environment variable.

    Returns:
        True if auto-update is enabled, False otherwise.
    """
    return os.getenv(ENV_CACHE_AUTO_UPDATE, "true").lower() == "true"


def get_cache_user_id() -> int:
    """
    Get the cache user ID from environment variable.

    This is REQUIRED for cache isolation in containerized environments.
    The user_id is passed by executor_manager from the task context.

    Returns:
        User ID (integer)

    Raises:
        ValueError: If GIT_CACHE_USER_ID is not set or invalid
    """
    user_id_str = os.getenv(ENV_CACHE_USER_ID)
    if not user_id_str:
        raise ValueError(
            f"Environment variable {ENV_CACHE_USER_ID} is not set. "
            "This is required for git cache isolation. "
            "Please ensure executor_manager passes the user_id when starting the container."
        )

    try:
        user_id = int(user_id_str)
        if user_id <= 0:
            raise ValueError(f"Invalid user_id: {user_id}. Must be a positive integer.")
        return user_id
    except ValueError as e:
        raise ValueError(
            f"Invalid {ENV_CACHE_USER_ID} value: '{user_id_str}'. "
            f"Must be a valid integer. Error: {e}"
        )


def _validate_cache_path(cache_path: str, allowed_base_dir: str) -> bool:
    """
    Validate that cache path is within the allowed base directory.

    This prevents path traversal attacks and ensures cache isolation.

    Args:
        cache_path: Path to validate
        allowed_base_dir: Base directory that cache_path must be within

    Returns:
        True if path is valid

    Raises:
        ValueError: If path is outside allowed directory
    """
    # Resolve to absolute paths
    abs_cache_path = os.path.abspath(cache_path)
    abs_base_dir = os.path.abspath(allowed_base_dir)

    # Ensure cache path is within allowed base directory
    if not abs_cache_path.startswith(abs_base_dir + os.sep) and abs_cache_path != abs_base_dir:
        raise ValueError(
            f"Security violation: cache path {abs_cache_path} "
            f"is outside allowed base directory {abs_base_dir}"
        )

    logger.debug(f"Cache path validation passed: {abs_cache_path} within {abs_base_dir}")
    return True


def get_cache_repo_path(url: str) -> str:
    """
    Calculate the cache repository path for a given URL with physical isolation.

    In the physical isolation design:
    - Each user has their own volume mounted at: /git-cache
    - The base directory is from GIT_CACHE_USER_BASE_DIR (now just /git-cache)
    - Final path: /git-cache/{domain}/{path}.git

    This is simpler than the previous design because the volume itself provides
    isolation - no user_{id} subdirectory needed.

    Args:
        url: Git repository URL

    Returns:
        Path to the cache repository

    Raises:
        ValueError: If GIT_CACHE_USER_ID is not set

    Examples:
        >>> # With GIT_CACHE_USER_BASE_DIR=/git-cache
        >>> get_cache_repo_path("https://github.com/user/repo.git")
        "/git-cache/github.com/user/repo.git"

        >>> # With GIT_CACHE_USER_BASE_DIR=/git-cache
        >>> get_cache_repo_path("git@gitlab.com:group/project.git")
        "/git-cache/gitlab.com/group/project.git"
    """
    # Get user ID (required, will raise ValueError if not set)
    user_id = get_cache_user_id()

    # With physical isolation, base directory is just the mount point
    # No user subdirectory needed - each user has their own volume
    user_base_dir = get_user_cache_base_dir()  # Returns /git-cache

    # Normalize URL to get the path components
    # Handle SSH format: git@domain.com:path/repo.git
    if url.startswith("git@") and ":" in url:
        # Extract domain and path from git@domain.com:path/repo.git
        domain_and_path = url.split("@")[1]
        domain = domain_and_path.split(":")[0]
        path = domain_and_path.split(":")[1]
    else:
        # Handle HTTPS/HTTP format: https://domain.com/path/repo.git
        parsed = urlparse(url)
        domain = parsed.netloc or parsed.hostname
        path = parsed.path

    # Remove .git suffix if present
    if path.endswith(".git"):
        path = path[:-4]

    # Remove leading slash from path
    if path.startswith("/"):
        path = path[1:]

    # Construct cache path: /git-cache/{domain}/{path}.git
    # Note: No user_{id} prefix - the volume itself provides isolation
    cache_path = os.path.join(user_base_dir, domain, f"{path}.git")

    # Validate the path is within allowed base directory (still important for security)
    try:
        _validate_cache_path(cache_path, user_base_dir)
    except ValueError as e:
        logger.error(f"Cache path validation failed: {e}")
        raise

    logger.debug(f"Calculated cache path for user_{user_id}: {cache_path}")
    return cache_path


def ensure_cache_repo(
    cache_path: str, auth_url: str, branch: str = None
) -> tuple[bool, str]:
    """
    Ensure cache repository exists and is up-to-date.

    If cache doesn't exist, create it as a bare repository.
    If cache exists and auto-update is enabled, fetch all remotes.

    Args:
        cache_path: Path to the cache repository
        auth_url: Authenticated git URL for fetching
        branch: Branch to fetch (optional, fetches all if not specified)

    Returns:
        Tuple (success, error_message):
        - On success: (True, None)
        - On failure: (False, error_message)
    """
    try:
        user_id = get_cache_user_id()
    except ValueError as e:
        logger.error(f"Cache user ID error: {e}")
        return False, str(e)

    # Security: Validate cache path is within allowed base directory
    try:
        user_base_dir = get_user_cache_base_dir()
        _validate_cache_path(cache_path, user_base_dir)
        logger.debug(
            f"Cache path security validation passed for user_{user_id}: {cache_path}"
        )
    except ValueError as e:
        logger.error(f"Cache path security validation failed: {e}")
        return False, f"Security error: {e}"

    try:
        # Check if cache directory exists
        if os.path.exists(cache_path):
            logger.info(
                f"Cache repository exists for user_id {user_id}: {cache_path}"
            )

            # Auto-update if enabled
            if is_auto_update_enabled():
                return update_cache_repo(cache_path, auth_url)
            else:
                logger.info("Cache auto-update is disabled, skipping update")
                return True, None
        else:
            # Create cache directory and parent directories
            logger.info(f"Creating cache repository for user_id {user_id}: {cache_path}")
            os.makedirs(os.path.dirname(cache_path), exist_ok=True)

            # Clone as bare repository
            cmd = ["git", "clone", "--bare", "--mirror"]

            # Add branch parameter only if specified
            if branch and branch.strip():
                cmd.extend(["--branch", branch])

            cmd.extend([auth_url, cache_path])

            logger.info(f"Creating bare cache: {' '.join(cmd)}")

            result = subprocess.run(
                cmd, capture_output=True, text=True, check=True, timeout=300
            )
            logger.info(f"Cache repository created: {cache_path}")

            return True, None

    except subprocess.CalledProcessError as e:
        error_msg = e.stderr if e.stderr else str(e)
        logger.error(f"Failed to create cache repository: {error_msg}")
        return False, error_msg
    except subprocess.TimeoutExpired:
        error_msg = f"Timeout creating cache repository after 300 seconds"
        logger.error(error_msg)
        return False, error_msg
    except Exception as e:
        logger.error(f"Unexpected error creating cache: {e}")
        return False, str(e)


def update_cache_repo(
    cache_path: str, auth_url: str = None
) -> tuple[bool, str]:
    """
    Update an existing cache repository by fetching from remote.

    Args:
        cache_path: Path to the cache repository
        auth_url: Authenticated git URL for fetching (optional, uses existing remote if not provided)

    Returns:
        Tuple (success, error_message):
        - On success: (True, None)
        - On failure: (False, error_message)
    """
    try:
        user_id = get_cache_user_id()
    except ValueError as e:
        logger.error(f"Cache user ID error: {e}")
        return False, str(e)

    try:
        logger.info(f"Updating cache repository for user_id {user_id}: {cache_path}")

        # If auth_url is provided, update the remote URL first
        # This ensures we use the latest token and avoid permission issues
        if auth_url:
            try:
                # Update origin remote URL with authenticated URL
                url_cmd = ["git", "remote", "set-url", "origin", auth_url]
                subprocess.run(
                    url_cmd, cwd=cache_path, capture_output=True, text=True, check=True, timeout=10
                )
                logger.debug(f"Updated remote URL for cache: {cache_path}")
            except Exception as e:
                logger.warning(f"Failed to update remote URL: {e}, continuing with existing URL")

        # Fetch from remote to update the cache
        # Use 'git fetch origin' instead of 'git fetch --all' to ensure we use the updated remote URL
        cmd = ["git", "fetch", "origin", "--prune"]

        result = subprocess.run(
            cmd, cwd=cache_path, capture_output=True, text=True, check=True, timeout=300
        )

        logger.info(f"Cache repository updated: {cache_path}")
        return True, None

    except subprocess.CalledProcessError as e:
        error_msg = e.stderr if e.stderr else str(e)
        logger.warning(f"Failed to update cache repository: {error_msg}")
        # Don't fail the operation if cache update fails
        # The cache can still be used as-is
        return True, None
    except subprocess.TimeoutExpired:
        logger.warning(f"Timeout updating cache repository after 300 seconds")
        # Don't fail the operation if cache update times out
        return True, None
    except Exception as e:
        logger.warning(f"Unexpected error updating cache: {e}")
        # Don't fail the operation if cache update fails
        return True, None
