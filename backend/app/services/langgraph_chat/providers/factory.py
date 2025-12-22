"""LLM provider factory."""

from ..config import config
from .anthropic_provider import AnthropicProvider
from .base import BaseLLMProvider
from .google_provider import GoogleProvider
from .openai_provider import OpenAIProvider


class ProviderFactory:
    """Factory for creating LLM providers."""

    _provider_map = {
        "openai": OpenAIProvider,
        "anthropic": AnthropicProvider,
        "google": GoogleProvider,
    }

    @classmethod
    def create_provider(
        cls,
        model: str,
        api_key: str | None = None,
        base_url: str | None = None,
        **kwargs,
    ) -> BaseLLMProvider:
        """Create LLM provider based on model name.

        Args:
            model: Model identifier (e.g., gpt-4o, claude-3-5-sonnet, gemini-2.0-flash)
            api_key: Optional API key override
            base_url: Optional base URL override
            **kwargs: Additional provider-specific parameters

        Returns:
            BaseLLMProvider instance

        Raises:
            ValueError: If provider cannot be determined from model name
        """
        provider_type = cls._detect_provider_type(model)

        if provider_type not in cls._provider_map:
            raise ValueError(f"Unknown provider for model: {model}")

        # Get API key from config if not provided
        if not api_key:
            api_key = cls._get_default_api_key(provider_type)

        # Get base URL from config if not provided
        if not base_url:
            base_url = cls._get_default_base_url(provider_type)

        provider_class = cls._provider_map[provider_type]
        return provider_class(model=model, api_key=api_key, base_url=base_url, **kwargs)

    @classmethod
    def _detect_provider_type(cls, model: str) -> str:
        """Detect provider type from model name.

        Args:
            model: Model identifier

        Returns:
            Provider type string
        """
        model_lower = model.lower()

        if any(prefix in model_lower for prefix in ["gpt-", "o1-", "text-embedding"]):
            return "openai"
        elif any(prefix in model_lower for prefix in ["claude-", "anthropic"]):
            return "anthropic"
        elif any(prefix in model_lower for prefix in ["gemini-", "palm-", "bison"]):
            return "google"

        raise ValueError(f"Cannot detect provider from model name: {model}")

    @classmethod
    def _get_default_api_key(cls, provider_type: str) -> str:
        """Get default API key from config.

        Args:
            provider_type: Provider type

        Returns:
            API key string

        Raises:
            ValueError: If API key not configured
        """
        key_map = {
            "openai": config.OPENAI_API_KEY,
            "anthropic": config.ANTHROPIC_API_KEY,
            "google": config.GOOGLE_API_KEY,
        }

        api_key = key_map.get(provider_type, "")
        if not api_key:
            raise ValueError(f"API key not configured for provider: {provider_type}")

        return api_key

    @classmethod
    def _get_default_base_url(cls, provider_type: str) -> str | None:
        """Get default base URL from config.

        Args:
            provider_type: Provider type

        Returns:
            Base URL string or None
        """
        if provider_type == "openai":
            return config.OPENAI_BASE_URL
        return None
