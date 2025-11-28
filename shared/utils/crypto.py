# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Cryptography utilities for encrypting sensitive data like git tokens and API keys
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
_aes_key = None
_aes_iv = None


def _get_encryption_key():
    """Get or initialize encryption key and IV from environment variables"""
    global _aes_key, _aes_iv
    if _aes_key is None:
        # Load keys from environment variables
        aes_key = os.environ.get('GIT_TOKEN_AES_KEY', '12345678901234567890123456789012')
        aes_iv = os.environ.get('GIT_TOKEN_AES_IV', '1234567890123456')
        _aes_key = aes_key.encode('utf-8')
        _aes_iv = aes_iv.encode('utf-8')
        logger.info("Loaded encryption keys from environment variables")
    return _aes_key, _aes_iv


# ============================================================================
# Core encryption/decryption functions
# ============================================================================

def encrypt_sensitive_data(plain_text: str) -> str:
    """
    Encrypt sensitive data using AES-256-CBC encryption
    
    This is the core encryption function used by all sensitive data encryption.

    Args:
        plain_text: Plain text data to encrypt

    Returns:
        Base64 encoded encrypted data
    """
    if not plain_text:
        return ""

    if plain_text == "***":
        return "***"

    try:
        aes_key, aes_iv = _get_encryption_key()

        # Create cipher object
        cipher = Cipher(
            algorithms.AES(aes_key),
            modes.CBC(aes_iv),
            backend=default_backend()
        )
        encryptor = cipher.encryptor()

        # Pad the data to 16-byte boundary (AES block size)
        padder = padding.PKCS7(128).padder()
        padded_data = padder.update(plain_text.encode('utf-8')) + padder.finalize()

        # Encrypt the data
        encrypted_bytes = encryptor.update(padded_data) + encryptor.finalize()

        # Return base64 encoded encrypted data
        return base64.b64encode(encrypted_bytes).decode('utf-8')
    except Exception as e:
        logger.error(f"Failed to encrypt sensitive data: {str(e)}")
        raise


def decrypt_sensitive_data(encrypted_text: str) -> Optional[str]:
    """
    Decrypt sensitive data using AES-256-CBC decryption
    
    This is the core decryption function used by all sensitive data decryption.

    Args:
        encrypted_text: Base64 encoded encrypted data

    Returns:
        Decrypted plain text data, or original text if decryption fails
    """
    if not encrypted_text:
        return ""

    if encrypted_text == "***":
        return "***"

    try:
        aes_key, aes_iv = _get_encryption_key()

        # Decode base64 encrypted data
        encrypted_bytes = base64.b64decode(encrypted_text.encode('utf-8'))

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
        logger.warning(f"Failed to decrypt sensitive data: {str(e)}")
        # Return the original text as fallback for backward compatibility
        return encrypted_text


def is_data_encrypted(data: str) -> bool:
    """
    Check if data appears to be encrypted (base64 encoded AES ciphertext)

    Args:
        data: Data to check

    Returns:
        True if data appears to be encrypted, False otherwise
    """
    if not data:
        return False

    try:
        # Try to base64 decode
        decoded = base64.b64decode(data.encode('utf-8'))
        # If successful and the result is binary data with correct block size,
        # it's likely encrypted
        return len(decoded) > 0 and len(decoded) % 16 == 0
    except Exception:
        return False


# ============================================================================
# Git Token specific functions (for backward compatibility)
# ============================================================================

def encrypt_git_token(plain_token: str) -> str:
    """
    Encrypt git token using AES-256-CBC encryption

    Args:
        plain_token: Plain text git token

    Returns:
        Base64 encoded encrypted token
    """
    return encrypt_sensitive_data(plain_token)


def decrypt_git_token(encrypted_token: str) -> Optional[str]:
    """
    Decrypt git token using AES-256-CBC decryption

    Args:
        encrypted_token: Base64 encoded encrypted token

    Returns:
        Decrypted plain text token, or original token if decryption fails
    """
    return decrypt_sensitive_data(encrypted_token)


def is_token_encrypted(token: str) -> bool:
    """
    Check if a token appears to be encrypted (base64 encoded)

    Args:
        token: Token to check

    Returns:
        True if token appears to be encrypted, False otherwise
    """
    return is_data_encrypted(token)


# ============================================================================
# API Key specific functions
# ============================================================================

def encrypt_api_key(plain_key: str) -> str:
    """
    Encrypt API key using AES-256-CBC encryption

    Args:
        plain_key: Plain text API key

    Returns:
        Base64 encoded encrypted key
    """
    if not plain_key:
        return ""
    
    # Don't re-encrypt if already encrypted
    if is_api_key_encrypted(plain_key):
        return plain_key
    
    return encrypt_sensitive_data(plain_key)


def decrypt_api_key(encrypted_key: str) -> Optional[str]:
    """
    Decrypt API key using AES-256-CBC decryption

    Args:
        encrypted_key: Base64 encoded encrypted key

    Returns:
        Decrypted plain text key, or original key if decryption fails
    """
    if not encrypted_key:
        return ""
    
    # If not encrypted, return as-is (backward compatibility)
    if not is_api_key_encrypted(encrypted_key):
        return encrypted_key
    
    return decrypt_sensitive_data(encrypted_key)


def is_api_key_encrypted(key: str) -> bool:
    """
    Check if an API key appears to be encrypted (base64 encoded AES ciphertext)

    Args:
        key: Key to check

    Returns:
        True if key appears to be encrypted, False otherwise
    """
    if not key:
        return False

    # Common API key prefixes that indicate plain text
    plain_text_prefixes = ['sk-', 'sk_', 'api-', 'api_', 'key-', 'key_']
    for prefix in plain_text_prefixes:
        if key.startswith(prefix):
            return False

    return is_data_encrypted(key)


def mask_api_key(key: str) -> str:
    """
    Mask an API key for display purposes

    Args:
        key: API key to mask (can be encrypted or plain text)

    Returns:
        Masked key showing only first and last few characters, or "***" if encrypted
    """
    if not key or key == "***":
        return "***"

    # If encrypted, just return mask
    if is_api_key_encrypted(key):
        return "***"

    # For plain text keys, show partial
    if len(key) <= 8:
        return "***"

    return f"{key[:4]}...{key[-4:]}"