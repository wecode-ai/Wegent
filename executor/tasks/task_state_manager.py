#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Task State Manager - 管理任务的运行状态，支持取消检查
"""

import threading
from enum import Enum
from typing import Dict, Optional
from datetime import datetime

from shared.logger import setup_logger

logger = setup_logger("task_state_manager")


class TaskState(Enum):
    """任务状态枚举"""
    RUNNING = "running"
    CANCELLING = "cancelling"
    CANCELLED = "cancelled"
    COMPLETED = "completed"
    FAILED = "failed"


class TaskStateManager:
    """
    管理任务的运行状态，支持取消检查
    
    这是一个单例类，用于在整个应用中共享任务状态
    """
    
    _instance: Optional['TaskStateManager'] = None
    _lock = threading.Lock()
    
    def __new__(cls):
        if not cls._instance:
            with cls._lock:
                if not cls._instance:
                    cls._instance = super().__new__(cls)
                    cls._instance._states: Dict[int, TaskState] = {}
                    cls._instance._cancel_timestamps: Dict[int, datetime] = {}
                    cls._instance._state_lock = threading.Lock()
        return cls._instance
    
    def set_state(self, task_id: int, state: TaskState) -> None:
        """
        设置任务状态
        
        Args:
            task_id: 任务ID
            state: 任务状态
        """
        with self._state_lock:
            old_state = self._states.get(task_id)
            self._states[task_id] = state
            
            if state == TaskState.CANCELLING:
                self._cancel_timestamps[task_id] = datetime.now()
                logger.info(f"Task {task_id} state changed: {old_state} -> {state}")
            elif state in [TaskState.CANCELLED, TaskState.COMPLETED, TaskState.FAILED]:
                logger.info(f"Task {task_id} state changed: {old_state} -> {state}")
    
    def get_state(self, task_id: int) -> Optional[TaskState]:
        """
        获取任务状态
        
        Args:
            task_id: 任务ID
            
        Returns:
            任务状态，如果任务不存在则返回 None
        """
        with self._state_lock:
            return self._states.get(task_id)
    
    def is_cancelled(self, task_id: int) -> bool:
        """
        检查任务是否已被取消
        
        Args:
            task_id: 任务ID
            
        Returns:
            如果任务处于取消中或已取消状态，返回 True
        """
        state = self.get_state(task_id)
        return state in [TaskState.CANCELLING, TaskState.CANCELLED]
    
    def should_continue(self, task_id: int) -> bool:
        """
        检查任务是否应该继续执行
        
        Args:
            task_id: 任务ID
            
        Returns:
            如果任务应该继续执行，返回 True
        """
        return not self.is_cancelled(task_id)
    
    def get_cancel_duration(self, task_id: int) -> Optional[float]:
        """
        获取取消请求已经持续的时间（秒）
        
        Args:
            task_id: 任务ID
            
        Returns:
            取消持续时间（秒），如果任务未被取消则返回 None
        """
        with self._state_lock:
            if task_id in self._cancel_timestamps:
                return (datetime.now() - self._cancel_timestamps[task_id]).total_seconds()
        return None
    
    def cleanup(self, task_id: int) -> None:
        """
        清理任务状态
        
        Args:
            task_id: 任务ID
        """
        with self._state_lock:
            self._states.pop(task_id, None)
            self._cancel_timestamps.pop(task_id, None)
            logger.debug(f"Cleaned up state for task {task_id}")
    
    def get_all_states(self) -> Dict[int, TaskState]:
        """
        获取所有任务的状态（用于调试）
        
        Returns:
            任务ID到状态的映射
        """
        with self._state_lock:
            return self._states.copy()