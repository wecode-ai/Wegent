#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Cancel Handler - Handles retry and timeout logic for task cancellation
"""

import asyncio
import time
from typing import Callable, Optional
from dataclasses import dataclass
from enum import Enum

from shared.logger import setup_logger

logger = setup_logger("cancel_handler")

# Default configuration
DEFAULT_CANCEL_TIMEOUT_SECONDS = 30
DEFAULT_CANCEL_RETRY_ATTEMPTS = 3
DEFAULT_CANCEL_RETRY_DELAY = 2
DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT = 10


class CancelMethod(Enum):
    """Cancel method enumeration"""
    SDK_INTERRUPT = "sdk_interrupt"
    API_CANCEL = "api_cancel"
    CONTAINER_STOP = "container_stop"
    CONTAINER_FORCE_REMOVE = "container_force_remove"


@dataclass
class CancelResult:
    """Cancel result"""
    success: bool
    method: CancelMethod
    message: str
    attempts: int = 1
    duration: float = 0.0


class CancelHandler:
    """Handles retry and timeout logic for task cancellation"""
    
    def __init__(
        self,
        max_attempts: int = DEFAULT_CANCEL_RETRY_ATTEMPTS,
        retry_delay: int = DEFAULT_CANCEL_RETRY_DELAY,
        timeout: int = DEFAULT_CANCEL_TIMEOUT_SECONDS
    ):
        """
        Initialize cancel handler
        
        Args:
            max_attempts: Maximum retry attempts
            retry_delay: Retry delay (seconds)
            timeout: Timeout duration (seconds)
        """
        self.max_attempts = max_attempts
        self.retry_delay = retry_delay
        self.timeout = timeout
    
    async def cancel_with_retry(
        self,
        cancel_func: Callable,
        task_id: int,
        method: CancelMethod,
        verify_func: Optional[Callable] = None
    ) -> CancelResult:
        """
        Cancel operation with retry
        
        Args:
            cancel_func: Cancel function
            task_id: Task ID
            method: Cancel method
            verify_func: Verification function to confirm cancellation success
            
        Returns:
            Cancel result
        """
        start_time = time.time()
        
        for attempt in range(1, self.max_attempts + 1):
            try:
                logger.info(
                    f"Attempting to cancel task {task_id} using {method.value} "
                    f"(attempt {attempt}/{self.max_attempts})"
                )
                
                # Execute cancel operation
                if asyncio.iscoroutinefunction(cancel_func):
                    result = await cancel_func()
                else:
                    result = cancel_func()
                
                # If verification function is provided, verify cancellation success
                if verify_func:
                    await asyncio.sleep(1)  # Wait one second for status update
                    
                    if asyncio.iscoroutinefunction(verify_func):
                        verified = await verify_func()
                    else:
                        verified = verify_func()
                    
                    if verified:
                        duration = time.time() - start_time
                        logger.info(
                            f"Task {task_id} cancelled successfully using {method.value} "
                            f"after {attempt} attempts ({duration:.2f}s)"
                        )
                        return CancelResult(
                            success=True,
                            method=method,
                            message=f"Cancelled using {method.value}",
                            attempts=attempt,
                            duration=duration
                        )
                    else:
                        logger.warning(
                            f"Cancel verification failed for task {task_id} (attempt {attempt})"
                        )
                else:
                    # No verification function, assume success
                    duration = time.time() - start_time
                    return CancelResult(
                        success=True,
                        method=method,
                        message=f"Cancelled using {method.value}",
                        attempts=attempt,
                        duration=duration
                    )
                
                # If not the last attempt, wait and retry
                if attempt < self.max_attempts:
                    logger.info(
                        f"Retrying cancel for task {task_id} in {self.retry_delay} seconds..."
                    )
                    await asyncio.sleep(self.retry_delay)
                
            except Exception as e:
                logger.exception(
                    f"Error during cancel attempt {attempt} for task {task_id}: {e}"
                )
                
                if attempt < self.max_attempts:
                    await asyncio.sleep(self.retry_delay)
                else:
                    duration = time.time() - start_time
                    return CancelResult(
                        success=False,
                        method=method,
                        message=f"Failed after {attempt} attempts: {str(e)}",
                        attempts=attempt,
                        duration=duration
                    )
        
        duration = time.time() - start_time
        return CancelResult(
            success=False,
            method=method,
            message=f"Failed after {self.max_attempts} attempts",
            attempts=self.max_attempts,
            duration=duration
        )
    
    async def cancel_with_timeout(
        self,
        cancel_func: Callable,
        task_id: int,
        method: CancelMethod
    ) -> CancelResult:
        """
        Cancel operation with timeout
        
        Args:
            cancel_func: Cancel function
            task_id: Task ID
            method: Cancel method
            
        Returns:
            Cancel result
        """
        try:
            logger.info(
                f"Attempting to cancel task {task_id} with timeout {self.timeout}s"
            )
            
            result = await asyncio.wait_for(
                cancel_func(),
                timeout=self.timeout
            )
            
            return CancelResult(
                success=True,
                method=method,
                message=f"Cancelled using {method.value} within timeout"
            )
            
        except asyncio.TimeoutError:
            logger.warning(
                f"Cancel operation timed out for task {task_id} after {self.timeout}s"
            )
            return CancelResult(
                success=False,
                method=method,
                message=f"Timeout after {self.timeout}s"
            )
        except Exception as e:
            logger.exception(
                f"Error during cancel with timeout for task {task_id}: {e}"
            )
            return CancelResult(
                success=False,
                method=method,
                message=f"Error: {str(e)}"
            )