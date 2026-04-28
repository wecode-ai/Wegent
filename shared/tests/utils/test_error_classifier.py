# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from shared.utils.error_classifier import classify_error


def test_classify_error_treats_chinese_timeout_as_timeout_error():
    assert classify_error("请求超时，请稍后重试") == "timeout_error"


def test_classify_error_keeps_connection_interrupt_as_network_error():
    assert (
        classify_error("peer closed connection without sending complete message body")
        == "network_error"
    )
