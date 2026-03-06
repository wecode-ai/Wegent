# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge service domain exceptions."""


class ConsumerAccessDeniedError(Exception):
    """Raised when a Consumer-role user attempts an operation
    that requires a higher permission level (e.g. viewing documents)."""
