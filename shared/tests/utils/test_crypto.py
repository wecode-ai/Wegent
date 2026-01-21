# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import os
import sys

import pytest

# Add shared directory to path for imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from utils.crypto import (
    decrypt_api_key,
    decrypt_git_token,
    decrypt_sensitive_data,
    encrypt_api_key,
    encrypt_git_token,
    encrypt_sensitive_data,
    is_api_key_encrypted,
    is_data_encrypted,
    is_token_encrypted,
    mask_api_key,
)


@pytest.mark.unit
class TestCoreSensitiveDataEncryption:
    """Test core sensitive data encryption and decryption functions"""

    def test_encrypt_decrypt_basic_data(self):
        """Test basic encryption and decryption of sensitive data"""
        original_data = "my_secret_data_12345"

        encrypted = encrypt_sensitive_data(original_data)
        assert encrypted != original_data
        assert len(encrypted) > 0

        decrypted = decrypt_sensitive_data(encrypted)
        assert decrypted == original_data

    def test_encrypt_empty_data(self):
        """Test encrypting empty data"""
        empty_data = ""

        encrypted = encrypt_sensitive_data(empty_data)
        assert encrypted == ""

        decrypted = decrypt_sensitive_data(encrypted)
        assert decrypted == ""

    def test_encrypt_special_mask_data(self):
        """Test encrypting the special *** mask"""
        mask_data = "***"

        encrypted = encrypt_sensitive_data(mask_data)
        assert encrypted == "***"

        decrypted = decrypt_sensitive_data(encrypted)
        assert decrypted == "***"

    def test_is_data_encrypted_with_encrypted_data(self):
        """Test is_data_encrypted returns True for encrypted data"""
        original_data = "test_data_12345"
        encrypted = encrypt_sensitive_data(original_data)

        assert is_data_encrypted(encrypted) is True

    def test_is_data_encrypted_with_plain_data(self):
        """Test is_data_encrypted returns False for plain data"""
        plain_data = "plain_data_123"

        assert is_data_encrypted(plain_data) is False

    def test_is_data_encrypted_with_empty_data(self):
        """Test is_data_encrypted returns False for empty data"""
        assert is_data_encrypted("") is False


@pytest.mark.unit
class TestGitTokenEncryption:
    """Test git token encryption and decryption"""

    def test_encrypt_decrypt_basic_token(self):
        """Test basic encryption and decryption of a token"""
        original_token = "ghp_testtoken12345abcde"

        encrypted = encrypt_git_token(original_token)
        assert encrypted != original_token
        assert len(encrypted) > 0

        decrypted = decrypt_git_token(encrypted)
        assert decrypted == original_token

    def test_encrypt_empty_token(self):
        """Test encrypting an empty token"""
        empty_token = ""

        encrypted = encrypt_git_token(empty_token)
        assert encrypted == ""

        decrypted = decrypt_git_token(encrypted)
        assert decrypted == ""

    def test_encrypt_special_mask_token(self):
        """Test encrypting the special *** mask token"""
        mask_token = "***"

        encrypted = encrypt_git_token(mask_token)
        assert encrypted == "***"

        decrypted = decrypt_git_token(encrypted)
        assert decrypted == "***"

    def test_is_token_encrypted_with_encrypted_token(self):
        """Test is_token_encrypted returns True for encrypted tokens"""
        original_token = "ghp_testtoken12345"
        encrypted = encrypt_git_token(original_token)

        assert is_token_encrypted(encrypted) is True

    def test_is_token_encrypted_with_plain_token(self):
        """Test is_token_encrypted returns False for plain tokens"""
        plain_token = "plain_token_123"

        assert is_token_encrypted(plain_token) is False

    def test_is_token_encrypted_with_empty_token(self):
        """Test is_token_encrypted returns False for empty token"""
        assert is_token_encrypted("") is False

    def test_decrypt_plain_token_backward_compatibility(self):
        """Test that decrypting a plain token returns it unchanged (backward compatibility)"""
        plain_token = "plain_token_123"

        decrypted = decrypt_git_token(plain_token)
        assert decrypted == plain_token

    def test_encrypt_decrypt_long_token(self):
        """Test encryption and decryption of a long token"""
        long_token = "ghp_" + "a" * 100

        encrypted = encrypt_git_token(long_token)
        decrypted = decrypt_git_token(encrypted)

        assert decrypted == long_token

    def test_encrypt_decrypt_with_special_characters(self):
        """Test encryption and decryption of token with special characters"""
        special_token = "token!@#$%^&*()_+-=[]{}|;:,.<>?"

        encrypted = encrypt_git_token(special_token)
        decrypted = decrypt_git_token(encrypted)

        assert decrypted == special_token

    def test_encrypt_same_token_produces_same_result(self):
        """Test that encrypting the same token twice produces the same result (same IV)"""
        token = "test_token_123"

        encrypted1 = encrypt_git_token(token)
        encrypted2 = encrypt_git_token(token)

        # With the same IV, same plaintext should produce same ciphertext
        assert encrypted1 == encrypted2

    def test_decrypt_invalid_base64_returns_original(self):
        """Test that decrypting invalid base64 returns the original value"""
        invalid_token = "not-valid-base64!@#"

        decrypted = decrypt_git_token(invalid_token)
        assert decrypted == invalid_token

    def test_encryption_uses_environment_variables(self, monkeypatch):
        """Test that encryption uses environment variables for keys"""
        # Set custom encryption keys
        custom_key = "abcdefghijklmnopqrstuvwxyz123456"  # 32 bytes
        custom_iv = "0123456789abcdef"  # 16 bytes

        monkeypatch.setenv("GIT_TOKEN_AES_KEY", custom_key)
        monkeypatch.setenv("GIT_TOKEN_AES_IV", custom_iv)

        # Reset the global key cache
        import utils.crypto as crypto_module

        crypto_module._aes_key = None
        crypto_module._aes_iv = None

        token = "test_token_with_custom_keys"
        encrypted = encrypt_git_token(token)
        decrypted = decrypt_git_token(encrypted)

        assert decrypted == token


