#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Resource Manager - 管理任务相关的资源，确保在取消时能够正确清理
"""

import asyncio
import threading
from typing import Dict, List, Callable, Any, Optional
from dataclasses import dataclass, field

from shared.logger import setup_logger

logger = setup_logger("resource_manager")


@dataclass
class ResourceHandle:
    """资源句柄"""
    resource_id: str
    cleanup_func: Callable
    cleanup_args: tuple = field(default_factory=tuple)
    cleanup_kwargs: dict = field(default_factory=dict)
    is_async: bool = False


class ResourceManager:
    """
    管理任务相关的资源，确保在取消时能够正确清理
    
    这是一个单例类，用于在整个应用中共享资源管理
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
        注册需要清理的资源
        
        Args:
            task_id: 任务ID
            resource_id: 资源唯一标识
            cleanup_func: 清理函数
            cleanup_args: 清理函数的位置参数
            cleanup_kwargs: 清理函数的关键字参数
            is_async: 清理函数是否是异步的
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
        取消注册资源
        
        Args:
            task_id: 任务ID
            resource_id: 资源唯一标识
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
        清理任务的所有资源（异步版本）
        
        Args:
            task_id: 任务ID
        """
        resources = []
        with self._resource_lock:
            resources = self._resources.pop(task_id, [])
        
        if not resources:
            logger.debug(f"No resources to cleanup for task {task_id}")
            return
        
        logger.info(f"Cleaning up {len(resources)} resources for task {task_id}")
        
        # 反向清理，后注册的先清理
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
        清理任务的所有资源（同步版本）
        
        Args:
            task_id: 任务ID
        """
        try:
            # 尝试获取当前事件循环
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # 如果在异步上下文中，创建任务
                asyncio.create_task(self.cleanup_task_resources(task_id))
                logger.debug(f"Created async cleanup task for task {task_id}")
            else:
                # 否则直接运行
                loop.run_until_complete(self.cleanup_task_resources(task_id))
        except RuntimeError:
            # 没有事件循环，创建新的
            asyncio.run(self.cleanup_task_resources(task_id))
    
    def get_resource_count(self, task_id: int) -> int:
        """
        获取任务注册的资源数量
        
        Args:
            task_id: 任务ID
            
        Returns:
            资源数量
        """
        with self._resource_lock:
            return len(self._resources.get(task_id, []))
    
    def has_resources(self, task_id: int) -> bool:
        """
        检查任务是否有注册的资源
        
        Args:
            task_id: 任务ID
            
        Returns:
            如果有资源返回 True
        """
        return self.get_resource_count(task_id) > 0