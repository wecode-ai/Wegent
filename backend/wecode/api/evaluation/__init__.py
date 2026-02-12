# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Evaluation module API package.

This package provides REST API endpoints for:
- Topic management
- Question management
- Answer submission
- Grading task management
- Permission management
"""

from fastapi import APIRouter

from wecode.api.evaluation.answers import router as answers_router
from wecode.api.evaluation.grading import router as grading_router
from wecode.api.evaluation.permissions import router as permissions_router
from wecode.api.evaluation.questions import router as questions_router
from wecode.api.evaluation.topics import router as topics_router

# Create main evaluation router
router = APIRouter(prefix="/wecode/evaluation", tags=["evaluation"])

# Include sub-routers
router.include_router(topics_router)
router.include_router(questions_router)
router.include_router(answers_router)
router.include_router(grading_router)
router.include_router(permissions_router)

__all__ = ["router"]
