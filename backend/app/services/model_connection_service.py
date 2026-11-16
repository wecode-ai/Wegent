# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Provider connection checks shared by the Model management API."""

import logging
from typing import Optional

logger = logging.getLogger(__name__)


def _test_llm_connection(
    provider_type: str,
    model_id: str,
    api_key: str,
    base_url: Optional[str],
    custom_headers: dict,
    model_category_type: str,
) -> dict:
    """Test LLM API connection using LangChain.

    Supports OpenAI, OpenAI Responses API, Anthropic, and Gemini providers.

    Args:
        provider_type: Provider type (openai, openai-responses, anthropic, gemini)
        model_id: The model ID to test
        api_key: API key for the provider
        base_url: Optional base URL for the API
        custom_headers: Optional custom HTTP headers
        model_category_type: Type of model (llm, embedding, tts, stt, rerank)
    """
    # Handle non-LLM model types
    if model_category_type == "decision":
        from app.services.decision_model_service import test_decision_connection

        return test_decision_connection(
            provider_type, model_id, api_key, base_url or "", custom_headers
        )
    elif model_category_type == "embedding":
        return _test_embedding_connection(
            provider_type, model_id, api_key, base_url, custom_headers
        )
    elif model_category_type == "image" and provider_type == "gpt-image":
        from openai import OpenAI

        client = OpenAI(
            api_key=api_key,
            base_url=base_url.rstrip("/") if base_url else None,
            default_headers=custom_headers or None,
        )
        client.models.retrieve(model_id)
        return {
            "success": True,
            "message": f"Successfully connected to GPT Image model {model_id}",
        }
    elif model_category_type == "tts":
        return {
            "success": True,
            "message": f"TTS model {model_id} configured. Audio synthesis test requires actual audio output.",
        }
    elif model_category_type == "stt":
        return {
            "success": True,
            "message": f"STT model {model_id} configured. Audio transcription test requires actual audio input.",
        }
    elif model_category_type == "rerank":
        return {
            "success": True,
            "message": f"Rerank model {model_id} configured. Please verify with actual rerank request.",
        }

    # LLM test using LangChain
    if provider_type == "openai":
        from langchain_openai import ChatOpenAI

        chat_kwargs = {
            "model": model_id,
            "api_key": api_key,
            "max_tokens": 128,
        }
        if base_url:
            chat_kwargs["base_url"] = base_url
        if custom_headers:
            chat_kwargs["default_headers"] = custom_headers

        chat = ChatOpenAI(**chat_kwargs)
        chat.invoke("hi")
        return {
            "success": True,
            "message": f"Successfully connected to {model_id} using Chat Completions API",
        }

    elif provider_type == "openai-responses":
        from langchain_openai import ChatOpenAI

        chat_kwargs = {
            "model": model_id,
            "api_key": api_key,
            "max_tokens": 128,
            "use_responses_api": True,
        }
        if base_url:
            chat_kwargs["base_url"] = base_url
        if custom_headers:
            chat_kwargs["default_headers"] = custom_headers

        chat = ChatOpenAI(**chat_kwargs)
        chat.invoke("hi")
        return {
            "success": True,
            "message": f"Successfully connected to {model_id} using Responses API",
        }

    elif provider_type == "anthropic":
        from langchain_anthropic import ChatAnthropic

        chat_kwargs = {
            "model": model_id,
            "api_key": api_key,
            "max_tokens": 128,
        }
        if base_url:
            chat_kwargs["base_url"] = base_url
        if custom_headers:
            chat_kwargs["default_headers"] = custom_headers

        chat = ChatAnthropic(**chat_kwargs)
        chat.invoke("hi")
        return {
            "success": True,
            "message": f"Successfully connected to {model_id}",
        }

    elif provider_type == "gemini":
        from langchain_google_genai import ChatGoogleGenerativeAI

        chat_kwargs = {
            "model": model_id,
            "google_api_key": api_key,
            "max_output_tokens": 128,
        }
        # Note: ChatGoogleGenerativeAI doesn't support custom base_url or headers directly
        # For custom endpoints, users should use environment variables

        chat = ChatGoogleGenerativeAI(**chat_kwargs)
        chat.invoke("hi")
        return {
            "success": True,
            "message": f"Successfully connected to {model_id}",
        }

    elif provider_type == "gemini-deep-research":
        # Test Gemini Interaction API (Deep Research) by calling /v1beta/interactions
        import httpx

        # Determine the base URL for Gemini Interaction API
        # Default to Google's API if not provided
        interaction_base_url = (
            base_url.rstrip("/")
            if base_url
            else "https://generativelanguage.googleapis.com"
        )
        interaction_url = f"{interaction_base_url}/v1beta/interactions"

        # Build headers with API key
        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        }
        # Merge custom headers if provided
        if custom_headers:
            headers.update(custom_headers)

        # Build test payload following the Gemini Interaction API format
        payload = {
            "background": True,
            "agent": model_id,  # e.g., "deep-research-preview-04-2026"
            "input": "hello",
        }

        try:
            # Make a test request to create an interaction
            # This should return 200 OK with an interaction ID if successful
            response = httpx.post(
                interaction_url,
                json=payload,
                headers=headers,
                timeout=30.0,
            )

            if response.status_code == 200:
                result = response.json()
                interaction_id = result.get("id", "unknown")
                return {
                    "success": True,
                    "message": f"Successfully connected to Gemini Deep Research API. Interaction ID: {interaction_id}",
                }
            else:
                error_msg = (
                    response.text[:200]
                    if response.text
                    else f"HTTP {response.status_code}"
                )
                return {
                    "success": False,
                    "message": f"Gemini Deep Research API error: {error_msg}",
                }
        except httpx.RequestError as e:
            return {
                "success": False,
                "message": f"Failed to connect to Gemini Deep Research API: {str(e)}",
            }

    else:
        return {
            "success": False,
            "message": f"Unsupported provider type: {provider_type}",
        }


