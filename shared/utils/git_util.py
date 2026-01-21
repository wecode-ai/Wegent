# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import subprocess
from urllib.parse import quote, urlparse

from shared.logger import setup_logger
from shared.utils.crypto import decrypt_git_token, is_token_encrypted
from shared.utils.git_cache import (
    ensure_cache_repo,
    get_cache_repo_path,
    is_cache_enabled,
)

logger = setup_logger(__name__)


def get_repo_name_from_url(url):
    # Remove .git suffix if exists
    if url.endswith(".git"):
        url = url[:-4]  # Correctly remove '.git' suffix

    # Handle special path formats containing '/-/' (like tree structure or merge requests)
    if "/-/" in url:
        url = url.split("/-/")[0]

    parts = url.split("/")

    repo_name = parts[-1] if parts[-1] else parts[-2]
    return repo_name


def clone_repo(project_url, branch, project_path, user_name=None, token=None):
    """
    Clone repository to specified path

    Returns:
        Tuple (success, message):
        - On success: (True, None)
        - On failure: (False, error_message)
    """
    if not token or token == "***":
        token = get_git_token_from_url(project_url)
    elif is_token_encrypted(token):
        logger.debug(f"Decrypting git token for cloning repository")
        token = decrypt_git_token(token)

    if user_name is None:
        user_name = "token"
    logger.info(
        f"get git token from url: {project_url}, branch:{branch}, project:{project_path}"
    )
    if token:
        return clone_repo_with_token(
            project_url, branch, project_path, user_name, token
        )
    return False, "Token is not provided"


def get_domain_from_url(url):
    if "/-/" in url:
        url = url.split("/-/")[0]

    # Handle SSH format (ssh://git@domain.com:port/...)
    if url.startswith("ssh://"):
        url = url[6:]  # Remove ssh:// prefix

    # Handle git@domain.com: format
    if "@" in url and ":" in url:
        # Extract domain:port part
        return url.split("@")[1].split(":")[0]

    # Parse standard URL using urlparse
    parsed = urlparse("https://" + url if "://" not in url else url)

    return parsed.hostname if parsed.netloc else ""


def is_gerrit_url(url):
    """
    Check if the URL is a Gerrit repository URL.
    Gerrit URLs typically contain 'gerrit' in the domain name.

    Args:
        url: Git repository URL

    Returns:
        True if likely a Gerrit URL, False otherwise
    """

    url_lower = url.lower()

    # Gerrit URLs typically contain 'gerrit' in the domain
    # Examples: gerrit.example.com, code-review-gerrit.company.com, review.gerrit.internal
    if "gerrit" in url_lower:
        return True

    return False


