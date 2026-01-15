# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""PPTX slide generation skill package.

This skill provides PowerPoint presentation generation capabilities
using E2B sandbox execution of python-pptx code.
"""

from .create_pptx import CreatePPTXTool
from .provider import PPTXToolProvider

__all__ = ["PPTXToolProvider", "CreatePPTXTool"]