def _test_embedding_connection(
    provider_type: str,
    model_id: str,
    api_key: str,
    base_url: Optional[str],
    custom_headers: dict,
) -> dict:
    """Test embedding model connection using LangChain."""
    if provider_type in ["openai", "openai-responses"]:
        from langchain_openai import OpenAIEmbeddings

        embeddings = OpenAIEmbeddings(
            model=model_id,
            api_key=api_key,
            base_url=base_url or "https://api.openai.com/v1",
            default_headers=custom_headers if custom_headers else None,
            check_embedding_ctx_length=False,
        )
        embeddings.embed_query("test")
        return {
            "success": True,
            "message": f"Successfully connected to embedding model {model_id}",
        }

    elif provider_type == "gemini":
        from langchain_google_genai import GoogleGenerativeAIEmbeddings

        embeddings = GoogleGenerativeAIEmbeddings(
            model=model_id,
            google_api_key=api_key,
        )
        embeddings.embed_query("test")
        return {
            "success": True,
            "message": f"Successfully connected to embedding model {model_id}",
        }

    elif provider_type == "custom":
        """Test custom OpenAI-compatible embedding API connection."""
        from langchain_openai import OpenAIEmbeddings

        if not base_url:
            return {
                "success": False,
                "message": "base_url is required for custom provider",
            }

        # Construct embeddings endpoint
        embeddings_base_url = base_url.rstrip("/")
        if embeddings_base_url.endswith("/embeddings"):
            embeddings_base_url = embeddings_base_url[: -len("/embeddings")]
        # Build kwargs for OpenAIEmbeddings
        embeddings_kwargs = {
            "model": model_id,
            "api_key": api_key,
            "base_url": embeddings_base_url,
            "check_embedding_ctx_length": False,
        }

        # Add custom headers if provided
        if custom_headers and isinstance(custom_headers, dict):
            embeddings_kwargs["default_headers"] = custom_headers

        try:
            embeddings = OpenAIEmbeddings(**embeddings_kwargs)
            embeddings.embed_query("test")
            return {
                "success": True,
                "message": f"Successfully connected to custom embedding model {model_id}",
            }
        except Exception as e:
            logger.error(f"Custom embedding connection test failed: {str(e)}")
            return {
                "success": False,
                "message": f"Custom embedding connection failed: {str(e)}",
            }

    else:
        return {
            "success": False,
            "message": f"Embedding not supported for provider: {provider_type}",
        }
