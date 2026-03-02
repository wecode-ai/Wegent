# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Custom exceptions for the wecode module."""


class BusinessException(Exception):
    """Business logic exception for domain-specific errors."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message
