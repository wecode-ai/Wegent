# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import importlib
import json
import os
from typing import Any, Dict

from shared.logger import setup_logger

from executor_manager.config.config import EXECUTOR_CONFIG

logger = setup_logger(__name__)


class ExecutorDispatcher:
    """
    Dynamically select the appropriate Executor instance based on the task type.
    """

    @staticmethod
    def _load_executors():

        executors = {}
        
        try:
            logger.info(f"Loading executors from EXECUTOR_CONFIG: {EXECUTOR_CONFIG}")
            if EXECUTOR_CONFIG:
                executor_config = json.loads(EXECUTOR_CONFIG)

                for executor_type, executor_path in executor_config.items():
                    try:

                        parts = executor_path.strip().split(".")
                        if len(parts) < 2:
                            raise ValueError(f"Invalid import path: {executor_path}")
                        
                        class_name = parts[-1]
                        module_path = ".".join(parts[:-1])
                        logger.info(f"Parsed import path for '{executor_type}': module='{module_path}', class='{class_name}'")
                        
                        module = importlib.import_module(module_path)
                        logger.info(f"Successfully imported module '{module_path}'")
                        
                        executor_class = getattr(module, class_name)
                        logger.info(f"Successfully got class '{class_name}' from module '{module_path}'")
                        
                        executor_instance = executor_class()
                        logger.info(f"Successfully instantiated executor '{executor_type}': {executor_instance}")
                        executors[executor_type] = executor_instance
                        logger.info(f"Dynamically loaded executor '{executor_type}' from '{executor_path}'")
                    except (ImportError, AttributeError, ValueError) as e:
                        logger.error(f"Failed to load executor '{executor_type}' from '{executor_path}': {e}")
                        raise
            else:
                from .docker import DockerExecutor
                executors["docker"] = DockerExecutor()
                logger.info("Loaded default docker executor")
                    
        except json.JSONDecodeError as e:
            error_msg = f"Invalid JSON in EXECUTOR_CONFIG environment variable: {e}"
            logger.error(error_msg)
            raise ValueError(error_msg)
        except Exception as e:
            error_msg = f"Error loading executors from environment: {e}"
            logger.error(error_msg)
            raise RuntimeError(error_msg)
        
        if not executors:
            error_msg = "No executors were loaded from configuration"
            logger.error(error_msg)
            raise RuntimeError(error_msg)
                
        return executors

    _executors = _load_executors.__func__()

    @classmethod
    def get_executor(cls, task_type: str):
        """
        Return the corresponding Executor instance according to the task type.
        Supports 'docker', and can be extended to 'local' and others in the future.
        """
        logger.info(f"Fetching executor for task type: {task_type}")
        logger.info(f"Available executors: {list(cls._executors.keys())}")
        
        if task_type not in cls._executors:
            logger.warning(f"Executor type '{task_type}' not found, using default 'docker' executor")
            if "docker" not in cls._executors:
                logger.error(f"Default 'docker' executor not found in available executors: {list(cls._executors.keys())}")
                raise ValueError(f"Default 'docker' executor not found")
            return cls._executors["docker"]
        
        logger.info(f"Found executor for type '{task_type}': {cls._executors[task_type]}")
        return cls._executors[task_type]
