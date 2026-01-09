# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Service extensions with optimized data access.

Extension module for SERVICE_EXTENSION environment variable.

Each submodule exports a wrap(base_reader) function:
- wecode.cache.kinds.wrap() -> wraps KindReader
- wecode.cache.users.wrap() -> wraps UserReader
"""
