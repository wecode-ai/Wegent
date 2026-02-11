# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import subprocess
from urllib.parse import quote, urlparse

from shared.logger import setup_logger
from shared.utils.crypto import decrypt_git_token, is_token_encrypted

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


def clone_repo(
    project_url, branch, project_path, user_name=None, token=None, repo_type=None
):
    """
    Clone repository to specified path

    Args:
        project_url: Git repository URL
        branch: Branch name to clone
        project_path: Local path to clone to
        user_name: Git username for authentication
        token: Git token for authentication
        repo_type: Repository type (github, gitlab, gitee, gitea, gerrit).
                   If provided and is 'gerrit', URL encoding will be applied to credentials.

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
            project_url, branch, project_path, user_name, token, repo_type
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


def clone_repo_with_token(
    project_url, branch, project_path, username, token, repo_type=None
):
    """
    Clone repository with authentication credentials.

    Args:
        project_url: Git repository URL
        branch: Branch name to clone
        project_path: Local path to clone to
        username: Git username for authentication
        token: Git token for authentication
        repo_type: Repository type (github, gitlab, gitee, gitea, gerrit).
                   If 'gerrit' or if URL contains 'gerrit', credentials will be URL encoded.

    Returns:
        Tuple (success, message):
        - On success: (True, None)
        - On failure: (False, error_message)
    """
    if project_url.startswith("https://") or project_url.startswith("http://"):
        protocol, rest = project_url.split("://", 1)

        # URL encode credentials for Gerrit repositories
        # Gerrit tokens may contain special characters like '/' that need encoding
        # Check both repo_type parameter and URL heuristics for maximum compatibility
        should_encode = (
            repo_type == "gerrit"
            if repo_type is not None
            else is_gerrit_url(project_url)
        )

        if should_encode:
            # URL encode username and token to handle special characters
            # safe='' means encode all special characters including /
            encoded_username = quote(username, safe="")
            encoded_token = quote(token, safe="")
            auth_url = f"{protocol}://{encoded_username}:{encoded_token}@{rest}"
            logger.debug(
                f"Using URL-encoded credentials for Gerrit repository (repo_type={repo_type})"
            )
        else:
            # For non-Gerrit repos (GitHub, GitLab, etc.), use credentials as-is
            auth_url = f"{protocol}://{username}:{token}@{rest}"
    else:
        auth_url = project_url

    # Log clone operation without exposing credentials
    logger.info(
        f"Git clone {project_url} to {project_path}, branch: {branch if branch else '(default)'}"
    )

    # Build basic command
    cmd = ["git", "clone"]

    # Add branch parameter only if branch is specified and not empty
    # When branch is empty/None, git will clone the repository's default branch
    if branch and branch.strip():
        cmd.extend(["--branch", branch, "--single-branch"])

    # Add URL and path
    cmd.extend([auth_url, project_path])
    try:
        # Use subprocess.run to capture output and errors
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        logger.info(f"git clone url: {project_url}, code: {result.returncode}")

        # Setup git hooks after successful clone
        setup_git_hooks(project_path)

        return True, None
    except subprocess.CalledProcessError as e:
        error_msg = e.stderr if e.stderr else str(e)
        logger.error(f"git clone failed: {error_msg}")
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