@pytest.mark.unit
class TestApiKeyEncryption:
    """Test API key encryption and decryption"""

    def test_encrypt_decrypt_openai_api_key(self):
        """Test encryption and decryption of OpenAI API key"""
        original_key = "sk-proj-1234567890abcdefghijklmnopqrstuvwxyz"

        encrypted = encrypt_api_key(original_key)
        assert encrypted != original_key
        assert len(encrypted) > 0

        decrypted = decrypt_api_key(encrypted)
        assert decrypted == original_key

    def test_encrypt_decrypt_anthropic_api_key(self):
        """Test encryption and decryption of Anthropic API key"""
        original_key = "sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz"

        encrypted = encrypt_api_key(original_key)
        assert encrypted != original_key
        assert len(encrypted) > 0

        decrypted = decrypt_api_key(encrypted)
        assert decrypted == original_key

    def test_encrypt_empty_api_key(self):
        """Test encrypting an empty API key"""
        empty_key = ""

        encrypted = encrypt_api_key(empty_key)
        assert encrypted == ""

        decrypted = decrypt_api_key(encrypted)
        assert decrypted == ""

    def test_is_api_key_encrypted_with_sk_prefix(self):
        """Test is_api_key_encrypted returns False for keys with sk- prefix"""
        openai_key = "sk-proj-1234567890"
        anthropic_key = "sk-ant-api03-1234567890"

        assert is_api_key_encrypted(openai_key) is False
        assert is_api_key_encrypted(anthropic_key) is False

    def test_is_api_key_encrypted_with_encrypted_key(self):
        """Test is_api_key_encrypted returns True for encrypted keys"""
        original_key = "sk-proj-1234567890"
        encrypted = encrypt_api_key(original_key)

        assert is_api_key_encrypted(encrypted) is True

    def test_encrypt_already_encrypted_key_returns_same(self):
        """Test that encrypting an already encrypted key returns the same value"""
        original_key = "sk-proj-1234567890"
        encrypted1 = encrypt_api_key(original_key)
        encrypted2 = encrypt_api_key(encrypted1)

        # Should not double-encrypt
        assert encrypted1 == encrypted2

    def test_decrypt_plain_api_key_backward_compatibility(self):
        """Test that decrypting a plain API key returns it unchanged (backward compatibility)"""
        plain_key = "sk-proj-1234567890"

        decrypted = decrypt_api_key(plain_key)
        assert decrypted == plain_key

    def test_mask_api_key_plain_text(self):
        """Test masking a plain text API key"""
        api_key = "sk-proj-1234567890abcdef"

        masked = mask_api_key(api_key)
        assert masked == "sk-p...cdef"

    def test_mask_api_key_encrypted(self):
        """Test masking an encrypted API key"""
        original_key = "sk-proj-1234567890"
        encrypted = encrypt_api_key(original_key)

        masked = mask_api_key(encrypted)
        assert masked == "***"

    def test_mask_api_key_empty(self):
        """Test masking an empty API key"""
        assert mask_api_key("") == "***"
        assert mask_api_key("***") == "***"

    def test_mask_api_key_short(self):
        """Test masking a short API key"""
        short_key = "sk-1234"

        masked = mask_api_key(short_key)
        assert masked == "***"

    def test_api_key_and_git_token_use_same_encryption(self):
        """Test that API key and git token use the same encryption algorithm"""
        test_data = "test_data_12345"

        # Encrypt using both functions
        encrypted_as_api_key = encrypt_api_key(test_data)
        encrypted_as_git_token = encrypt_git_token(test_data)

        # They should produce the same result (same algorithm, same keys)
        assert encrypted_as_api_key == encrypted_as_git_token

        # Both should decrypt correctly
        assert decrypt_api_key(encrypted_as_api_key) == test_data
        assert decrypt_git_token(encrypted_as_git_token) == test_data
