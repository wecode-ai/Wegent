#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Resource Manager - Manages task-related resources and ensures proper cleanup on cancellation
"""

import asyncio
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from shared.logger import setup_logger

logger = setup_logger("resource_manager")


@dataclass
class ResourceHandle:
    """Resource handle"""

    resource_id: str
    is_async: bool = False


class ResourceManager:
    """
    Manages task-related resources and ensures proper cleanup on cancellation

    This is a singleton class for sharing resource management across the application
    """

    _instance: Optional["ResourceManager"] = None
    _lock = threading.Lock()

    def __new__(cls):
        if not cls._instance:
            with cls._lock:
                if not cls._instance:
                    cls._instance = super().__new__(cls)
                    cls._instance._resources: Dict[int, List[ResourceHandle]] = {}
                    cls._instance._resource_lock = threading.Lock()
        return cls._instance

    def register_resource(
        self, task_id: int, resource_id: str, is_async: bool = False
    ) -> None:
        """
        Register resource that needs cleanup

        Args:
            task_id: Task ID
            resource_id: Unique resource identifier
            is_async: Whether cleanup function is asynchronous
        """

        with self._resource_lock:
            if task_id not in self._resources:
                self._resources[task_id] = []

            handle = ResourceHandle(resource_id=resource_id, is_async=is_async)
            self._resources[task_id].append(handle)
            logger.debug(f"Registered resource '{resource_id}' for task {task_id}")

    def unregister_resource(self, task_id: int, resource_id: str) -> None:
        """
        Unregister resource

        Args:
            task_id: Task ID
            resource_id: Unique resource identifier
        """
        with self._resource_lock:
            if task_id in self._resources:
                original_count = len(self._resources[task_id])
                self._resources[task_id] = [
                    r for r in self._resources[task_id] if r.resource_id != resource_id
                ]
                if len(self._resources[task_id]) < original_count:
                    logger.debug(
                        f"Unregistered resource '{resource_id}' for task {task_id}"
                    )

    def get_resource_count(self, task_id: int) -> int:
        """
        Get count of registered resources for a task

        Args:
            task_id: Task ID

        Returns:
            Resource count
        """
        with self._resource_lock:
            return len(self._resources.get(task_id, []))

    def has_resources(self, task_id: int) -> bool:
        """
        Check if task has registered resources

        Args:
            task_id: Task ID

        Returns:
            True if resources exist
        """
        return self.get_resource_count(task_id) > 0
