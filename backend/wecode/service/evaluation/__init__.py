# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Evaluation service package.

This package provides business logic services for the evaluation module:
- TopicService: Topic CRUD and publishing
- QuestionService: Question CRUD and versioning
- AnswerService: Answer submission and history
- GradingService: AI-powered grading integration
- PermissionService: Access control management
- StorageService: S3/MinIO file storage
"""

from wecode.service.evaluation.answer_service import AnswerService
from wecode.service.evaluation.grading_service import GradingService
from wecode.service.evaluation.permission_service import PermissionService
from wecode.service.evaluation.question_service import QuestionService
from wecode.service.evaluation.storage_service import EvalStorageService
from wecode.service.evaluation.topic_service import TopicService
from wecode.service.evaluation.utils import generate_version

__all__ = [
    "TopicService",
    "QuestionService",
    "AnswerService",
    "GradingService",
    "PermissionService",
    "EvalStorageService",
    "generate_version",
]

# Singleton instances
_topic_service: TopicService = None
_question_service: QuestionService = None
_answer_service: AnswerService = None
_grading_service: GradingService = None
_permission_service: PermissionService = None
_storage_service: EvalStorageService = None


def get_topic_service() -> TopicService:
    """Get singleton topic service instance."""
    global _topic_service
    if _topic_service is None:
        _topic_service = TopicService()
    return _topic_service


def get_question_service() -> QuestionService:
    """Get singleton question service instance."""
    global _question_service
    if _question_service is None:
        _question_service = QuestionService()
    return _question_service


def get_answer_service() -> AnswerService:
    """Get singleton answer service instance."""
    global _answer_service
    if _answer_service is None:
        _answer_service = AnswerService()
    return _answer_service


def get_grading_service() -> GradingService:
    """Get singleton grading service instance."""
    global _grading_service
    if _grading_service is None:
        _grading_service = GradingService()
    return _grading_service


def get_permission_service() -> PermissionService:
    """Get singleton permission service instance."""
    global _permission_service
    if _permission_service is None:
        _permission_service = PermissionService()
    return _permission_service


def get_storage_service() -> EvalStorageService:
    """Get singleton storage service instance."""
    global _storage_service
    if _storage_service is None:
        _storage_service = EvalStorageService()
    return _storage_service
