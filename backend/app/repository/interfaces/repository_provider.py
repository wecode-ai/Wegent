# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Repository provider interface, defining methods related to code repositories
"""
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

from shared.utils.crypto import decrypt_git_token, encrypt_git_token, is_token_encrypted

from app.models.user import User


class RepositoryProvider(ABC):
    """
    Repository provider interface, defining methods related to code repositories
    Different code repository services (GitHub, GitLab, etc.) need to implement this interface
    """

    @abstractmethod
    async def get_repositories(
        self, user: User, page: int = 1, limit: int = 100
    ) -> List[Dict[str, Any]]:
        """
        Get the user's repository list

        Args:
            user: User object
            page: Page number
            limit: Number per page

        Returns:
            Repository list

        Raises:
            HTTPException: Exception thrown when fetching fails
        """

    @abstractmethod
    async def get_branches(
        self, user: User, repo_name: str, git_domain: str
    ) -> List[Dict[str, Any]]:
        """
        Get the branch list of the specified repository

        Args:
            user: User object
            repo_name: Repository name

        Returns:
            Branch list

        Raises:
            HTTPException: Exception thrown when fetching fails
        """

    def encrypt_token(self, token: str) -> str:
        if self._is_token_encrypted(token):
            return token
        return encrypt_git_token(token)

    def decrypt_token(self, token: str) -> str:
        if self._is_token_encrypted(token):
            return decrypt_git_token(token)
        return token

    def _is_token_encrypted(self, token: str) -> bool:
        return is_token_encrypted(token)

    @abstractmethod
    def validate_token(self, token: str) -> Dict[str, Any]:
        """
        Validate code repository token

        Args:
            token: Code repository token

        Returns:
            Validation result, including whether it's valid, user information, etc.

        Raises:
            HTTPException: Exception thrown when validation fails
        """

    @abstractmethod
    async def search_repositories(
        self, user: User, query: str, timeout: int = 30
    ) -> List[Dict[str, Any]]:
        """
        Search the user's code repositories

        Args:
            user: User object
            query: Search keyword
            timeout: Timeout (seconds)

        Returns:
            Search results

        Raises:
            HTTPException: Exception thrown when search fails
        """

    @abstractmethod
    async def get_branch_diff(
        self,
        user: User,
        repo_name: str,
        source_branch: str,
        target_branch: str,
        git_domain: str,
    ) -> Dict[str, Any]:
        """
        Get diff between two branches for a repository

        Args:
            user: User object
            repo_name: Repository name
            source_branch: Source branch name
            target_branch: Target branch name
            git_domain: Git domain

        Returns:
            Diff information including files changed and diff content

        Raises:
            HTTPException: Exception thrown when getting diff fails
        """