def clone_repo_with_token(project_url, branch, project_path, username, token):
    """
    Clone repository with optional local cache support using --reference mode.

    If cache is enabled (GIT_CACHE_ENABLED=true), the function will:
    1. Create or update a local cache repository
    2. Use git clone --reference to reuse objects from cache
    3. Fall back to regular clone if cache fails

    Args:
        project_url: Repository URL
        branch: Branch to clone (optional)
        project_path: Local destination path
        username: Git username
        token: Git access token

    Returns:
        Tuple (success, error_message)
    """
    # Build authenticated URL
    if project_url.startswith("https://") or project_url.startswith("http://"):
        protocol, rest = project_url.split("://", 1)

        # Only URL encode credentials for Gerrit repositories
        # Gerrit passwords may contain special characters like '/' that need encoding
        # GitHub, GitLab, and Gitee don't have this issue
        if is_gerrit_url(project_url):
            # URL encode username and token to handle special characters
            # safe='' means encode all special characters including /
            encoded_username = quote(username, safe="")
            encoded_token = quote(token, safe="")
            auth_url = f"{protocol}://{encoded_username}:{encoded_token}@{rest}"
            logger.info(f"Auth URL: {auth_url}")
        else:
            # For non-Gerrit repos (GitHub, GitLab, etc.), use credentials as-is
            auth_url = f"{protocol}://{username}:{token}@{rest}"
    else:
        auth_url = project_url

    logger.info(
        f"Git clone {auth_url} to {project_path}, branch: {branch if branch else '(default)'}"
    )

    # Try with cache if enabled
    if is_cache_enabled():
        logger.info(f"Git cache is enabled, attempting clone with cache")
        cache_path = get_cache_repo_path(project_url)

        # Ensure cache repository exists and is up-to-date
        success, error = ensure_cache_repo(cache_path, auth_url, branch)
        if not success:
            logger.warning(
                f"Failed to prepare cache repository: {error}, falling back to regular clone"
            )
            return _clone_without_cache(
                project_url, branch, project_path, auth_url, username, token
            )

        # Try clone with --reference
        success, error = _clone_with_reference(
            project_url, branch, project_path, auth_url, cache_path
        )

        if success:
            # Setup git hooks after successful clone
            setup_git_hooks(project_path)
            return True, None
        else:
            logger.warning(
                f"Clone with reference failed: {error}, falling back to regular clone"
            )
            # Fall back to regular clone if --reference fails
            return _clone_without_cache(
                project_url, branch, project_path, auth_url, username, token
            )
    else:
        # Cache not enabled, do regular clone
        logger.info("Git cache is disabled, using regular clone")
        return _clone_without_cache(
            project_url, branch, project_path, auth_url, username, token
        )


def _clone_with_reference(
    project_url, branch, project_path, auth_url, cache_path
):
    """
    Clone repository using --reference to reuse objects from cache.

    Args:
        project_url: Original repository URL
        branch: Branch to clone
        project_path: Local destination path
        auth_url: Authenticated URL
        cache_path: Path to cache repository

    Returns:
        Tuple (success, error_message)
    """
    try:
        logger.info(f"Cloning with reference from cache: {cache_path}")

        # Build basic command with --reference
        cmd = ["git", "clone", "--reference", cache_path]

        # Add branch parameter only if branch is specified and not empty
        if branch and branch.strip():
            cmd.extend(["--branch", branch, "--single-branch"])

        # Add URL and path
        cmd.extend([auth_url, project_path])

        # Execute clone command
        result = subprocess.run(
            cmd, capture_output=True, text=True, check=True, timeout=600
        )

        logger.info(
            f"Successfully cloned with reference from cache: {project_url} -> {project_path}"
        )
        return True, None

    except subprocess.CalledProcessError as e:
        error_msg = e.stderr if e.stderr else str(e)
        logger.error(f"Clone with reference failed: {error_msg}")
        return False, error_msg
    except subprocess.TimeoutExpired:
        error_msg = "Clone with reference timed out after 600 seconds"
        logger.error(error_msg)
        return False, error_msg
    except Exception as e:
        logger.error(f"Clone with reference failed with unexpected error: {e}")
        return False, str(e)


def _clone_without_cache(
    project_url, branch, project_path, auth_url, username, token
):
    """
    Clone repository without using cache (regular clone).

    Args:
        project_url: Original repository URL
        branch: Branch to clone
        project_path: Local destination path
        auth_url: Authenticated URL
        username: Git username (for SSH fallback)
        token: Git token (for SSH fallback)

    Returns:
        Tuple (success, error_message)
    """
    try:
        logger.info("Performing regular clone without cache")

        # Build basic command
        cmd = ["git", "clone"]

        # Add branch parameter only if branch is specified and not empty
        if branch and branch.strip():
            cmd.extend(["--branch", branch, "--single-branch"])

        # Add URL and path
        cmd.extend([auth_url, project_path])

        # Execute clone command
        result = subprocess.run(
            cmd, capture_output=True, text=True, check=True, timeout=600
        )

        logger.info(f"git clone url: {project_url}, code: {result.returncode}")

        # Setup git hooks after successful clone
        setup_git_hooks(project_path)

        return True, None

    except subprocess.CalledProcessError as e:
        error_msg = e.stderr if e.stderr else str(e)
        logger.error(f"git clone failed: {error_msg}")
        return False, error_msg
    except subprocess.TimeoutExpired:
        error_msg = "Clone timed out after 600 seconds"
        logger.error(error_msg)
        return False, error_msg
    except Exception as e:
        logger.error(f"git clone failed with unexpected error: {e}")
        return False, str(e)


