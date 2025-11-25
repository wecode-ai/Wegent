#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Task State Manager - Manages task execution state with cancellation support
"""

import threading
from enum import Enum
from typing import Dict, Optional
from datetime import datetime

from shared.logger import setup_logger

logger = setup_logger("task_state_manager")


class TaskState(Enum):
    """Task state enumeration"""
    RUNNING = "running"
    CANCELLING = "cancelling"
    CANCELLED = "cancelled"
    COMPLETED = "completed"
    FAILED = "failed"


class TaskStateManager:
    """
    Manages task execution state with cancellation support
    
    This is a singleton class for sharing task state across the application
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
        Set task state
        
        Args:
            task_id: Task ID
            state: Task state
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
        Get task state
        
        Args:
            task_id: Task ID
            
        Returns:
            Task state, returns None if task doesn't exist
        """
        with self._state_lock:
            return self._states.get(task_id)
    
    def is_cancelled(self, task_id: int) -> bool:
        """
        Check if task has been cancelled
        
        Args:
            task_id: Task ID
            
        Returns:
            True if task is in cancelling or cancelled state
        """
        state = self.get_state(task_id)
        return state in [TaskState.CANCELLING, TaskState.CANCELLED]
    
    def should_continue(self, task_id: int) -> bool:
        """
        Check if task should continue execution
        
        Args:
            task_id: Task ID
            
        Returns:
            True if task should continue execution
        """
        return not self.is_cancelled(task_id)
    
    def get_cancel_duration(self, task_id: int) -> Optional[float]:
        """
        Get duration since cancellation request (seconds)
        
        Args:
            task_id: Task ID
            
        Returns:
            Cancellation duration (seconds), returns None if task not cancelled
        """
        with self._state_lock:
            if task_id in self._cancel_timestamps:
                return (datetime.now() - self._cancel_timestamps[task_id]).total_seconds()
        return None
    
    def cleanup(self, task_id: int) -> None:
        """
        Clean up task state
        
        Args:
            task_id: Task ID
        """
        with self._state_lock:
            self._states.pop(task_id, None)
            self._cancel_timestamps.pop(task_id, None)
            logger.debug(f"Cleaned up state for task {task_id}")
    
    def get_all_states(self) -> Dict[int, TaskState]:
        """
        Get all task states (for debugging)
        
        Returns:
            Mapping of task ID to state
        """
        with self._state_lock:
            return self._states.copy()