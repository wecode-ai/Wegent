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

# Default cache directory
DEFAULT_CACHE_DIR = "/git-cache"

# Environment variables
ENV_CACHE_ENABLED = "GIT_CACHE_ENABLED"
ENV_CACHE_DIR = "GIT_CACHE_DIR"
ENV_CACHE_AUTO_UPDATE = "GIT_CACHE_AUTO_UPDATE"
ENV_CACHE_USER_ID = "GIT_CACHE_USER_ID"


def is_cache_enabled() -> bool:
    """
    Check if git cache is enabled via environment variable.

    Returns:
        True if cache is enabled, False otherwise.
    """
    return os.getenv(ENV_CACHE_ENABLED, "false").lower() == "true"


def get_cache_dir() -> str:
    """
    Get the cache directory from environment variable or use default.

    Returns:
        Cache directory path.
    """
    return os.getenv(ENV_CACHE_DIR, DEFAULT_CACHE_DIR)


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


def get_cache_repo_path(url: str, cache_dir: str = None) -> str:
    """
    Calculate the cache repository path for a given URL with user ID isolation.

    The cache path is structured as: {cache_dir}/user_{user_id}/{domain}/{path}.git

    Args:
        url: Git repository URL
        cache_dir: Cache directory (uses default if not provided)

    Returns:
        Path to the cache repository

    Raises:
        ValueError: If GIT_CACHE_USER_ID is not set

    Examples:
        >>> get_cache_repo_path("https://github.com/user/repo.git")
        "/git-cache/user_123/github.com/user/repo.git"

        >>> get_cache_repo_path("git@gitlab.com:group/project.git")
        "/git-cache/user_456/gitlab.com/group/project.git"
    """
    if cache_dir is None:
        cache_dir = get_cache_dir()

    # Get user ID (required, will raise ValueError if not set)
    user_id = get_cache_user_id()

    # Use user_id for isolation: user_{user_id}
    user_dir = f"user_{user_id}"

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

    # Construct cache path with user_id isolation
    cache_path = os.path.join(cache_dir, user_dir, domain, f"{path}.git")

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

    try:
        # Check if cache directory exists
        if os.path.exists(cache_path):
            logger.info(
                f"Cache repository exists for user_id {user_id}: {cache_path}"
            )

            # Auto-update if enabled
            if is_auto_update_enabled():
                return update_cache_repo(cache_path, branch, auth_url)
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
    cache_path: str, branch: str = None, auth_url: str = None
) -> tuple[bool, str]:
    """
    Update an existing cache repository by fetching from remote.

    Args:
        cache_path: Path to the cache repository
        branch: Branch to fetch (optional, fetches all if not specified)
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


def get_reference_path(url: str) -> tuple[str | None, str | None]:
    """
    Get the reference path for --reference mode if cache is enabled.

    This is the main entry point for cache functionality.

    Args:
        url: Git repository URL

    Returns:
        Tuple (cache_path, auth_url):
        - cache_path: Path to cache repository if enabled and valid, None otherwise
        - auth_url: None if cache should be used (caller will skip auth), original URL if cache disabled

    Examples:
        >>> # Cache disabled
        >>> get_reference_path("https://github.com/user/repo.git")
        (None, "https://github.com/user/repo.git")

        >>> # Cache enabled
        >>> get_reference_path("https://github.com/user/repo.git")
        ("/git-cache/github.com/user/repo.git", None)
    """
    if not is_cache_enabled():
        logger.debug("Git cache is disabled")
        return None, url

    cache_dir = get_cache_dir()

    # Ensure cache directory exists
    try:
        os.makedirs(cache_dir, exist_ok=True)
    except Exception as e:
        logger.warning(f"Failed to create cache directory {cache_dir}: {e}")
        return None, url

    cache_path = get_cache_repo_path(url, cache_dir)

    logger.info(f"Git cache enabled, cache path: {cache_path}")

    return cache_path, None
