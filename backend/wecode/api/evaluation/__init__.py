# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Evaluation module API package.

This package provides REST API endpoints organized by user roles:
- Author (出题人): Topic/Question creation and management
- Respondent (答题人): Answer submission and viewing
- Grader (评分人): Grading tasks and reports
- Shared: Cross-role functionality (file upload/download, report viewing)

Legacy CRUD-based routers are kept for backward compatibility.
"""

from fastapi import APIRouter

# Legacy CRUD-based routers (kept for backward compatibility)
from wecode.api.evaluation.answers import router as answers_router

# Role-based routers (new architecture)
from wecode.api.evaluation.author import router as author_router
from wecode.api.evaluation.grader import router as grader_router
from wecode.api.evaluation.grading import router as grading_router
from wecode.api.evaluation.permissions import router as permissions_router
from wecode.api.evaluation.questions import router as questions_router
from wecode.api.evaluation.respondent import router as respondent_router
from wecode.api.evaluation.shared import router as shared_router
from wecode.api.evaluation.topics import router as topics_router

# Create main evaluation router
router = APIRouter(prefix="/wecode/evaluation", tags=["evaluation"])

# Include role-based routers with prefixes
router.include_router(author_router, prefix="/author", tags=["author"])
router.include_router(respondent_router, prefix="/respondent", tags=["respondent"])
router.include_router(grader_router, prefix="/grader", tags=["grader"])
router.include_router(shared_router, prefix="/shared", tags=["shared"])

# Include legacy CRUD-based routers for backward compatibility
router.include_router(topics_router)
router.include_router(questions_router)
router.include_router(answers_router)
router.include_router(grading_router)
router.include_router(permissions_router)

__all__ = ["router"]
