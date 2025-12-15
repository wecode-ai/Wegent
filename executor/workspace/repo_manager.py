#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Repository Manager - Manages bare Git repositories.

Bare repositories are used to store Git objects without working files,
allowing multiple worktrees to share the same repository data.
"""

import os
import subprocess
from typing import Optional, Tuple
from urllib.parse import urlparse

from shared.logger import setup_logger
from shared.utils.crypto import is_token_encrypted, decrypt_git_token

logger = setup_logger("repo_manager")


class RepoManager:
    """
    Manages bare Git repositories.
    
    Bare repositories are stored in a structured directory hierarchy:
    /workspace/repos/{domain}/{org}/{repo}.git/
    """
    
    def __init__(self, repos_root: str = "/workspace/repos"):
        """
        Initialize the repository manager.
        
        Args:
            repos_root: Root directory for bare repositories
        """
        self.repos_root = repos_root
        os.makedirs(repos_root, exist_ok=True)
    
    def url_to_bare_path(self, git_url: str) -> str:
        """
        Convert a Git URL to a bare repository path.
        
        Args:
            git_url: Git repository URL (https or ssh format)
            
        Returns:
            Path to the bare repository
            
        Examples:
            https://github.com/org/repo.git -> /workspace/repos/github.com/org/repo.git
            git@gitlab.com:team/project.git -> /workspace/repos/gitlab.com/team/project.git
        """
        # Handle SSH format (git@domain:path)
        if git_url.startswith("git@"):
            # git@github.com:org/repo.git -> github.com/org/repo.git
            parts = git_url[4:].split(":", 1)
            domain = parts[0]
            path = parts[1] if len(parts) > 1 else ""
        else:
            # Parse HTTPS URL
            parsed = urlparse(git_url)
            domain = parsed.hostname or ""
            path = parsed.path.lstrip("/")
        
        # Ensure path ends with .git
        if not path.endswith(".git"):
            path = path + ".git"
        
        return os.path.join(self.repos_root, domain, path)
    
    def extract_repo_name(self, git_url: str) -> str:
        """
        Extract repository name from Git URL.
        
        Args:
            git_url: Git repository URL
            
        Returns:
            Repository name without .git suffix
        """
        # Remove .git suffix if present
        url = git_url.rstrip("/")
        if url.endswith(".git"):
            url = url[:-4]
        
        # Get the last path component
        return url.split("/")[-1]
    
    def ensure_bare_repo(
        self,
        git_url: str,
        git_token: Optional[str] = None,
        git_login: Optional[str] = None
    ) -> Tuple[bool, str, Optional[str]]:
        """
        Ensure a bare repository exists, cloning if necessary.
        
        Args:
            git_url: Git repository URL
            git_token: Optional Git authentication token
            git_login: Optional Git login username
            
        Returns:
            Tuple of (success, bare_repo_path, error_message)
        """
        bare_path = self.url_to_bare_path(git_url)
        
        if os.path.exists(bare_path):
            # Repository exists, fetch latest
            logger.info(f"Bare repository exists at {bare_path}, fetching updates")
            return self._fetch_repo(bare_path)
        
        # Clone as bare repository
        logger.info(f"Cloning bare repository from {git_url} to {bare_path}")
        return self._clone_bare(git_url, bare_path, git_token, git_login)
    
    def _clone_bare(
        self,
        git_url: str,
        bare_path: str,
        git_token: Optional[str] = None,
        git_login: Optional[str] = None
    ) -> Tuple[bool, str, Optional[str]]:
        """
        Clone a repository as bare.
        
        Args:
            git_url: Git repository URL
            bare_path: Path for the bare repository
            git_token: Optional Git authentication token
            git_login: Optional Git login username
            
        Returns:
            Tuple of (success, bare_repo_path, error_message)
        """
        # Create parent directory
        os.makedirs(os.path.dirname(bare_path), exist_ok=True)
        
        # Build authenticated URL if token provided
        clone_url = self._build_authenticated_url(git_url, git_token, git_login)
        
        try:
            result = subprocess.run(
                ["git", "clone", "--bare", clone_url, bare_path],
                capture_output=True,
                text=True,
                timeout=600  # 10 minutes timeout for large repos
            )
            
            if result.returncode != 0:
                error_msg = result.stderr or "Unknown error during clone"
                logger.error(f"Failed to clone bare repository: {error_msg}")
                return False, bare_path, error_msg
            
            logger.info(f"Successfully cloned bare repository to {bare_path}")
            return True, bare_path, None
            
        except subprocess.TimeoutExpired:
            error_msg = "Clone operation timed out"
            logger.error(error_msg)
            return False, bare_path, error_msg
        except Exception as e:
            error_msg = str(e)
            logger.error(f"Error cloning bare repository: {error_msg}")
            return False, bare_path, error_msg
    
    def _fetch_repo(self, bare_path: str) -> Tuple[bool, str, Optional[str]]:
        """
        Fetch updates for an existing bare repository.
        
        Args:
            bare_path: Path to the bare repository
            
        Returns:
            Tuple of (success, bare_repo_path, error_message)
        """
        try:
            result = subprocess.run(
                ["git", "-C", bare_path, "fetch", "--all", "--prune"],
                capture_output=True,
                text=True,
                timeout=300  # 5 minutes timeout
            )
            
            if result.returncode != 0:
                # Fetch failure is not critical, log warning but continue
                logger.warning(f"Failed to fetch updates: {result.stderr}")
            else:
                logger.info(f"Successfully fetched updates for {bare_path}")
            
            return True, bare_path, None
            
        except subprocess.TimeoutExpired:
            logger.warning("Fetch operation timed out, continuing with existing data")
            return True, bare_path, None
        except Exception as e:
            logger.warning(f"Error fetching updates: {e}, continuing with existing data")
            return True, bare_path, None
    
    def _build_authenticated_url(
        self,
        git_url: str,
        git_token: Optional[str] = None,
        git_login: Optional[str] = None
    ) -> str:
        """
        Build an authenticated Git URL.
        
        Args:
            git_url: Original Git URL
            git_token: Optional Git authentication token
            git_login: Optional Git login username
            
        Returns:
            Authenticated URL or original URL if no token
        """
        if not git_token:
            return git_url
        
        # Decrypt token if encrypted
        if is_token_encrypted(git_token):
            decrypted = decrypt_git_token(git_token)
            if decrypted:
                git_token = decrypted
        
        # Default login
        if not git_login:
            git_login = "oauth2"
        
        # Insert credentials into URL
        if git_url.startswith("https://"):
            return git_url.replace("https://", f"https://{git_login}:{git_token}@", 1)
        elif git_url.startswith("http://"):
            return git_url.replace("http://", f"http://{git_login}:{git_token}@", 1)
        
        # For SSH URLs, return as-is (authentication handled differently)
        return git_url
    
    def get_branches(self, bare_path: str) -> list:
        """
        Get list of branches in a bare repository.
        
        Args:
            bare_path: Path to the bare repository
            
        Returns:
            List of branch names
        """
        try:
            result = subprocess.run(
                ["git", "-C", bare_path, "branch", "-a"],
                capture_output=True,
                text=True,
                timeout=30
            )
            
            if result.returncode != 0:
                logger.warning(f"Failed to list branches: {result.stderr}")
                return []
            
            branches = []
            for line in result.stdout.strip().split("\n"):
                branch = line.strip().lstrip("* ")
                if branch and not branch.startswith("remotes/"):
                    branches.append(branch)
            
            return branches
            
        except Exception as e:
            logger.warning(f"Error listing branches: {e}")
            return []
    
    def branch_exists(self, bare_path: str, branch_name: str) -> bool:
        """
        Check if a branch exists in the repository.
        
        Args:
            bare_path: Path to the bare repository
            branch_name: Name of the branch to check
            
        Returns:
            True if branch exists, False otherwise
        """
        try:
            result = subprocess.run(
                ["git", "-C", bare_path, "rev-parse", "--verify", f"refs/heads/{branch_name}"],
                capture_output=True,
                text=True,
                timeout=10
            )
            return result.returncode == 0
        except Exception:
            return False
    
    def create_branch(
        self,
        bare_path: str,
        branch_name: str,
        base_branch: str = "main"
    ) -> Tuple[bool, Optional[str]]:
        """
        Create a new branch in the bare repository.
        
        Args:
            bare_path: Path to the bare repository
            branch_name: Name of the new branch
            base_branch: Base branch to create from (default: main)
            
        Returns:
            Tuple of (success, error_message)
        """
        try:
            # Try to find the base branch
            base_ref = None
            for ref in [f"refs/heads/{base_branch}", f"refs/remotes/origin/{base_branch}",
                       "refs/heads/master", "refs/remotes/origin/master"]:
                result = subprocess.run(
                    ["git", "-C", bare_path, "rev-parse", "--verify", ref],
                    capture_output=True,
                    text=True,
                    timeout=10
                )
                if result.returncode == 0:
                    base_ref = ref
                    break
            
            if not base_ref:
                return False, f"Could not find base branch: {base_branch}"
            
            # Create the new branch
            result = subprocess.run(
                ["git", "-C", bare_path, "branch", branch_name, base_ref],
                capture_output=True,
                text=True,
                timeout=30
            )
            
            if result.returncode != 0:
                return False, result.stderr or "Failed to create branch"
            
            logger.info(f"Created branch {branch_name} from {base_ref} in {bare_path}")
            return True, None
            
        except Exception as e:
            return False, str(e)
    
    def delete_repo(self, bare_path: str) -> bool:
        """
        Delete a bare repository.
        
        Args:
            bare_path: Path to the bare repository
            
        Returns:
            True if deleted successfully, False otherwise
        """
        import shutil
        
        try:
            if os.path.exists(bare_path):
                shutil.rmtree(bare_path)
                logger.info(f"Deleted bare repository: {bare_path}")
                return True
            return False
        except Exception as e:
            logger.error(f"Failed to delete bare repository: {e}")
            return False