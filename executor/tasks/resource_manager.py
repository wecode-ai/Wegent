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
from typing import Dict, List, Callable, Any, Optional
from dataclasses import dataclass, field

from shared.logger import setup_logger

logger = setup_logger("resource_manager")


@dataclass
class ResourceHandle:
    """Resource handle"""
    resource_id: str
    cleanup_func: Callable
    cleanup_args: tuple = field(default_factory=tuple)
    cleanup_kwargs: dict = field(default_factory=dict)
    is_async: bool = False


class ResourceManager:
    """
    Manages task-related resources and ensures proper cleanup on cancellation
    
    This is a singleton class for sharing resource management across the application
    """
    
    _instance: Optional['ResourceManager'] = None
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
        self, 
        task_id: int, 
        resource_id: str,
        cleanup_func: Callable,
        cleanup_args: tuple = (),
        cleanup_kwargs: Optional[dict] = None,
        is_async: bool = False
    ) -> None:
        """
        Register resource that needs cleanup
        
        Args:
            task_id: Task ID
            resource_id: Unique resource identifier
            cleanup_func: Cleanup function
            cleanup_args: Positional arguments for cleanup function
            cleanup_kwargs: Keyword arguments for cleanup function
            is_async: Whether cleanup function is asynchronous
        """
        if cleanup_kwargs is None:
            cleanup_kwargs = {}
            
        with self._resource_lock:
            if task_id not in self._resources:
                self._resources[task_id] = []
            
            handle = ResourceHandle(
                resource_id=resource_id,
                cleanup_func=cleanup_func,
                cleanup_args=cleanup_args,
                cleanup_kwargs=cleanup_kwargs,
                is_async=is_async
            )
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
                    r for r in self._resources[task_id] 
                    if r.resource_id != resource_id
                ]
                if len(self._resources[task_id]) < original_count:
                    logger.debug(f"Unregistered resource '{resource_id}' for task {task_id}")
    
    async def cleanup_task_resources(self, task_id: int) -> None:
        """
        Clean up all resources for a task (async version)
        
        Args:
            task_id: Task ID
        """
        resources = []
        with self._resource_lock:
            resources = self._resources.pop(task_id, [])
        
        if not resources:
            logger.debug(f"No resources to cleanup for task {task_id}")
            return
        
        logger.info(f"Cleaning up {len(resources)} resources for task {task_id}")
        
        # Cleanup in reverse order, last registered cleaned up first
        for handle in reversed(resources):
            try:
                if handle.is_async:
                    await handle.cleanup_func(*handle.cleanup_args, **handle.cleanup_kwargs)
                else:
                    handle.cleanup_func(*handle.cleanup_args, **handle.cleanup_kwargs)
                logger.debug(f"Cleaned up resource '{handle.resource_id}' for task {task_id}")
            except Exception as e:
                logger.exception(f"Error cleaning up resource '{handle.resource_id}' for task {task_id}: {e}")
    
    def cleanup_task_resources_sync(self, task_id: int) -> None:
        """
        Clean up all resources for a task (sync version)
        
        Args:
            task_id: Task ID
        """
        try:
            # Try to get current event loop
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # If in async context, create task
                asyncio.create_task(self.cleanup_task_resources(task_id))
                logger.debug(f"Created async cleanup task for task {task_id}")
            else:
                # Otherwise run directly
                loop.run_until_complete(self.cleanup_task_resources(task_id))
        except RuntimeError:
            # No event loop, create new one
            asyncio.run(self.cleanup_task_resources(task_id))
    
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