# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Git operations module for Claude Code agent.

Handles Git authentication, proxy configuration, and environment variables.
This module provides Git-related utilities for Claude Code agents.
"""

import json
import os
import subprocess
from typing import Any, Dict, Optional

from shared.logger import setup_logger
from shared.utils.crypto import decrypt_git_token, is_token_encrypted

logger = setup_logger("claude_code_git_operations")


def set_git_env_variables(task_data: Dict[str, Any]) -> Dict[str, str]:
    """Extract git-related fields from task_data and set them as environment variables.

    Args:
        task_data: The task data dictionary

    Returns:
        Dictionary of environment variables that were set
    """
    git_fields = {
        "git_domain": "GIT_DOMAIN",
        "git_repo": "GIT_REPO",
        "git_repo_id": "GIT_REPO_ID",
        "branch_name": "BRANCH_NAME",
        "git_url": "GIT_URL",
    }

    env_values = {}
    for source_key, env_key in git_fields.items():
        value = task_data.get(source_key)
        if value is not None:
            os.environ[env_key] = str(value)
            env_values[env_key] = value

    if env_values:
        logger.info("Set git environment variables")

    return env_values


def get_git_token(git_domain: str, task_data: Dict[str, Any]) -> Optional[str]:
    """Get Git token from task_data or SSH file.

    Args:
        git_domain: Git domain (e.g., github.com, gitlab.com)
        task_data: Task data dictionary

    Returns:
        Git token or None if not found
    """
    user_cfg = task_data.get("user", {})
    git_token = user_cfg.get("git_token")

    if git_token and git_token != "***":
        # Check if the token is encrypted and decrypt if needed
        if is_token_encrypted(git_token):
            logger.debug(f"Decrypting git token for domain: {git_domain}")
            return decrypt_git_token(git_token)
        return git_token.strip()

    token_path = os.path.expanduser(f"~/.ssh/{git_domain}")
    if os.path.exists(token_path):
        try:
            with open(token_path, "r", encoding="utf-8") as f:
                token = f.read().strip()
                # Check if the token is encrypted and decrypt if needed
                if is_token_encrypted(token):
                    logger.debug(
                        f"Decrypting git token from file for domain: {git_domain}"
                    )
                    return decrypt_git_token(token)
                return token
        except Exception as e:
            logger.warning(f"Failed to read token from {token_path}: {e}")
    return None


def configure_repo_proxy(git_domain: str) -> None:
    """Configure repository CLI proxy settings using REPO_PROXY_CONFIG env mapping.

    The REPO_PROXY_CONFIG environment variable should contain JSON with domains
    as keys and proxy definitions (http_proxy/https_proxy) as values.

    Args:
        git_domain: Git domain to configure proxy for
    """
    proxy_config_raw = os.getenv("REPO_PROXY_CONFIG")
    if not proxy_config_raw:
        logger.info(
            "No REPO_PROXY_CONFIG environment variable set, skipping proxy configuration."
        )
        return

    try:
        proxy_config = json.loads(proxy_config_raw)
    except json.JSONDecodeError as e:
        logger.warning(f"Invalid REPO_PROXY_CONFIG JSON: {e}")
        return

    domain_config = (
        proxy_config.get(git_domain)
        or proxy_config.get(git_domain.lower())
        or proxy_config.get("*")
    )
    if not isinstance(domain_config, dict):
        logger.info(f"No proxy configuration found for domain {git_domain}")
        return

    proxy_values = {
        key.lower(): value
        for key, value in domain_config.items()
        if key.lower() in {"http.proxy", "https.proxy"} and value
    }

    if not proxy_values:
        logger.info(f"Proxy configuration for domain {git_domain} is empty, skipping.")
        return

    for proxy_key, proxy_value in proxy_values.items():
        cmd = f"git config --global {proxy_key} {proxy_value}"
        try:
            subprocess.run(
                cmd,
                shell=True,
                capture_output=True,
                text=True,
                check=True,
            )
            logger.info(f"Configured environment {proxy_key} for domain {git_domain}")
        except subprocess.CalledProcessError as e:
            stderr = e.stderr.strip() if e.stderr else str(e)
            logger.warning(f"Proxy configuration failed: {stderr}")


def authenticate_cli(git_domain: str, git_token: str) -> bool:
    """Authenticate with Git CLI (GitHub CLI or GitLab CLI).

    Args:
        git_domain: Git domain
        git_token: Git authentication token

    Returns:
        True if authentication succeeded, False otherwise
    """
    is_github = "github" in git_domain.lower()

    if is_github:
        # GitHub CLI supports stdin token
        cmd = f'echo "{git_token}" | gh auth login --with-token'
    else:
        # GitLab CLI uses token flag
        cmd = f'glab auth login --hostname {git_domain} --token "{git_token}"'

    # Configure proxy before authentication
    configure_repo_proxy(git_domain)

    try:
        result = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            check=True,
        )
        logger.info(
            f"{'GitHub' if is_github else 'GitLab'} CLI authenticated for {git_domain}"
        )
        if result.stdout.strip():
            logger.debug(f"CLI output: {result.stdout.strip()}")
        return True

    except subprocess.CalledProcessError as e:
        stderr = e.stderr.strip() if e.stderr else str(e)
        logger.warning(f"CLI authentication failed for {git_domain}: {stderr}")
        return False
    except Exception as e:
        logger.warning(
            f"Unexpected error during CLI authentication for {git_domain}: {e}"
        )
        return False


def setup_git_authentication(task_data: Dict[str, Any]) -> None:
    """Setup complete Git authentication for a task.

    Sets environment variables, gets token, and authenticates CLI.

    Args:
        task_data: Task data dictionary
    """
    # Set git environment variables
    set_git_env_variables(task_data)

    # Configure GitLab/GitHub CLI authentication if git_domain is available
    git_domain = task_data.get("git_domain")
    if not git_domain:
        logger.warning("No git_domain provided, skipping CLI authentication.")
        return

    git_token = get_git_token(git_domain, task_data)
    if not git_token:
        logger.warning(
            f"No valid token found for {git_domain}, skipping authentication."
        )
        return

    authenticate_cli(git_domain, git_token)


def add_to_git_exclude(project_path: str, pattern: str) -> None:
    """Add a pattern to .git/info/exclude file.

    Args:
        project_path: Project root directory
        pattern: Pattern to exclude (e.g., "CLAUDE.md")
    """
    try:
        exclude_file = os.path.join(project_path, ".git", "info", "exclude")

        # Check if .git directory exists
        git_dir = os.path.join(project_path, ".git")
        if not os.path.exists(git_dir):
            logger.debug(".git directory does not exist, skipping git exclude update")
            return

        # Ensure .git/info directory exists
        info_dir = os.path.join(git_dir, "info")
        os.makedirs(info_dir, exist_ok=True)

        # Check if file exists and read content
        content = ""
        if os.path.exists(exclude_file):
            with open(exclude_file, "r", encoding="utf-8") as f:
                content = f.read()

        # Check if pattern already exists
        if pattern in content:
            logger.debug(f"Pattern '{pattern}' already in {exclude_file}")
            return

        # Append pattern
        with open(exclude_file, "a", encoding="utf-8") as f:
            if content and not content.endswith("\n"):
                f.write("\n")
            f.write(f"{pattern}\n")
        logger.info(f"Added '{pattern}' to .git/info/exclude")

    except Exception as e:
        logger.warning(f"Failed to add '{pattern}' to .git/info/exclude: {e}")


def setup_claude_md_symlink(project_path: str) -> None:
    """Setup CLAUDE.md symlink from Agents.md or AGENTS.md if it exists.

    Also adds CLAUDE.md to .git/info/exclude to prevent it from appearing in git diff.

    Args:
        project_path: Project root directory
    """
    try:
        # Try to find agents file with case-insensitive search
        agents_filename = None
        for filename in ["AGENTS.md", "Agents.md", "agents.md"]:
            agents_path = os.path.join(project_path, filename)
            if os.path.exists(agents_path):
                agents_filename = filename
                break

        if not agents_filename:
            logger.debug(
                "No agents.md file found (tried AGENTS.md, Agents.md, agents.md), "
                "skipping CLAUDE.md symlink creation"
            )
            return

        claude_md = os.path.join(project_path, "CLAUDE.md")

        # Remove existing CLAUDE.md if it exists
        if os.path.exists(claude_md):
            if os.path.islink(claude_md):
                os.unlink(claude_md)
                logger.debug("Removed existing CLAUDE.md symlink")
            else:
                logger.debug(
                    "CLAUDE.md already exists as a regular file, "
                    "skipping symlink creation"
                )
                return

        # Create symlink using the found filename
        os.symlink(agents_filename, claude_md)
        logger.info(f"Created CLAUDE.md symlink to {agents_filename}")

        # Add CLAUDE.md to .git/info/exclude
        add_to_git_exclude(project_path, "CLAUDE.md")

    except Exception as e:
        logger.warning(f"Failed to create CLAUDE.md symlink: {e}")
