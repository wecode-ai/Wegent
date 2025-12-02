#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Image Validator Agent for validating custom base images.
This agent runs validation checks inside the container to verify
compatibility with specific shell types.
"""

import re
import subprocess
from typing import Dict, Any, Tuple, Optional, List

from shared.logger import setup_logger
from shared.status import TaskStatus
from executor.agents.base import Agent

logger = setup_logger("image_validator")


class ImageValidatorAgent(Agent):
    """
    Agent for validating custom base images.

    This agent executes validation commands inside the container
    and reports results back via callback.
    """

    AGENT_TYPE = "validator"

    # Shell type to validation checks mapping
    VALIDATION_CHECKS = {
        "ClaudeCode": [
            {
                "name": "node",
                "command": "node --version",
                "version_regex": r"v(\d+\.\d+\.\d+)",
                "min_version": "20.0.0",
            },
            {
                "name": "claude-code",
                "command": "claude --version 2>/dev/null || echo 'not found'",
                "version_regex": r"(\d+\.\d+\.\d+)",
                "min_version": None,
            },
            {
                "name": "sqlite",
                "command": "sqlite3 --version",
                "version_regex": r"(\d+\.\d+\.\d+)",
                "min_version": "3.50.0",
            },
            {
                "name": "python",
                "command": "python3 --version",
                "version_regex": r"Python (\d+\.\d+\.\d+)",
                "min_version": "3.12.0",
            },
        ],
        "Agno": [
            {
                "name": "python",
                "command": "python3 --version",
                "version_regex": r"Python (\d+\.\d+\.\d+)",
                "min_version": "3.12.0",
            },
        ],
    }

    def __init__(self, task_data: Dict[str, Any]):
        super().__init__(task_data)
        self.task_data = task_data

        # Get validation parameters from task data
        validation_params = task_data.get("validation_params", {})
        self.shell_type = validation_params.get("shell_type", "")
        self.image = validation_params.get("image", "")
        self.shell_name = validation_params.get("shell_name", "")
        self.validation_id = validation_params.get("validation_id", "")

    def get_name(self) -> str:
        return "ImageValidator"

    def initialize(self) -> TaskStatus:
        """Initialize the validator agent"""
        if not self.shell_type:
            logger.error("shell_type is required for validation")
            return TaskStatus.FAILED

        if self.shell_type not in self.VALIDATION_CHECKS:
            logger.error(f"Unknown shell type: {self.shell_type}")
            return TaskStatus.FAILED

        logger.info(f"ImageValidator initialized for shell_type={self.shell_type}, validation_id={self.validation_id}")
        return TaskStatus.SUCCESS

    def execute(self) -> TaskStatus:
        """Execute validation checks and return results"""
        logger.info(f"Starting image validation for shell_type={self.shell_type}")

        checks = self.VALIDATION_CHECKS.get(self.shell_type, [])
        results = []
        all_passed = True
        total_checks = len(checks)

        # Report running_checks stage
        self.report_progress(
            progress=70,
            status=TaskStatus.RUNNING.value,
            message="Running dependency checks",
            result={
                "stage": "running_checks",
                "validation_id": self.validation_id,
                "current_check": None,
            },
        )

        for index, check in enumerate(checks):
            # Report current check progress
            current_progress = 70 + int((index / total_checks) * 25)
            self.report_progress(
                progress=current_progress,
                status=TaskStatus.RUNNING.value,
                message=f"Checking {check['name']}",
                result={
                    "stage": "running_checks",
                    "validation_id": self.validation_id,
                    "current_check": check["name"],
                },
            )

            check_result = self._run_check(check)
            results.append(check_result)
            if check_result["status"] == "fail":
                all_passed = False

        # Build result data to be returned via callback
        validation_result = {
            "valid": all_passed,
            "checks": results,
            "errors": [],
            "shell_name": self.shell_name,
            "shell_type": self.shell_type,
            "image": self.image,
        }

        logger.info(f"Validation completed: valid={all_passed}, checks={len(results)}")

        # Send result via callback with result data including validation_id
        self.report_progress(
            progress=100,
            status=TaskStatus.COMPLETED.value,
            message="Image validation completed",
            result={
                "stage": "completed",
                "validation_id": self.validation_id,
                "validation_result": validation_result,
            },
        )

        return TaskStatus.COMPLETED

    def _run_check(self, check: Dict[str, Any]) -> Dict[str, Any]:
        """Run a single validation check"""
        name = check["name"]
        command = check["command"]
        version_regex = check["version_regex"]
        min_version = check.get("min_version")

        try:
            result = subprocess.run(
                ["sh", "-c", command],
                capture_output=True,
                text=True,
                timeout=30,
            )

            output = result.stdout.strip()
            if result.returncode != 0 or "not found" in output.lower():
                logger.warning(f"Check '{name}' failed: command returned error or not found")
                return {
                    "name": name,
                    "status": "fail",
                    "message": "Command failed or not found",
                }

            # Extract version
            version_match = re.search(version_regex, output)
            if version_match:
                version = version_match.group(1)

                # Check minimum version if specified
                if min_version:
                    try:
                        from packaging import version as pkg_version

                        if pkg_version.parse(version) < pkg_version.parse(min_version):
                            logger.warning(f"Check '{name}': version {version} < required {min_version}")
                            return {
                                "name": name,
                                "version": version,
                                "status": "fail",
                                "message": f"Version {version} < required {min_version}",
                            }
                    except Exception as e:
                        logger.warning(f"Version comparison error for '{name}': {e}")

                logger.info(f"Check '{name}' passed: version={version}")
                return {
                    "name": name,
                    "version": version,
                    "status": "pass",
                }
            else:
                logger.info(f"Check '{name}' passed but version not parsed")
                return {
                    "name": name,
                    "status": "pass",
                    "message": "Detected but version not parsed",
                }

        except subprocess.TimeoutExpired:
            logger.error(f"Check '{name}' timed out")
            return {
                "name": name,
                "status": "fail",
                "message": "Check timed out",
            }
        except Exception as e:
            logger.error(f"Check '{name}' error: {e}")
            return {
                "name": name,
                "status": "fail",
                "message": str(e),
            }

    def cancel_run(self) -> bool:
        """Cancel is not applicable for validation tasks"""
        return True
