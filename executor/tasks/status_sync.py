#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Status Synchronizer - Ensures task status is correctly synchronized to backend on cancellation
"""

import asyncio
from typing import Optional

from shared.logger import setup_logger
from executor.callback.callback_client import CallbackClient

logger = setup_logger("status_sync")


class StatusSynchronizer:
    """Ensures task status is correctly synchronized to backend on cancellation"""
    
    def __init__(self, callback_client: Optional[CallbackClient] = None):
        """
        Initialize status synchronizer
        
        Args:
            callback_client: Callback client, creates new one if not provided
        """
        self.callback_client = callback_client or CallbackClient()
    
    async def sync_cancel_status(
        self, 
        task_id: int, 
        subtask_id: int,
        executor_name: Optional[str] = None
    ) -> bool:
        """
        Synchronize cancel status to backend (async version)
        
        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            executor_name: Executor name
            
        Returns:
            Whether synchronization was successful
        """
        try:
            # Send cancel status update
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
        Synchronize cancel status to backend (sync version)
        
        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            executor_name: Executor name
            
        Returns:
            Whether synchronization was successful
        """
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # Create task in async context
                asyncio.create_task(
                    self.sync_cancel_status(task_id, subtask_id, executor_name)
                )
                return True  # Async execution, return True
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
        Synchronize any status to backend (async version)
        
        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            progress: Progress (0-100)
            status: Status
            executor_name: Executor name
            error_message: Error message
            
        Returns:
            Whether synchronization was successful
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