#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Status Synchronizer - 确保任务状态在取消时正确同步到后端
"""

import asyncio
from typing import Optional

from shared.logger import setup_logger
from executor.callback.callback_client import CallbackClient

logger = setup_logger("status_sync")


class StatusSynchronizer:
    """确保任务状态在取消时正确同步到后端"""
    
    def __init__(self, callback_client: Optional[CallbackClient] = None):
        """
        初始化状态同步器
        
        Args:
            callback_client: 回调客户端，如果不提供则创建新的
        """
        self.callback_client = callback_client or CallbackClient()
    
    async def sync_cancel_status(
        self, 
        task_id: int, 
        subtask_id: int,
        executor_name: Optional[str] = None
    ) -> bool:
        """
        同步取消状态到后端（异步版本）
        
        Args:
            task_id: 任务ID
            subtask_id: 子任务ID
            executor_name: 执行器名称
            
        Returns:
            是否同步成功
        """
        try:
            # 发送取消状态更新
            success = await self.callback_client.report_progress_async(
                task_id=task_id,
                subtask_id=subtask_id,
                progress=100,
                status="CANCELLED",
                executor_name=executor_name,
                error_message="Task was cancelled by user"
            )
            
            if success:
                logger.info(f"Successfully synced cancel status for task {task_id}")
            else:
                logger.warning(f"Failed to sync cancel status for task {task_id}")
            
            return success
            
        except Exception as e:
            logger.exception(f"Error syncing cancel status for task {task_id}: {e}")
            return False
    
    def sync_cancel_status_sync(
        self, 
        task_id: int, 
        subtask_id: int,
        executor_name: Optional[str] = None
    ) -> bool:
        """
        同步取消状态到后端（同步版本）
        
        Args:
            task_id: 任务ID
            subtask_id: 子任务ID
            executor_name: 执行器名称
            
        Returns:
            是否同步成功
        """
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # 在异步上下文中创建任务
                asyncio.create_task(
                    self.sync_cancel_status(task_id, subtask_id, executor_name)
                )
                return True  # 异步执行，返回 True
            else:
                return loop.run_until_complete(
                    self.sync_cancel_status(task_id, subtask_id, executor_name)
                )
        except RuntimeError:
            return asyncio.run(
                self.sync_cancel_status(task_id, subtask_id, executor_name)
            )
    
    async def sync_status(
        self,
        task_id: int,
        subtask_id: int,
        progress: int,
        status: str,
        executor_name: Optional[str] = None,
        error_message: Optional[str] = None
    ) -> bool:
        """
        同步任意状态到后端（异步版本）
        
        Args:
            task_id: 任务ID
            subtask_id: 子任务ID
            progress: 进度（0-100）
            status: 状态
            executor_name: 执行器名称
            error_message: 错误消息
            
        Returns:
            是否同步成功
        """
        try:
            success = await self.callback_client.report_progress_async(
                task_id=task_id,
                subtask_id=subtask_id,
                progress=progress,
                status=status,
                executor_name=executor_name,
                error_message=error_message
            )
            
            if success:
                logger.debug(f"Successfully synced status '{status}' for task {task_id}")
            else:
                logger.warning(f"Failed to sync status '{status}' for task {task_id}")
            
            return success
            
        except Exception as e:
            logger.exception(f"Error syncing status for task {task_id}: {e}")
            return False