# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk Docs Skill Package.

This skill provides tools for adding DingTalk documents to Wegent knowledge bases.
"""

from chat_shell.skills import SkillToolProvider

from .provider import DingTalkDocsToolProvider

__all__ = ["DingTalkDocsToolProvider"]
