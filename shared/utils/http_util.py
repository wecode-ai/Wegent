# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0


def build_payload(**kwargs):
    return {k: v for k, v in kwargs.items() if v is not None}
