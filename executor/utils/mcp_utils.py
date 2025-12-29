#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
DEPRECATED: This module has been moved to shared/utils/mcp_utils.py

This file is kept for backward compatibility. All functions are re-exported
from shared.utils.mcp_utils. Please update your imports to use:

    from shared.utils.mcp_utils import (
        extract_mcp_servers_config,
        replace_mcp_server_variables,
    )
"""

# Re-export all public functions from shared.utils.mcp_utils for backward compatibility
from shared.utils.mcp_utils import (
    _get_nested_value,
    _replace_placeholders_in_string,
    _replace_variables_recursive,
    extract_mcp_servers_config,
    replace_mcp_server_variables,
)

__all__ = [
    "extract_mcp_servers_config",
    "replace_mcp_server_variables",
    "_get_nested_value",
    "_replace_placeholders_in_string",
    "_replace_variables_recursive",
]
