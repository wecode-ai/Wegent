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

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

logger = logging.getLogger(__name__)

# Global encryption key cache
_aes_key = None
_aes_iv = None

# Global attachment encryption key cache (separate from git token keys)
_attachment_aes_key = None
_attachment_aes_iv = None


def _get_encryption_key():
    """Get or initialize encryption key and IV from environment variables"""
    global _aes_key, _aes_iv
    if _aes_key is None:
        # Load keys from environment variables
        aes_key = os.environ.get(
            "GIT_TOKEN_AES_KEY", "12345678901234567890123456789012"
        )
        aes_iv = os.environ.get("GIT_TOKEN_AES_IV", "1234567890123456")
        _aes_key = aes_key.encode("utf-8")
        _aes_iv = aes_iv.encode("utf-8")
        logger.info("Loaded encryption keys from environment variables")
    return _aes_key, _aes_iv


def _get_attachment_encryption_key():
    """
    Get or initialize attachment encryption key and IV from environment variables.

    Uses separate keys from git token encryption for security isolation.
    """
    global _attachment_aes_key, _attachment_aes_iv
    if _attachment_aes_key is None:
        # Load attachment-specific keys from environment variables
        aes_key = os.environ.get(
            "ATTACHMENT_AES_KEY", "12345678901234567890123456789012"
        )
        aes_iv = os.environ.get("ATTACHMENT_AES_IV", "1234567890123456")
        _attachment_aes_key = aes_key.encode("utf-8")
        _attachment_aes_iv = aes_iv.encode("utf-8")
        logger.info("Loaded attachment encryption keys from environment variables")
    return _attachment_aes_key, _attachment_aes_iv


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
            algorithms.AES(aes_key), modes.CBC(aes_iv), backend=default_backend()
        )
        encryptor = cipher.encryptor()

        # Pad the data to 16-byte boundary (AES block size)
        padder = padding.PKCS7(128).padder()
        padded_data = padder.update(plain_text.encode("utf-8")) + padder.finalize()

        # Encrypt the data
        encrypted_bytes = encryptor.update(padded_data) + encryptor.finalize()

        # Return base64 encoded encrypted data
        return base64.b64encode(encrypted_bytes).decode("utf-8")
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
        encrypted_bytes = base64.b64decode(encrypted_text.encode("utf-8"))

        # Create cipher object
        cipher = Cipher(
            algorithms.AES(aes_key), modes.CBC(aes_iv), backend=default_backend()
        )
        decryptor = cipher.decryptor()

        # Decrypt the data
        decrypted_padded_bytes = (
            decryptor.update(encrypted_bytes) + decryptor.finalize()
        )

        # Unpad the data
        unpadder = padding.PKCS7(128).unpadder()
        decrypted_bytes = unpadder.update(decrypted_padded_bytes) + unpadder.finalize()

        # Return decrypted string
        return decrypted_bytes.decode("utf-8")
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
        decoded = base64.b64decode(data.encode("utf-8"))
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
    plain_text_prefixes = ["sk-", "sk_", "api-", "api_", "key-", "key_"]
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


# ============================================================================
# Attachment encryption functions
# ============================================================================


def encrypt_attachment(binary_data: bytes) -> bytes:
    """
    Encrypt attachment binary data using AES-256-CBC encryption.

    Uses separate encryption keys (ATTACHMENT_AES_KEY/ATTACHMENT_AES_IV) from
    git token encryption for security isolation.

    Args:
        binary_data: Attachment binary data to encrypt

    Returns:
        Encrypted binary data (raw bytes, NOT base64 encoded)

    Raises:
        Exception: If encryption fails
    """
    if not binary_data:
        return b""

    try:
        aes_key, aes_iv = _get_attachment_encryption_key()

        # Create cipher object
        cipher = Cipher(
            algorithms.AES(aes_key), modes.CBC(aes_iv), backend=default_backend()
        )
        encryptor = cipher.encryptor()

        # Pad the data to 16-byte boundary (AES block size)
        padder = padding.PKCS7(128).padder()
        padded_data = padder.update(binary_data) + padder.finalize()

        # Encrypt the data
        encrypted_bytes = encryptor.update(padded_data) + encryptor.finalize()

        return encrypted_bytes
    except Exception as e:
        logger.error(f"Failed to encrypt attachment data: {str(e)}")
        raise


def decrypt_attachment(encrypted_data: bytes) -> bytes:
    """
    Decrypt attachment binary data using AES-256-CBC decryption.

    Uses separate encryption keys (ATTACHMENT_AES_KEY/ATTACHMENT_AES_IV) from
    git token encryption for security isolation.

    Args:
        encrypted_data: Encrypted binary data (raw bytes, NOT base64 encoded)

    Returns:
        Decrypted binary data

    Raises:
        Exception: If decryption fails
    """
    if not encrypted_data:
        return b""

    try:
        aes_key, aes_iv = _get_attachment_encryption_key()

        # Create cipher object
        cipher = Cipher(
            algorithms.AES(aes_key), modes.CBC(aes_iv), backend=default_backend()
        )
        decryptor = cipher.decryptor()

        # Decrypt the data
        decrypted_padded_bytes = decryptor.update(encrypted_data) + decryptor.finalize()

        # Unpad the data
        unpadder = padding.PKCS7(128).unpadder()
        decrypted_bytes = unpadder.update(decrypted_padded_bytes) + unpadder.finalize()

        return decrypted_bytes
    except Exception as e:
        logger.error(f"Failed to decrypt attachment data: {str(e)}")
        raise


def is_attachment_encrypted(data: bytes) -> bool:
    """
    Check if attachment data appears to be encrypted.

    This is a heuristic check based on data properties. It checks if:
    1. Data is not empty
    2. Data length is a multiple of 16 (AES block size)
    3. Data appears to have high entropy (typical of encrypted data)

    Args:
        data: Binary data to check

    Returns:
        True if data appears to be encrypted, False otherwise
    """
    if not data or len(data) == 0:
        return False

    # Check if data length is a multiple of 16 (AES block size with PKCS7 padding)
    if len(data) % 16 != 0:
        return False

    # If it passes block size check, assume it's encrypted
    # (This is a simple heuristic - more sophisticated checks could be added)
    return True
