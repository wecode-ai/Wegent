#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import json
import os
from typing import Any, Dict, Optional

# Import the shared logger
from shared.logger import setup_logger

# Use the shared logger setup function
logger = setup_logger("task_reader")


class TaskReader:
    """
    Class for reading and parsing task files
    """

    def __init__(self, file_path: str = "example.json"):
        """
        Initialize TaskReader

        Args:
            file_path: Path to the task file, default is '/data1/background-agent/task.json'
        """
        # Handle relative paths
        if not file_path.startswith("/"):
            # If it's a relative path, it's relative to the current script directory
            current_dir = os.path.dirname(os.path.abspath(__file__))
            file_path = os.path.join(current_dir, file_path)

        self.file_path = file_path

    def read_task_file(self) -> Optional[Dict[str, Any]]:
        """
        Read and parse the task file

        Returns:
            Parsed task object, or None if an error occurs
        """
        try:
            if not os.path.exists(self.file_path):
                logger.error(f"Task file does not exist: {self.file_path}")
                return None

            with open(self.file_path, "r", encoding="utf-8") as f:
                task_data = json.load(f)
                logger.info(f"Successfully read task file: {self.file_path}")
                return task_data

        except json.JSONDecodeError as e:
            logger.error(f"JSON parsing error: {str(e)}")
            return None
        except Exception as e:
            logger.error(f"Error reading task file: {str(e)}")
            return None
