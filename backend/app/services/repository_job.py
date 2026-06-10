# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Job for updating git repositories cache for all users

This task runs periodically, iterates through all users, and based on user's configured gitlab or github,
calls the _fetch_all_repositories_async method to keep the repository cache consistently updated.
"""

import logging
import time
from dataclasses import dataclass
from typing import Callable

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.kind import Kind
from app.repository.gitea_provider import GiteaProvider
from app.repository.gitee_provider import GiteeProvider
from app.repository.github_provider import GitHubProvider
from app.repository.gitlab_provider import GitLabProvider
from app.services.base import BaseService
from app.services.user import user_service

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RepositoryUserSnapshot:
    user_id: int
    user_name: str
    git_info: list[dict]

    @property
    def id(self) -> int:
        return self.user_id


class RepositoryJobService(BaseService[Kind, None, None]):
    """
    Job service for updating git repositories cache for all users
    """

    def __init__(self, model: type[Kind] = Kind):
        super().__init__(model)

    def load_repository_user_snapshots(
        self, db: Session
    ) -> list[RepositoryUserSnapshot]:
        users = user_service.get_all_users(db)
        return [
            RepositoryUserSnapshot(
                user_id=user.id,
                user_name=user.user_name,
                git_info=[dict(git_entry) for git_entry in (user.git_info or [])],
            )
            for user in users
        ]

    async def update_repositories_for_all_users(
        self,
        db_factory: Callable[[], Session] = SessionLocal,
    ) -> None:
        """
        Iterate through all users and update their git repositories cache

        Args:
            db_factory: Database session factory used only for loading snapshots
        """
        start_time = time.time()
        try:
            logger.info(f"[repository_job] Starting get all users task")

            db = db_factory()
            try:
                users = self.load_repository_user_snapshots(db)
            finally:
                db.close()

            # The patched version already handles token replacement, so we don't need to do it again
            logger.info(
                f"[repository_job] Found {len(users)} active users that need repository cache update"
            )

            # Record success and failure user counts
            success_count = 0
            failed_count = 0
            skipped_count = 0

            # Process each user
            for i, user in enumerate(users):
                try:
                    logger.info(
                        f"[repository_job] Processing user [{i+1}/{len(users)}] {user.user_name}"
                    )
                    result = await self._process_user_snapshot(user)
                    if result == "success":
                        success_count += 1
                    elif result == "skipped":
                        skipped_count += 1
                    else:
                        failed_count += 1
                except Exception as e:
                    logger.error(
                        f"[repository_job] Error processing user {user.user_name}: {str(e)}"
                    )
                    failed_count += 1
                    continue

            elapsed_time = time.time() - start_time
            logger.info(
                f"[repository_job] Repository cache update task completed, took {elapsed_time:.2f} seconds"
            )
            logger.info(
                f"[repository_job] Statistics: Success {success_count} users, Failed {failed_count} users, Skipped {skipped_count} users"
            )
        except Exception as e:
            elapsed_time = time.time() - start_time
            logger.error(
                f"[repository_job] Repository cache update task failed, took {elapsed_time:.2f} seconds, error: {e}"
            )

    async def _process_user_snapshot(self, user: RepositoryUserSnapshot) -> str:
        """
        Process a single user's git repositories

        Args:
            user: User snapshot

        Returns:
            "success" if at least one repository was updated
            "skipped" if user was skipped
            "failed" if all attempts failed
        """
        if not user.git_info:
            logger.info(
                f"[repository_job] User {user.user_name} has no git information configured, skipping"
            )
            return "skipped"

        logger.info(
            f"[repository_job] Processing repository cache for user {user.user_name}"
        )

        success = False
        # Process each git info entry
        for git_entry in user.git_info:
            git_type = git_entry.get("type")
            git_domain = git_entry.get("git_domain")
            git_token = git_entry.get("git_token")

            # Skip if missing required info
            if not git_type or not git_domain:
                logger.warning(
                    f"User {user.user_name}'s git configuration missing type or domain information, skipping"
                )
                continue

            # Skip if no token
            if not git_token:
                logger.warning(
                    f"User {user.user_name} domain {git_domain} has no token, skipping"
                )
                continue

            # Update repositories based on provider type
            try:
                start_time = time.time()
                if git_type == "github":
                    await self._update_github_repositories(user, git_token, git_domain)
                    elapsed = time.time() - start_time
                    logger.info(
                        f"[repository_job] Successfully updated GitHub repository cache for user {user.user_name}, domain {git_domain}, took {elapsed:.2f} seconds"
                    )
                    success = True
                elif git_type == "gitlab":
                    await self._update_gitlab_repositories(user, git_token, git_domain)
                    elapsed = time.time() - start_time
                    logger.info(
                        f"[repository_job] Successfully updated GitLab repository cache for user {user.user_name}, domain {git_domain}, took {elapsed:.2f} seconds"
                    )
                    success = True
                elif git_type == "gitee":
                    await self._update_gitee_repositories(user, git_token, git_domain)
                    elapsed = time.time() - start_time
                    logger.info(
                        f"[repository_job] Successfully updated Gitee repository cache for user {user.user_name}, domain {git_domain}, took {elapsed:.2f} seconds"
                    )
                    success = True
                elif git_type == "gitea":
                    await self._update_gitea_repositories(user, git_token, git_domain)
                    elapsed = time.time() - start_time
                    logger.info(
                        f"[repository_job] Successfully updated Gitea repository cache for user {user.user_name}, domain {git_domain}, took {elapsed:.2f} seconds"
                    )
                    success = True
                else:
                    logger.warning(
                        f"Unsupported git provider type: {git_type}, user {user.user_name}"
                    )
            except Exception as e:
                logger.error(
                    f"[repository_job] Failed to update repository cache for user {user.user_name} domain {git_domain}: {str(e)}"
                )

        return "success" if success else "failed"

    async def _update_github_repositories(
        self, user: RepositoryUserSnapshot, git_token: str, git_domain: str
    ) -> None:
        """
        Update GitHub repositories cache for a user

        Args:
            user: User object
            git_token: GitHub token
            git_domain: GitHub domain
        """
        provider = GitHubProvider()
        logger.info(
            f"[repository_job] Starting to update GitHub repository cache for user {user.user_name}, domain {git_domain}"
        )
        await provider._fetch_all_repositories_async(user, git_token, git_domain)

    async def _update_gitlab_repositories(
        self, user: RepositoryUserSnapshot, git_token: str, git_domain: str
    ) -> None:
        """
        Update GitLab repositories cache for a user

        Args:
            user: User object
            git_token: GitLab token
            git_domain: GitLab domain
        """
        provider = GitLabProvider()
        logger.info(
            f"[repository_job] Starting to update GitLab repository cache for user {user.user_name}, domain {git_domain}"
        )
        await provider._fetch_all_repositories_async(user, git_token, git_domain)

    async def _update_gitee_repositories(
        self, user: RepositoryUserSnapshot, git_token: str, git_domain: str
    ) -> None:
        """
        Update Gitee repositories cache for a user

        Args:
            user: User object
            git_token: Gitee token
            git_domain: Gitee domain
        """
        provider = GiteeProvider()
        logger.info(
            f"[repository_job] Starting to update Gitee repository cache for user {user.user_name}, domain {git_domain}"
        )
        await provider._fetch_all_repositories_async(user, git_token, git_domain)

    async def _update_gitea_repositories(
        self, user: RepositoryUserSnapshot, git_token: str, git_domain: str
    ) -> None:
        """
        Update Gitea repositories cache for a user

        Args:
            user: User object
            git_token: Gitea token
            git_domain: Gitea domain
        """
        provider = GiteaProvider()
        logger.info(
            f"[repository_job] Starting to update Gitea repository cache for user {user.user_name}, domain {git_domain}"
        )
        await provider._fetch_all_repositories_async(user, git_token, git_domain)


# Global instance
repository_job_service = RepositoryJobService(Kind)
