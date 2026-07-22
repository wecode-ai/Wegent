# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Generator

import pytest


@pytest.fixture(autouse=True)
def test_sensitive_data_crypto_env(
    monkeypatch: pytest.MonkeyPatch,
) -> Generator[None, None, None]:
    """Provide explicit test crypto config for sensitive-data encryption."""

    from utils import crypto

    monkeypatch.setenv("GIT_TOKEN_AES_KEY", "12345678901234567890123456789012")
    monkeypatch.setenv("GIT_TOKEN_AES_IV", "1234567890123456")
    crypto._aes_key = None
    crypto._aes_iv = None
    yield
    crypto._aes_key = None
    crypto._aes_iv = None
