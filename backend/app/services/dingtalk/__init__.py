# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk services package."""

from app.services.dingtalk.docs_service import (
    DingTalkDocsService,
    dingtalk_docs_service,
)

__all__ = ["DingTalkDocsService", "dingtalk_docs_service"]
