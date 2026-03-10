# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge service domain exceptions."""


class RestrictedObserverAccessDeniedError(Exception):
    """Raised when a RestrictedObserver-role user attempts an operation
    that requires a higher permission level (e.g. viewing documents)."""
