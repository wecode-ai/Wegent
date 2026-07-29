# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DI factory for KbStatQueryService."""

from knowledge_engine.stat.query import KbStatQueryService


def get_query_service() -> KbStatQueryService:
    from knowledge_runtime.config import get_settings
    from shared.db.stat_session import get_stat_session_factory

    return KbStatQueryService(
        stat_session_factory=get_stat_session_factory(),
        advanced_enabled=get_settings().kb_stat_advanced_enabled,
    )
