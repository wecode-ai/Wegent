# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from chat_shell.models.factory import LangChainModelFactory
from langchain_anthropic import ChatAnthropic
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_openai import ChatOpenAI


@pytest.mark.asyncio
async def test_create_openai_model():
    """Test creating OpenAI model."""
    config = {
        "model_id": "gpt-4",
        "model": "openai",
        "api_key": "sk-test",
        "base_url": "https://api.openai.com/v1",
        "default_headers": {"X-Test": "test"},
    }

    model = LangChainModelFactory.create_from_config(config, temperature=0.7)

    assert isinstance(model, ChatOpenAI)
    assert model.model_name == "gpt-4"
    assert model.openai_api_key.get_secret_value() == "sk-test"
    assert model.openai_api_base == "https://api.openai.com/v1"
    assert model.temperature == 0.7
    assert model.model_kwargs["extra_headers"] == {"X-Test": "test"}


@pytest.mark.asyncio
async def test_create_anthropic_model():
    """Test creating Anthropic model."""
    config = {
        "model_id": "claude-3-sonnet-20240229",
        "model": "anthropic",
        "api_key": "sk-ant-test",
    }

    model = LangChainModelFactory.create_from_config(config)

    assert isinstance(model, ChatAnthropic)
    assert model.model == "claude-3-sonnet-20240229"
    assert model.anthropic_api_key.get_secret_value() == "sk-ant-test"


@pytest.mark.asyncio
async def test_create_google_model():
    """Test creating Google model."""
    config = {
        "model_id": "gemini-1.5-pro",
        "model": "google",
        "api_key": "AIzaSyTest",
    }

    model = LangChainModelFactory.create_from_config(config)

    assert isinstance(model, ChatGoogleGenerativeAI)
    assert model.model == "gemini-1.5-pro"
    assert model.google_api_key.get_secret_value() == "AIzaSyTest"


def test_provider_detection():
    """Test provider detection logic."""
    # OpenAI
    assert LangChainModelFactory.get_provider("gpt-4") == "openai"
    assert LangChainModelFactory.get_provider("gpt-3.5-turbo") == "openai"
    assert LangChainModelFactory.get_provider("o1-preview") == "openai"

    # Anthropic
    assert LangChainModelFactory.get_provider("claude-3-opus") == "anthropic"

    # Google
    assert LangChainModelFactory.get_provider("gemini-1.5-flash") == "google"

    # Case insensitivity
    assert LangChainModelFactory.get_provider("GPT-4") == "openai"

    # Unknown
    assert LangChainModelFactory.get_provider("unknown-model") is None


def test_create_from_name():
    """Test creating model from name directly."""
    model = LangChainModelFactory.create_from_name(
        model_name="gpt-4o",
        api_key="sk-test",
    )

    assert isinstance(model, ChatOpenAI)
    assert model.model_name == "gpt-4o"


def test_create_openai_model_with_responses_api():
    """Test creating OpenAI model with Responses API format includes reasoning.encrypted_content."""
    config = {
        "model_id": "gpt-5.2",
        "model": "openai",
        "api_key": "sk-test",
        "api_format": "responses",  # Enable Responses API
    }

    model = LangChainModelFactory.create_from_config(config)

    assert isinstance(model, ChatOpenAI)
    assert model.model_name == "gpt-5.2"
    # Verify use_responses_api is enabled
    assert model.use_responses_api is True
    # Verify include parameter contains reasoning.encrypted_content
    # This is required for multi-turn conversations with reasoning models
    assert model.include == ["reasoning.encrypted_content"]


def test_create_openai_model_without_responses_api():
    """Test creating OpenAI model without Responses API does not set include."""
    config = {
        "model_id": "gpt-4o",
        "model": "openai",
        "api_key": "sk-test",
        # No api_format, uses default chat/completions
    }

    model = LangChainModelFactory.create_from_config(config)

    assert isinstance(model, ChatOpenAI)
    assert model.model_name == "gpt-4o"
    # Verify use_responses_api is not set (None or False)
    assert model.use_responses_api is None or model.use_responses_api is False
    # Verify include is not set
    assert model.include is None
