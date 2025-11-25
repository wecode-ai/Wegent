# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Cryptography utilities for encrypting sensitive data like git tokens
"""

import base64
import logging
import os
from typing import Optional

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.backends import default_backend

logger = logging.getLogger(__name__)

# Global encryption key cache
_git_token_aes_key = None
_git_token_aes_iv = None


def _get_git_token_encryption_key():
    """Get or initialize git token encryption key and IV from settings"""
    global _git_token_aes_key, _git_token_aes_iv
    if _git_token_aes_key is None:
        # Try to load keys from the backend settings if available
        aes_key = os.environ.get('GIT_TOKEN_AES_KEY', '12345678901234567890123456789012')
        aes_iv = os.environ.get('GIT_TOKEN_AES_IV', '1234567890123456')
        _git_token_aes_key = aes_key.encode('utf-8')
        _git_token_aes_iv = aes_iv.encode('utf-8')
        logger.info("Loaded encryption keys from environment variables")
    return _git_token_aes_key, _git_token_aes_iv


def encrypt_git_token(plain_token: str) -> str:
    """
    Encrypt git token using AES-256-CBC encryption

    Args:
        plain_token: Plain text git token

    Returns:
        Base64 encoded encrypted token
    """
    if not plain_token:
        return ""

    if plain_token == "***":
        return "***"

    try:
        aes_key, aes_iv = _get_git_token_encryption_key()

        # Create cipher object
        cipher = Cipher(
            algorithms.AES(aes_key),
            modes.CBC(aes_iv),
            backend=default_backend()
        )
        encryptor = cipher.encryptor()

        # Pad the data to 16-byte boundary (AES block size)
        padder = padding.PKCS7(128).padder()
        padded_data = padder.update(plain_token.encode('utf-8')) + padder.finalize()

        # Encrypt the data
        encrypted_bytes = encryptor.update(padded_data) + encryptor.finalize()

        # Return base64 encoded encrypted data
        return base64.b64encode(encrypted_bytes).decode('utf-8')
    except Exception as e:
        logger.error(f"Failed to encrypt git token: {str(e)}")
        raise


def decrypt_git_token(encrypted_token: str) -> Optional[str]:
    """
    Decrypt git token using AES-256-CBC decryption

    Args:
        encrypted_token: Base64 encoded encrypted token

    Returns:
        Decrypted plain text token, or None if decryption fails
    """
    if not encrypted_token:
        return ""

    if encrypted_token == "***":
        return "***"

    try:
        aes_key, aes_iv = _get_git_token_encryption_key()

        # Decode base64 encrypted data
        encrypted_bytes = base64.b64decode(encrypted_token.encode('utf-8'))

        # Create cipher object
        cipher = Cipher(
            algorithms.AES(aes_key),
            modes.CBC(aes_iv),
            backend=default_backend()
        )
        decryptor = cipher.decryptor()

        # Decrypt the data
        decrypted_padded_bytes = decryptor.update(encrypted_bytes) + decryptor.finalize()

        # Unpad the data
        unpadder = padding.PKCS7(128).unpadder()
        decrypted_bytes = unpadder.update(decrypted_padded_bytes) + unpadder.finalize()

        # Return decrypted string
        return decrypted_bytes.decode('utf-8')
    except Exception as e:
        logger.warning(f"Failed to decrypt git token: {str(e)}")
        # Return the original token as fallback for backward compatibility
        # This handles the case where old tokens are still in plain text
        return encrypted_token


def is_token_encrypted(token: str) -> bool:
    """
    Check if a token appears to be encrypted (base64 encoded)

    Args:
        token: Token to check

    Returns:
        True if token appears to be encrypted, False otherwise
    """
    if not token:
        return False

    try:
        # Try to base64 decode
        decoded = base64.b64decode(token.encode('utf-8'))
        # If successful and the result is binary data (not plain text),
        # it's likely encrypted
        return len(decoded) > 0 and len(decoded) % 16 == 0
    except Exception:
        return False


def encrypt_sensitive_data(plain_data: str) -> str:
    """
    Encrypt sensitive data using AES-256-CBC encryption
    Generic function that can be used for any sensitive data (API keys, tokens, etc.)

    Args:
        plain_data: Plain text sensitive data

    Returns:
        Base64 encoded encrypted data
    """
    # Reuse the same encryption logic as git tokens
    return encrypt_git_token(plain_data)


def decrypt_sensitive_data(encrypted_data: str) -> Optional[str]:
    """
    Decrypt sensitive data using AES-256-CBC decryption
    Generic function that can be used for any sensitive data (API keys, tokens, etc.)

    Args:
        encrypted_data: Base64 encoded encrypted data

    Returns:
        Decrypted plain text data, or None if decryption fails
    """
    # Reuse the same decryption logic as git tokens
    return decrypt_git_token(encrypted_data)


def is_data_encrypted(data: str) -> bool:
    """
    Check if data appears to be encrypted (base64 encoded)
    Generic function that can be used for any sensitive data

    Args:
        data: Data to check

    Returns:
        True if data appears to be encrypted, False otherwise
    """
    return is_token_encrypted(data)