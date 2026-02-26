# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.schemas.user import MCPProviderKeys
from app.services.mcp_providers.security import (
    decrypt_mcp_provider_key,
    encrypt_mcp_provider_keys,
)
from shared.utils.crypto import is_data_encrypted


def test_encrypt_mcp_provider_keys_encrypts_plaintext_values():
    keys = MCPProviderKeys(bailian="bailian-token", modelscope="modelscope-token")

    encrypted = encrypt_mcp_provider_keys(keys)

    assert encrypted.bailian != "bailian-token"
    assert encrypted.modelscope != "modelscope-token"
    assert is_data_encrypted(encrypted.bailian)
    assert is_data_encrypted(encrypted.modelscope)


def test_decrypt_mcp_provider_key_returns_plaintext_value():
    encrypted_keys = encrypt_mcp_provider_keys(
        MCPProviderKeys(mcp_router="router-token")
    )

    decrypted = decrypt_mcp_provider_key(encrypted_keys.mcp_router)

    assert decrypted == "router-token"


def test_decrypt_mcp_provider_key_rejects_plaintext_value():
    with pytest.raises(ValueError, match="mcp_provider_key_not_encrypted"):
        decrypt_mcp_provider_key("plaintext-token")
