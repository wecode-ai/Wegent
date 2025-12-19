"""LangChain model wrappers for providers."""

from typing import Optional

from langchain_anthropic import ChatAnthropic
from langchain_core.language_models import BaseChatModel
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_openai import ChatOpenAI

from ..config import config


class LangChainModelFactory:
    """Factory for creating LangChain chat model instances."""

    @staticmethod
    def create_model(model: str, **kwargs) -> BaseChatModel:
        """Create LangChain model instance based on model name.

        Args:
            model: Model identifier (gpt-4o, claude-3-5-sonnet, gemini-2.0-flash, etc.)
            **kwargs: Additional parameters (temperature, max_tokens, etc.)

        Returns:
            BaseChatModel instance

        Raises:
            ValueError: If model provider is not supported
        """
        model_lower = model.lower()

        # OpenAI models
        if any(prefix in model_lower for prefix in ["gpt-", "o1-", "o3-"]):
            return ChatOpenAI(
                model=model,
                api_key=config.OPENAI_API_KEY,
                base_url=config.OPENAI_BASE_URL,
                temperature=kwargs.get("temperature", 1.0),
                max_tokens=kwargs.get("max_tokens"),
                streaming=kwargs.get("streaming", False),
            )

        # Anthropic models
        elif any(prefix in model_lower for prefix in ["claude-"]):
            return ChatAnthropic(
                model=model,
                api_key=config.ANTHROPIC_API_KEY,
                temperature=kwargs.get("temperature", 1.0),
                max_tokens=kwargs.get("max_tokens", 4096),
                streaming=kwargs.get("streaming", False),
            )

        # Google Gemini models
        elif any(prefix in model_lower for prefix in ["gemini-"]):
            return ChatGoogleGenerativeAI(
                model=model,
                google_api_key=config.GOOGLE_API_KEY,
                temperature=kwargs.get("temperature", 1.0),
                max_tokens=kwargs.get("max_tokens"),
                streaming=kwargs.get("streaming", False),
            )

        else:
            raise ValueError(f"Unsupported model: {model}")

    @staticmethod
    def is_supported(model: str) -> bool:
        """Check if model is supported.

        Args:
            model: Model identifier

        Returns:
            True if supported, False otherwise
        """
        model_lower = model.lower()
        supported_prefixes = ["gpt-", "o1-", "o3-", "claude-", "gemini-"]
        return any(prefix in model_lower for prefix in supported_prefixes)
