# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Security helpers for MCP provider keys."""

from app.schemas.user import MCPProviderKeys
from shared.utils.crypto import (
    decrypt_sensitive_data,
    encrypt_sensitive_data,
    is_data_encrypted,
)


def encrypt_mcp_provider_keys(keys: MCPProviderKeys) -> MCPProviderKeys:
    """Encrypt MCP provider keys before persistence."""
    encrypted_payload = {}

    for field_name, field_value in keys.model_dump().items():
        if not field_value:
            encrypted_payload[field_name] = field_value
            continue

        # Avoid double encryption for already encrypted values.
        if is_data_encrypted(field_value):
            encrypted_payload[field_name] = field_value
            continue

        encrypted_payload[field_name] = encrypt_sensitive_data(field_value)

    return MCPProviderKeys(**encrypted_payload)


def decrypt_mcp_provider_key(encrypted_value: str) -> str:
    """Decrypt one MCP provider key, enforcing encrypted format."""
    if not encrypted_value:
        return encrypted_value

    if not is_data_encrypted(encrypted_value):
        raise ValueError("mcp_provider_key_not_encrypted")

    decrypted = decrypt_sensitive_data(encrypted_value)
    if decrypted is None or decrypted == encrypted_value:
        raise ValueError("mcp_provider_key_decrypt_failed")

    return decrypted
