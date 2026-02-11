# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Keep-alive label protection utilities.

This module provides helper functions for checking and managing keep-alive
label protection on Kubernetes pods. Pods with the keep-alive label
(aigc.weibo.com/keep-alive=true) are protected from automatic deletion.
"""

from typing import Optional

from shared.logger import setup_logger

logger = setup_logger(__name__)


def check_keep_alive_protection(
    executor_name: str,
    dispatcher_mode: str,
    log_context: str = "",
) -> bool:
    """Check if a pod/container has keep-alive label protection.

    This function checks if the specified executor (pod in K8s mode) has the
    keep-alive label that protects it from automatic deletion. This is only
    applicable in Kubernetes mode.

    Args:
        executor_name: Name of the executor/pod to check
        dispatcher_mode: Current executor dispatcher mode ("k8s" or "docker")
        log_context: Optional context string for logging (e.g., "[HeartbeatManager]")

    Returns:
        True if the pod has keep-alive protection, False otherwise
    """
    # Only applicable in K8s mode
    if dispatcher_mode != "k8s":
        return False

    try:
        from executor_manager.executors.dispatcher import ExecutorDispatcher

        executor = ExecutorDispatcher.get_executor(dispatcher_mode)
        if hasattr(executor, "has_keep_alive_label") and executor.has_keep_alive_label(
            executor_name
        ):
            context = f"{log_context} " if log_context else ""
            logger.info(
                f"{context}Pod '{executor_name}' has keep-alive label protection"
            )
            return True
        return False
    except Exception as e:
        context = f"{log_context} " if log_context else ""
        logger.debug(f"{context}Error checking keep-alive label: {e}")
        return False


def set_keep_alive_protection(
    executor_name: str,
    dispatcher_mode: str,
    enabled: bool = True,
    log_context: str = "",
) -> dict:
    """Set or remove keep-alive label protection on a pod.

    This function adds or removes the keep-alive label on a Kubernetes pod.
    Only applicable in Kubernetes mode.

    Args:
        executor_name: Name of the executor/pod to update
        dispatcher_mode: Current executor dispatcher mode ("k8s" or "docker")
        enabled: If True, add protection; if False, remove it
        log_context: Optional context string for logging

    Returns:
        Dict with status and details
    """
    # Only applicable in K8s mode
    if dispatcher_mode != "k8s":
        return {
            "status": "skipped",
            "error_msg": "Keep-alive label is only supported in Kubernetes mode",
        }

    try:
        from executor_manager.executors.dispatcher import ExecutorDispatcher

        executor = ExecutorDispatcher.get_executor(dispatcher_mode)
        if hasattr(executor, "set_keep_alive_label"):
            result = executor.set_keep_alive_label(executor_name, enabled)
            context = f"{log_context} " if log_context else ""
            action = "enabled" if enabled else "disabled"
            if result.get("status") == "success":
                logger.info(
                    f"{context}Keep-alive protection {action} for pod '{executor_name}'"
                )
            return result
        else:
            return {
                "status": "failed",
                "error_msg": "Executor does not support keep-alive label management",
            }
    except Exception as e:
        context = f"{log_context} " if log_context else ""
        logger.error(f"{context}Error setting keep-alive label: {e}")
        return {"status": "failed", "error_msg": str(e)}
