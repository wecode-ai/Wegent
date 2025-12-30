#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Standalone test script for compression module.

This script tests the compression functionality by importing modules
directly without going through the chat_shell package __init__.py.
"""

import sys
import os
import importlib.util


def load_module_from_path(module_name: str, file_path: str):
    """Load a Python module directly from file path."""
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load module from {file_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


# Set up paths
backend_path = "/workspace/103690/Wegent/backend"
compression_path = os.path.join(backend_path, "app", "chat_shell", "compression")

# Mock app.core.config.settings to avoid full app import
class MockSettings:
    MESSAGE_COMPRESSION_ENABLED = True
    MESSAGE_COMPRESSION_FIRST_MESSAGES = 2
    MESSAGE_COMPRESSION_LAST_MESSAGES = 10
    MESSAGE_COMPRESSION_ATTACHMENT_LENGTH = 50000


# Create mock module structure
sys.modules["app"] = type(sys)("app")
sys.modules["app.core"] = type(sys)("app.core")
sys.modules["app.core.config"] = type(sys)("app.core.config")
sys.modules["app.core.config"].settings = MockSettings()

# Now load the compression modules directly
token_counter = load_module_from_path(
    "token_counter", os.path.join(compression_path, "token_counter.py")
)
config_module = load_module_from_path(
    "config", os.path.join(compression_path, "config.py")
)
strategies = load_module_from_path(
    "strategies", os.path.join(compression_path, "strategies.py")
)
compressor = load_module_from_path(
    "compressor", os.path.join(compression_path, "compressor.py")
)

# Import classes from loaded modules
TokenCounter = token_counter.TokenCounter
ModelContextConfig = config_module.ModelContextConfig
CompressionConfig = config_module.CompressionConfig
get_model_context_config = config_module.get_model_context_config
AttachmentTruncationStrategy = strategies.AttachmentTruncationStrategy
HistoryTruncationStrategy = strategies.HistoryTruncationStrategy
CompressionResult = strategies.CompressionResult
MessageCompressor = compressor.MessageCompressor


def test_token_counter():
    """Test token counting functionality."""
    print("\n=== Testing TokenCounter ===")

    # Test 1: Provider detection
    counter_gpt = TokenCounter("gpt-4")
    assert counter_gpt.provider == "openai", f"Expected openai, got {counter_gpt.provider}"
    print(f"[PASS] GPT-4 provider: {counter_gpt.provider}")

    counter_claude = TokenCounter("claude-3-5-sonnet-20241022")
    assert counter_claude.provider == "anthropic", f"Expected anthropic, got {counter_claude.provider}"
    print(f"[PASS] Claude provider: {counter_claude.provider}")

    counter_gemini = TokenCounter("gemini-1.5-pro")
    assert counter_gemini.provider == "google", f"Expected google, got {counter_gemini.provider}"
    print(f"[PASS] Gemini provider: {counter_gemini.provider}")

    # Test 2: Text counting
    counter = TokenCounter("gpt-4")
    count = counter.count_text("Hello, world!")
    assert count > 0, "Token count should be positive"
    print(f"[PASS] Text token count: {count}")

    # Test 3: Empty text
    empty_count = counter.count_text("")
    assert empty_count == 0, "Empty text should have 0 tokens"
    print(f"[PASS] Empty text token count: {empty_count}")

    # Test 4: Message counting
    messages = [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "What is the capital of France?"},
        {"role": "assistant", "content": "The capital of France is Paris."},
    ]
    msg_count = counter.count_messages(messages)
    assert msg_count > 0, "Message token count should be positive"
    print(f"[PASS] Messages token count: {msg_count}")

    # Test 5: Over limit check
    assert not counter.is_over_limit(messages, 10000), "Should not be over 10000 limit"
    assert counter.is_over_limit(messages, 1), "Should be over 1 token limit"
    print(f"[PASS] Over limit checks passed")

    print("=== TokenCounter tests PASSED ===")


def test_model_context_config():
    """Test model context configuration."""
    print("\n=== Testing ModelContextConfig ===")

    # Test 1: Effective limit calculation
    config = ModelContextConfig(
        context_window=200000,
        output_tokens=8192,
        safety_margin=0.90,
    )
    expected = int((200000 - 8192) * 0.90)
    assert config.effective_limit == expected, f"Expected {expected}, got {config.effective_limit}"
    print(f"[PASS] Effective limit: {config.effective_limit}")

    # Test 2: Claude model config
    claude_config = get_model_context_config("claude-3-5-sonnet-20241022")
    assert claude_config.context_window == 200000, f"Expected 200000, got {claude_config.context_window}"
    print(f"[PASS] Claude context window: {claude_config.context_window}")

    # Test 3: GPT-4 config
    gpt_config = get_model_context_config("gpt-4o")
    assert gpt_config.context_window == 128000, f"Expected 128000, got {gpt_config.context_window}"
    print(f"[PASS] GPT-4o context window: {gpt_config.context_window}")

    # Test 4: Unknown model
    unknown_config = get_model_context_config("unknown-model-xyz")
    assert unknown_config.context_window == 128000, "Unknown model should use default"
    print(f"[PASS] Unknown model defaults: {unknown_config.context_window}")

    print("=== ModelContextConfig tests PASSED ===")


def test_attachment_truncation():
    """Test attachment truncation strategy."""
    print("\n=== Testing AttachmentTruncationStrategy ===")

    strategy = AttachmentTruncationStrategy()
    counter = TokenCounter("gpt-4")

    # Test 1: Long attachment truncation
    config = CompressionConfig(attachment_truncate_length=50, min_attachment_length=10)
    long_content = "[Attachment 1 - doc.pdf]" + "x" * 200
    messages = [{"role": "user", "content": long_content}]

    compressed, details = strategy.compress(messages, counter, 10000, config)
    assert len(compressed[0]["content"]) < len(long_content), "Content should be truncated"
    assert details["attachments_truncated"] == 1, "One attachment should be truncated"
    print(f"[PASS] Truncated attachment: {details}")

    # Test 2: Short attachment not truncated
    config2 = CompressionConfig(attachment_truncate_length=1000, min_attachment_length=500)
    short_content = "[Attachment 1 - doc.pdf]short"
    messages2 = [{"role": "user", "content": short_content}]

    compressed2, details2 = strategy.compress(messages2, counter, 10000, config2)
    assert compressed2[0]["content"] == short_content, "Short content should not change"
    assert details2["attachments_truncated"] == 0, "No attachment should be truncated"
    print(f"[PASS] Short attachment preserved: {details2}")

    # Test 3: No attachment content
    no_attachment = [{"role": "user", "content": "Regular message without attachment"}]
    compressed3, details3 = strategy.compress(no_attachment, counter, 10000, config)
    assert compressed3 == no_attachment, "Non-attachment messages unchanged"
    print(f"[PASS] Non-attachment message preserved")

    print("=== AttachmentTruncationStrategy tests PASSED ===")


def test_history_truncation():
    """Test history truncation strategy."""
    print("\n=== Testing HistoryTruncationStrategy ===")

    strategy = HistoryTruncationStrategy()
    counter = TokenCounter("gpt-4")

    # Test 1: Long history truncation
    config = CompressionConfig(first_messages_to_keep=1, last_messages_to_keep=2)
    messages = [{"role": "system", "content": "System prompt"}]
    for i in range(10):
        messages.append({"role": "user", "content": f"Message {i}"})
        messages.append({"role": "assistant", "content": f"Response {i}"})

    compressed, details = strategy.compress(messages, counter, 200, config)
    assert len(compressed) < len(messages), "History should be truncated"
    assert details["messages_removed"] > 0, "Some messages should be removed"
    print(f"[PASS] Truncated history: {details}")

    # Test 2: Short history not truncated
    short_messages = [
        {"role": "system", "content": "System"},
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "Hi"},
    ]
    config2 = CompressionConfig(first_messages_to_keep=2, last_messages_to_keep=3)
    compressed2, details2 = strategy.compress(short_messages, counter, 10000, config2)
    assert len(compressed2) == len(short_messages), "Short history unchanged"
    assert details2["messages_removed"] == 0, "No messages should be removed"
    print(f"[PASS] Short history preserved: {details2}")

    print("=== HistoryTruncationStrategy tests PASSED ===")


def test_message_compressor():
    """Test main MessageCompressor class."""
    print("\n=== Testing MessageCompressor ===")

    # Test 1: No compression needed
    config = CompressionConfig()
    compressor = MessageCompressor("claude-3-5-sonnet-20241022", config=config)

    messages = [
        {"role": "system", "content": "You are helpful."},
        {"role": "user", "content": "Hello!"},
    ]

    result = compressor.compress_if_needed(messages)
    assert not result.was_compressed, "Short messages should not be compressed"
    assert result.tokens_saved == 0, "No tokens should be saved"
    print(f"[PASS] No compression needed: tokens={result.original_tokens}")

    # Test 2: CompressionResult properties
    result = CompressionResult(
        messages=[{"role": "user", "content": "test"}],
        original_tokens=1000,
        compressed_tokens=500,
        strategies_applied=["attachment_truncation"],
    )
    assert result.was_compressed is True
    assert result.tokens_saved == 500
    print(f"[PASS] CompressionResult properties: saved={result.tokens_saved}")

    # Test 3: Disabled compression
    disabled_config = CompressionConfig(enabled=False)
    disabled_compressor = MessageCompressor("gpt-4", config=disabled_config)

    long_messages = [
        {"role": "system", "content": "x" * 100000},
    ]

    disabled_result = disabled_compressor.compress_if_needed(long_messages)
    assert not disabled_result.was_compressed, "Disabled compression should not compress"
    print(f"[PASS] Disabled compression works")

    # Test 4: Token counting
    token_count = compressor.count_tokens(messages)
    assert token_count > 0, "Token count should be positive"
    print(f"[PASS] Token counting: {token_count}")

    print("=== MessageCompressor tests PASSED ===")


def main():
    """Run all tests."""
    print("=" * 60)
    print("Message Compression Module Tests")
    print("=" * 60)

    try:
        test_token_counter()
        test_model_context_config()
        test_attachment_truncation()
        test_history_truncation()
        test_message_compressor()

        print("\n" + "=" * 60)
        print("ALL TESTS PASSED!")
        print("=" * 60)
        return 0

    except AssertionError as e:
        print(f"\n[FAIL] Assertion error: {e}")
        import traceback
        traceback.print_exc()
        return 1
    except Exception as e:
        print(f"\n[FAIL] Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
