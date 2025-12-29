# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Shell Models - LLM Instance Creation.

This module provides LangChain model factory for creating LLM instances
based on resolved model configurations.

The model configuration should be prepared by Backend (resolved, decrypted,
placeholders replaced) before being passed to Chat Shell.
"""

from .factory import LangChainModelFactory

__all__ = ["LangChainModelFactory"]