def get_git_token_from_url(git_url):
    domain = get_domain_from_url(git_url)
    if not domain:
        logger.error(f"get domain from url failed: {git_url}")
        raise Exception(f"get domain from url failed: {git_url}")

    token_file = f"/root/.ssh/{domain}"
    try:
        with open(token_file, "r") as f:
            token = f.read().strip()
            # Check if token is encrypted and decrypt if needed
            if is_token_encrypted(token):
                logger.debug(f"Decrypting git token from file for domain: {domain}")
                return decrypt_git_token(token)
            return token
    except IOError:
        raise Exception(f"get domain from file failed: {git_url}, file: {token_file}")


def get_project_path_from_url(url):

    # Handle special path formats containing '/-/'
    if "/-/" in url:
        url = url.split("/-/")[0]

    # Remove .git suffix if exists
    if url.endswith(".git"):
        url = url[:-4]

    # Handle SSH format (git@domain.com:user/repo)
    if "@" in url and ":" in url:
        # Extract user/repo part
        return url.split(":")[-1]

    # Parse standard URL using urlparse
    parsed = urlparse("https://" + url if "://" not in url else url)

    # Remove leading slash
    path = parsed.path
    if path.startswith("/"):
        path = path[1:]

    return path


def setup_git_hooks(repo_path):
    """
    Setup git hooks for a repository by configuring core.hooksPath
    to use the .githooks directory if it exists in the repository.

    This enables pre-push quality checks automatically after cloning.

    Args:
        repo_path: Path to the git repository

    Returns:
        Tuple (success, message):
        - On success: (True, None)
        - On failure: (False, error_message)
    """
    import os

    try:
        # Check if .githooks directory exists in the repository
        githooks_path = os.path.join(repo_path, ".githooks")
        if not os.path.isdir(githooks_path):
            logger.debug(
                f"No .githooks directory found in {repo_path}, skipping hooks setup"
            )
            return True, None

        # Configure git to use .githooks directory
        cmd = ["git", "config", "core.hooksPath", ".githooks"]
        subprocess.run(cmd, cwd=repo_path, capture_output=True, text=True, check=True)

        logger.info(
            f"Git hooks configured successfully in {repo_path}: core.hooksPath=.githooks"
        )
        return True, None
    except subprocess.CalledProcessError as e:
        error_msg = e.stderr if e.stderr else str(e)
        logger.error(f"Failed to setup git hooks: {error_msg}")
        return False, error_msg
    except Exception as e:
        logger.error(f"Failed to setup git hooks with unexpected error: {e}")
        return False, str(e)


def set_git_config(repo_path, name, email):
    """
    Set git config user.name and user.email for a repository

    Args:
        repo_path: Path to the git repository
        name: Git user name to set
        email: Git user email to set

    Returns:
        Tuple (success, message):
        - On success: (True, None)
        - On failure: (False, error_message)
    """
    try:
        # Set both user.name and user.email in a single command
        cmd = f'git config user.name "{name}" && git config user.email "{email}"'
        result = subprocess.run(
            cmd, cwd=repo_path, shell=True, capture_output=True, text=True, check=True
        )

        logger.info(
            f"Git config set successfully in {repo_path}: user.name={name}, user.email={email}"
        )
        return True, None
    except subprocess.CalledProcessError as e:
        error_msg = e.stderr if e.stderr else str(e)
        logger.error(f"Failed to set git config: {error_msg}")
        return False, error_msg
    except Exception as e:
        logger.error(f"Failed to set git config with unexpected error: {e}")
        return False, str(e)
