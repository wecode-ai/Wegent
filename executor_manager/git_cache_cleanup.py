#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Git Cache Volume Cleanup Module

Periodically cleans up inactive user volumes to free disk space.
"""

import os
from datetime import datetime, timedelta
from typing import Dict, Set

from shared.logger import setup_logger

logger = setup_logger(__name__)


class GitCacheCleanupManager:
    """
    Manages periodic cleanup of inactive git cache volumes.

    Cleanup policies:
    1. Age-based: Delete volumes not used in X days
    2. Size-based: Optionally delete largest volumes when disk is full
    3. Whitelist: Never delete volumes for protected users
    """

    def __init__(self):
        """Initialize cleanup manager with configuration"""
        # Read configuration from environment
        self.enabled = os.getenv("GIT_CACHE_CLEANUP_ENABLED", "false").lower() == "true"
        self.inactive_days = int(os.getenv("GIT_CACHE_INACTIVE_DAYS", "30"))
        self.dry_run = os.getenv("GIT_CACHE_CLEANUP_DRY_RUN", "false").lower() == "true"
        self.protected_users = self._load_protected_users()

        logger.info(
            f"Git cache cleanup initialized: enabled={self.enabled}, "
            f"inactive_days={self.inactive_days}, dry_run={self.dry_run}"
        )

    def _load_protected_users(self) -> Set[int]:
        """
        Load list of protected user IDs that should never have their volumes deleted.

        Reads from GIT_CACHE_PROTECTED_USERS environment variable (comma-separated).

        Returns:
            Set of protected user IDs
        """
        protected_str = os.getenv("GIT_CACHE_PROTECTED_USERS", "")
        if not protected_str:
            return set()

        try:
            protected_ids = [int(uid.strip()) for uid in protected_str.split(",")]
            logger.info(f"Protected users: {protected_ids}")
            return set(protected_ids)
        except ValueError as e:
            logger.warning(f"Invalid GIT_CACHE_PROTECTED_USERS value: {e}")
            return set()

    def cleanup_inactive_volumes(self) -> Dict[str, any]:
        """
        Clean up volumes that haven't been used in configured days.

        Returns:
            Dictionary with cleanup results:
            {
                "deleted_volumes": [volume_names],
                "protected_volumes": [volume_names],
                "total_freed_space": bytes,
                "errors": [error_messages]
            }
        """
        from executor_manager.executors.docker.git_cache_volume_manager import (
            list_user_volumes,
            delete_volume,
            get_volume_size,
        )

        if not self.enabled:
            logger.info("Git cache cleanup is disabled, skipping")
            return {
                "deleted_volumes": [],
                "protected_volumes": [],
                "total_freed_space": 0,
                "errors": [],
            }

        logger.info(f"Starting cleanup of volumes inactive for {self.inactive_days}+ days")

        deleted_volumes = []
        protected_volumes = []
        total_freed_space = 0
        errors = []

        # Get all user volumes
        user_volumes = list_user_volumes()

        # Calculate cutoff date
        cutoff_date = datetime.utcnow() - timedelta(days=self.inactive_days)

        for user_id, metadata in user_volumes.items():
            volume_name = metadata["volume_name"]
            last_used_str = metadata.get("last_used", "")

            # Check if user is protected
            if user_id in self.protected_users:
                logger.info(f"Volume {volume_name} is protected (user {user_id}), skipping")
                protected_volumes.append(volume_name)
                continue

            # Parse last used date
            try:
                if last_used_str:
                    last_used = datetime.fromisoformat(last_used_str)
                else:
                    # If no last_used label, use created_at
                    created_at_str = metadata.get("created_at", "")
                    if created_at_str:
                        last_used = datetime.fromisoformat(created_at_str)
                    else:
                        logger.warning(f"Volume {volume_name} has no date labels, skipping")
                        continue
            except ValueError as e:
                logger.warning(f"Invalid date format for volume {volume_name}: {e}")
                continue

            # Check if volume is inactive
            if last_used < cutoff_date:
                logger.info(
                    f"Volume {volume_name} (user {user_id}) is inactive "
                    f"(last used: {last_used.isoformat()})"
                )

                # Get size before deletion
                size = get_volume_size(volume_name)

                if self.dry_run:
                    logger.info(f"DRY RUN: Would delete volume {volume_name} ({size} bytes)")
                    deleted_volumes.append(volume_name)
                    total_freed_space += size or 0
                else:
                    # Actually delete the volume
                    success, error_msg = delete_volume(volume_name)
                    if success:
                        logger.info(f"Deleted volume {volume_name} ({size} bytes freed)")
                        deleted_volumes.append(volume_name)
                        total_freed_space += size or 0
                    else:
                        error = f"Failed to delete {volume_name}: {error_msg}"
                        logger.error(error)
                        errors.append(error)
            else:
                logger.debug(f"Volume {volume_name} is still active (last used: {last_used.isoformat()})")

        result = {
            "deleted_volumes": deleted_volumes,
            "protected_volumes": protected_volumes,
            "total_freed_space": total_freed_space,
            "errors": errors,
        }

        logger.info(
            f"Cleanup complete: deleted {len(deleted_volumes)} volumes, "
            f"freed {total_freed_space} bytes, {len(errors)} errors"
        )

        return result

    def get_volume_stats(self) -> Dict[str, any]:
        """
        Get statistics about git cache volumes.

        Returns:
            Dictionary with volume statistics
        """
        from executor_manager.executors.docker.git_cache_volume_manager import (
            list_user_volumes,
            get_volume_size,
        )

        user_volumes = list_user_volumes()

        total_volumes = len(user_volumes)
        total_size = 0
        inactive_count = 0
        cutoff_date = datetime.utcnow() - timedelta(days=self.inactive_days)

        for user_id, metadata in user_volumes.items():
            volume_name = metadata["volume_name"]

            # Get volume size
            size = get_volume_size(volume_name)
            total_size += size or 0

            # Check if inactive
            last_used_str = metadata.get("last_used", "")
            if last_used_str:
                try:
                    last_used = datetime.fromisoformat(last_used_str)
                    if last_used < cutoff_date:
                        inactive_count += 1
                except ValueError:
                    pass

        return {
            "total_volumes": total_volumes,
            "total_size_bytes": total_size,
            "total_size_mb": total_size / (1024 * 1024),
            "inactive_volumes": inactive_count,
            "inactive_threshold_days": self.inactive_days,
        }
