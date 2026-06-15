# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared constants for web scraper classification and quality checks."""

AUTH_KEYWORDS: tuple[str, ...] = (
    "请登录",
    "登录后查看",
    "login required",
    "sign in",
    "authentication required",
)
BLOCKED_KEYWORDS: tuple[str, ...] = (
    "访问验证",
    "验证码",
    "access denied",
    "forbidden",
    "captcha",
    "just a moment",
    "链接失效",
)
RATE_LIMIT_KEYWORDS: tuple[str, ...] = (
    "too many requests",
    "rate limited",
    "请求过于频繁",
)
