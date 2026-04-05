# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import APIRouter

from knowledge_runtime.api.health import router as health_router
from knowledge_runtime.api.internal.rag import router as rag_router

router = APIRouter()
router.include_router(health_router)
router.include_router(rag_router)
