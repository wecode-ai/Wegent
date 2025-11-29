# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
CI Repair Service for handling automatic CI failure repairs
"""

import os
from dataclasses import dataclass
from typing import Any, Dict, Optional

from shared.logger import setup_logger

logger = setup_logger("ci_repair_service")


@dataclass
class CIRepairRequest:
    """Request data for CI repair"""
    condition_id: int
    subtask_id: int
    task_id: int
    session_id: str
    executor_namespace: str
    executor_name: str
    retry_count: int
    max_retries: int
    failure_log: str
    job_name: str
    failure_url: Optional[str] = None


class CIRepairService:
    """Service for constructing CI repair prompts and managing repair cycles"""

    # Maximum characters of failure log to include in prompt
    MAX_LOG_LENGTH = 30000

    # CI repair prompt template
    REPAIR_PROMPT_TEMPLATE = """CI Pipeline执行失败，请根据以下日志修复问题：

## 失败信息

- 失败的检查: {job_name}
- 修复尝试: {retry_count}/{max_retries}
{failure_url_section}

## 失败日志

```
{failure_log}
```

## 修复要求

1. 仔细分析上述失败日志，确定失败的根本原因
2. 根据日志中的错误信息修复相关代码
3. 确保修复后的代码能够通过相同的CI检查
4. 修复完成后，重新提交代码

请开始修复工作。
"""

    def __init__(self):
        pass

    def build_repair_prompt(self, request: CIRepairRequest) -> str:
        """
        Build a repair prompt for the agent based on CI failure information

        Args:
            request: CI repair request data

        Returns:
            Formatted repair prompt string
        """
        # Truncate failure log if too long
        failure_log = request.failure_log or "No failure log available"
        if len(failure_log) > self.MAX_LOG_LENGTH:
            failure_log = (
                failure_log[:self.MAX_LOG_LENGTH] +
                f"\n\n... (log truncated, showing first {self.MAX_LOG_LENGTH} characters)"
            )

        # Build failure URL section
        failure_url_section = ""
        if request.failure_url:
            failure_url_section = f"- 详细链接: {request.failure_url}"

        prompt = self.REPAIR_PROMPT_TEMPLATE.format(
            job_name=request.job_name or "CI Check",
            retry_count=request.retry_count,
            max_retries=request.max_retries,
            failure_url_section=failure_url_section,
            failure_log=failure_log,
        )

        logger.info(
            f"Built repair prompt for condition {request.condition_id}, "
            f"retry {request.retry_count}/{request.max_retries}"
        )

        return prompt

    def should_trigger_repair(
        self, retry_count: int, max_retries: int
    ) -> bool:
        """
        Check if repair should be triggered based on retry count

        Args:
            retry_count: Current retry count
            max_retries: Maximum allowed retries

        Returns:
            True if repair should be triggered
        """
        return retry_count < max_retries

    def extract_check_types(self, failure_log: str) -> list:
        """
        Extract the type of CI checks that failed from the log

        Args:
            failure_log: The failure log content

        Returns:
            List of check types (e.g., ['test', 'lint', 'build'])
        """
        check_types = []
        log_lower = failure_log.lower()

        # Check for common CI failure patterns
        if any(word in log_lower for word in ['test', 'pytest', 'jest', 'unittest', 'spec']):
            check_types.append('test')

        if any(word in log_lower for word in ['lint', 'eslint', 'pylint', 'flake8', 'black', 'prettier']):
            check_types.append('lint')

        if any(word in log_lower for word in ['build', 'compile', 'npm run build', 'tsc']):
            check_types.append('build')

        if any(word in log_lower for word in ['type', 'typecheck', 'mypy', 'typescript']):
            check_types.append('type')

        # If no specific type found, use generic 'ci'
        if not check_types:
            check_types.append('ci')

        return check_types


# Global service instance
ci_repair_service = CIRepairService()


def build_ci_repair_prompt(request: CIRepairRequest) -> str:
    """
    Build a CI repair prompt for agent session resumption

    Args:
        request: CI repair request data

    Returns:
        Formatted repair prompt
    """
    return ci_repair_service.build_repair_prompt(request)


def create_repair_request_from_dict(data: Dict[str, Any]) -> CIRepairRequest:
    """
    Create a CIRepairRequest from a dictionary

    Args:
        data: Dictionary containing repair request data

    Returns:
        CIRepairRequest instance
    """
    return CIRepairRequest(
        condition_id=data.get("condition_id", 0),
        subtask_id=data.get("subtask_id", 0),
        task_id=data.get("task_id", 0),
        session_id=data.get("session_id", ""),
        executor_namespace=data.get("executor_namespace", ""),
        executor_name=data.get("executor_name", ""),
        retry_count=data.get("retry_count", 0),
        max_retries=data.get("max_retries", 5),
        failure_log=data.get("failure_log", ""),
        job_name=data.get("job_name", "CI Check"),
        failure_url=data.get("failure_url"),
    )
