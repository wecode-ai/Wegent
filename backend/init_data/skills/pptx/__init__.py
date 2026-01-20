# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""PPTX skill package."""

from .provider import PPTXToolProvider
from .pptx_tool import PPTXGenerateTool

__all__ = ["PPTXGenerateTool", "PPTXToolProvider"]
