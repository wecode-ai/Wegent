# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
WeCode schemas package.
"""

from wecode.schemas.cloud_device import (
    CloudDeviceConfig,
    CloudDeviceFileConfigResponse,
    CloudDeviceResponse,
    NevisSandboxStatus,
)
from wecode.schemas.evaluation import (
    AnswerCreate,
    AnswerInDB,
    AnswerListResponse,
    GradingTaskExecuteRequest,
    GradingTaskInDB,
    GradingTaskListResponse,
    GradingTaskPublishRequest,
    PermissionCreate,
    PermissionInDB,
    PermissionListResponse,
    QuestionCreate,
    QuestionInDB,
    QuestionListResponse,
    QuestionUpdate,
    QuestionVersionInDB,
    TopicCreate,
    TopicInDB,
    TopicListResponse,
    TopicUpdate,
    TopicVersionInDB,
)

__all__ = [
    # Cloud device schemas
    "CloudDeviceConfig",
    "CloudDeviceFileConfigResponse",
    "CloudDeviceResponse",
    "NevisSandboxStatus",
    # Evaluation schemas
    "TopicCreate",
    "TopicUpdate",
    "TopicInDB",
    "TopicListResponse",
    "TopicVersionInDB",
    "QuestionCreate",
    "QuestionUpdate",
    "QuestionInDB",
    "QuestionListResponse",
    "QuestionVersionInDB",
    "PermissionCreate",
    "PermissionInDB",
    "PermissionListResponse",
    "AnswerCreate",
    "AnswerInDB",
    "AnswerListResponse",
    "GradingTaskInDB",
    "GradingTaskListResponse",
    "GradingTaskExecuteRequest",
    "GradingTaskPublishRequest",
]
