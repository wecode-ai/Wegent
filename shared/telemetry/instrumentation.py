# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenTelemetry instrumentation setup for all services.

This module provides auto-instrumentation for:
- FastAPI (HTTP requests/responses)
- SQLAlchemy (database queries) - optional
- Redis (cache operations) - optional
- HTTPX (async HTTP client)
- Requests (sync HTTP client)
- System metrics (CPU, memory, etc.)
"""

import logging
from typing import Any, Optional


def setup_opentelemetry_instrumentation(
    app: Any,
    logger: Optional[logging.Logger] = None,
    enable_sqlalchemy: bool = True,
    sqlalchemy_engine: Any = None,
    enable_redis: bool = True,
) -> None:
    """
    Setup OpenTelemetry instrumentation for a FastAPI service.

    Args:
        app: FastAPI application instance
        logger: Logger instance (optional, will create one if not provided)
        enable_sqlalchemy: Whether to enable SQLAlchemy instrumentation
        sqlalchemy_engine: SQLAlchemy engine instance (required if enable_sqlalchemy is True)
        enable_redis: Whether to enable Redis instrumentation
    """
    if logger is None:
        logger = logging.getLogger(__name__)

    _setup_fastapi_instrumentation(app, logger)

    if enable_sqlalchemy:
        _setup_sqlalchemy_instrumentation(logger, sqlalchemy_engine)

    if enable_redis:
        _setup_redis_instrumentation(logger)

    _setup_httpx_instrumentation(logger)
    _setup_requests_instrumentation(logger)
    _setup_system_metrics_instrumentation(logger)


def _setup_fastapi_instrumentation(app: Any, logger: logging.Logger) -> None:
    """Setup FastAPI instrumentation for tracing HTTP requests.

    Industry Standard for SSE/Streaming:
    ------------------------------------
    By default, OpenTelemetry ASGI instrumentation creates internal spans for each
    http.send and http.receive event. For SSE/streaming endpoints like /api/chat/stream,
    this creates excessive noise as each chunk generates a separate span.

    Industry Standard Solutions:
    1. Use `excluded_urls` to skip tracing for streaming endpoints entirely
    2. Use custom ASGI middleware with `exclude_send_receive_spans=True` (ASGI >= 0.45b0)
    3. Configure sampling to reduce the volume of these spans

    We implement option 2 when available, with automatic fallback behavior.

    References:
    - OpenTelemetry ASGI Instrumentation: https://opentelemetry-python-contrib.readthedocs.io/en/latest/instrumentation/asgi/asgi.html
    - GitHub Issue: https://github.com/open-telemetry/opentelemetry-python-contrib/issues/1075
    - Semantic Conventions: https://opentelemetry.io/docs/specs/semconv/http/
    """
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        from shared.telemetry.config import (get_excluded_urls_regex,
                                             get_http_capture_settings,
                                             get_otel_config)

        # Get HTTP capture settings
        capture_settings = get_http_capture_settings()

        # Get URL filtering configuration
        otel_config = get_otel_config()
        excluded_urls_regex = get_excluded_urls_regex()

        # Build hooks for capturing request/response data
        server_request_hook = None
        client_request_hook = None
        client_response_hook = None

        if capture_settings.get("capture_request_headers") or capture_settings.get(
            "capture_request_body"
        ):
            server_request_hook = _create_server_request_hook(capture_settings, logger)

        if capture_settings.get("capture_response_headers") or capture_settings.get(
            "capture_response_body"
        ):
            client_response_hook = _create_client_response_hook(
                capture_settings, logger
            )

        # Configure FastAPI instrumentation with URL filtering
        instrument_kwargs = {
            "server_request_hook": server_request_hook,
            "client_request_hook": client_request_hook,
            "client_response_hook": client_response_hook,
        }

        # Add excluded_urls if configured (blacklist mode)
        if excluded_urls_regex and not otel_config.included_urls:
            instrument_kwargs["excluded_urls"] = excluded_urls_regex
            logger.info(
                f"  URL blacklist enabled: {len(otel_config.excluded_urls)} patterns"
            )

        # Disable internal http.send/http.receive spans if configured
        # This is the industry standard approach to reduce noise from SSE/streaming endpoints
        # where each chunk would otherwise create a separate span
        #
        # The `exclude_spans` parameter is supported in opentelemetry-instrumentation-fastapi
        # It accepts a string to specify which spans to exclude: "send", "receive", or "send,receive"
        #
        # This parameter prevents the creation of internal spans with:
        # - asgi.event.type = http.response.body
        # - span.kind = internal
        if otel_config.disable_send_receive_spans:
            # Exclude both send and receive spans to reduce noise from streaming endpoints
            instrument_kwargs["exclude_spans"] = "send,receive"
            logger.info(
                "  Internal http.send/http.receive spans disabled (streaming-friendly mode)"
            )

        # Apply instrumentation
        try:
            FastAPIInstrumentor.instrument_app(app, **instrument_kwargs)
            logger.info("✓ FastAPI instrumentation enabled")
        except TypeError as e:
            # If exclude_spans is not supported, retry without it
            if "exclude_spans" in str(e) and otel_config.disable_send_receive_spans:
                logger.warning(
                    "  exclude_spans not supported in this version. "
                    "Upgrade opentelemetry-instrumentation-fastapi to disable "
                    "internal http.send/http.receive spans for streaming endpoints."
                )
                del instrument_kwargs["exclude_spans"]
                FastAPIInstrumentor.instrument_app(app, **instrument_kwargs)
                logger.info(
                    "✓ FastAPI instrumentation enabled (without streaming optimization)"
                )
            else:
                raise

        # Log capture settings
        if any(capture_settings.values()):
            enabled_captures = [k for k, v in capture_settings.items() if v]
            logger.info(f"  HTTP capture enabled for: {', '.join(enabled_captures)}")

        # Log URL filtering configuration
        if otel_config.included_urls:
            logger.info(f"  URL whitelist mode: {otel_config.included_urls}")
        elif otel_config.excluded_urls:
            logger.info(f"  URL blacklist: {otel_config.excluded_urls}")

    except ImportError:
        logger.debug("FastAPI instrumentation not available (package not installed)")
    except Exception as e:
        logger.warning(f"Failed to setup FastAPI instrumentation: {e}")


def _create_server_request_hook(capture_settings: dict, logger: logging.Logger):
    """Create a server request hook for capturing request headers, query params, and body."""

    def server_request_hook(span, scope):
        """Hook called when a request is received."""
        if span is None or not span.is_recording():
            return

        try:
            # Capture request headers
            if capture_settings.get("capture_request_headers"):
                headers = scope.get("headers", [])
                for header_name, header_value in headers:
                    # Decode bytes to string
                    name = (
                        header_name.decode("utf-8")
                        if isinstance(header_name, bytes)
                        else header_name
                    )
                    value = (
                        header_value.decode("utf-8")
                        if isinstance(header_value, bytes)
                        else header_value
                    )
                    # Skip sensitive headers
                    if name.lower() in ("authorization", "cookie", "set-cookie"):
                        value = "[REDACTED]"
                    span.set_attribute(f"http.request.header.{name}", value)

            # Capture query parameters
            if capture_settings.get("capture_request_body"):
                query_string = scope.get("query_string", b"")
                if query_string:
                    if isinstance(query_string, bytes):
                        query_string = query_string.decode("utf-8", errors="replace")
                    span.set_attribute("http.request.query_string", query_string)

                    # Parse query parameters into individual attributes
                    try:
                        from urllib.parse import parse_qs

                        params = parse_qs(query_string)
                        for key, values in params.items():
                            # Join multiple values with comma
                            value = ",".join(values)
                            # Redact sensitive parameters
                            if key.lower() in (
                                "password",
                                "token",
                                "api_key",
                                "apikey",
                                "secret",
                                "access_token",
                            ):
                                value = "[REDACTED]"
                            span.set_attribute(f"http.request.param.{key}", value)
                    except Exception:
                        pass  # If parsing fails, we still have the raw query_string

                # Capture path parameters from scope
                path_params = scope.get("path_params", {})
                if path_params:
                    for key, value in path_params.items():
                        span.set_attribute(f"http.request.path_param.{key}", str(value))

        except Exception as e:
            logger.debug(f"Error in server_request_hook: {e}")

    return server_request_hook


def _create_client_response_hook(capture_settings: dict, logger: logging.Logger):
    """Create a client response hook for capturing response headers and body."""

    def client_response_hook(span, message):
        """Hook called when a response is sent."""
        if span is None or not span.is_recording():
            return

        try:
            # Capture response headers
            if capture_settings.get("capture_response_headers"):
                headers = message.get("headers", [])
                for header_name, header_value in headers:
                    # Decode bytes to string
                    name = (
                        header_name.decode("utf-8")
                        if isinstance(header_name, bytes)
                        else header_name
                    )
                    value = (
                        header_value.decode("utf-8")
                        if isinstance(header_value, bytes)
                        else header_value
                    )
                    # Skip sensitive headers
                    if name.lower() in ("authorization", "cookie", "set-cookie"):
                        value = "[REDACTED]"
                    span.set_attribute(f"http.response.header.{name}", value)

            # Capture response body (be careful with large bodies)
            if capture_settings.get("capture_response_body"):
                body = message.get("body", b"")
                if body:
                    # Limit body size to avoid huge spans
                    max_body_size = 4096  # 4KB limit
                    if isinstance(body, bytes):
                        body_str = body[:max_body_size].decode(
                            "utf-8", errors="replace"
                        )
                    else:
                        body_str = str(body)[:max_body_size]

                    if len(body) > max_body_size:
                        body_str += f"... [truncated, total size: {len(body)} bytes]"

                    span.set_attribute("http.response.body", body_str)

        except Exception as e:
            logger.debug(f"Error in client_response_hook: {e}")

    return client_response_hook


def _setup_sqlalchemy_instrumentation(
    logger: logging.Logger, engine: Any = None
) -> None:
    """Setup SQLAlchemy instrumentation for tracing database queries."""
    try:
        from opentelemetry.instrumentation.sqlalchemy import \
            SQLAlchemyInstrumentor

        if engine is None:
            logger.warning(
                "SQLAlchemy instrumentation requested but no engine provided"
            )
            return

        # Handle async engine by getting sync_engine
        actual_engine = getattr(engine, "sync_engine", engine)
        SQLAlchemyInstrumentor().instrument(engine=actual_engine)
        logger.info("✓ SQLAlchemy instrumentation enabled")
    except ImportError:
        logger.debug("SQLAlchemy instrumentation not available (package not installed)")
    except Exception as e:
        logger.warning(f"Failed to setup SQLAlchemy instrumentation: {e}")


def _setup_redis_instrumentation(logger: logging.Logger) -> None:
    """Setup Redis instrumentation for tracing cache operations.

    Note: This may be a no-op if instrumentation was already set up early
    (before redis module import). We check is_instrumented() to avoid errors.
    """
    try:
        from opentelemetry.instrumentation.redis import RedisInstrumentor

        instrumentor = RedisInstrumentor()
        if instrumentor.is_instrumented_by_opentelemetry:
            logger.info("✓ Redis instrumentation already enabled (early setup)")
        else:
            instrumentor.instrument()
            logger.info("✓ Redis instrumentation enabled")
    except ImportError:
        logger.debug("Redis instrumentation not available (package not installed)")
    except Exception as e:
        logger.warning(f"Failed to setup Redis instrumentation: {e}")


def _setup_httpx_instrumentation(logger: logging.Logger) -> None:
    """Setup HTTPX instrumentation for tracing async HTTP client requests."""
    try:
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

        from shared.telemetry.config import get_http_capture_settings

        # Get HTTP capture settings
        capture_settings = get_http_capture_settings()

        # Build hooks for capturing request/response data
        # We need both sync and async hooks since OpenAI SDK uses async httpx
        request_hook = None
        response_hook = None
        async_request_hook = None
        async_response_hook = None

        if capture_settings.get("capture_request_headers") or capture_settings.get(
            "capture_request_body"
        ):
            request_hook = _create_httpx_request_hook(capture_settings, logger)
            async_request_hook = _create_httpx_async_request_hook(
                capture_settings, logger
            )

        if capture_settings.get("capture_response_headers") or capture_settings.get(
            "capture_response_body"
        ):
            response_hook = _create_httpx_response_hook(capture_settings, logger)
            async_response_hook = _create_httpx_async_response_hook(
                capture_settings, logger
            )

        HTTPXClientInstrumentor().instrument(
            request_hook=request_hook,
            response_hook=response_hook,
            async_request_hook=async_request_hook,
            async_response_hook=async_response_hook,
        )
        logger.info("✓ HTTPX instrumentation enabled")

        # Log capture settings
        if any(capture_settings.values()):
            enabled_captures = [k for k, v in capture_settings.items() if v]
            logger.info(f"  HTTPX capture enabled for: {', '.join(enabled_captures)}")

    except ImportError:
        logger.debug("HTTPX instrumentation not available (package not installed)")
    except Exception as e:
        logger.warning(f"Failed to setup HTTPX instrumentation: {e}")


def _create_httpx_request_hook(capture_settings: dict, logger: logging.Logger):
    """Create a request hook for HTTPX client to capture request headers and body."""

    def request_hook(span, request):
        """Hook called when an HTTPX request is made."""
        if span is None or not span.is_recording():
            return

        try:
            # Capture request headers
            if capture_settings.get("capture_request_headers"):
                for header_name, header_value in request.headers.items():
                    # Skip sensitive headers
                    if header_name.lower() in ("authorization", "cookie", "set-cookie"):
                        header_value = "[REDACTED]"
                    span.set_attribute(
                        f"http.request.header.{header_name}", header_value
                    )

            # Capture request body
            if capture_settings.get("capture_request_body"):
                try:
                    # HTTPX request body is in request.content
                    if hasattr(request, "content") and request.content:
                        body = request.content
                        max_body_size = capture_settings.get("max_body_size", 4096)
                        if isinstance(body, bytes):
                            if len(body) <= max_body_size:
                                body_str = body.decode("utf-8", errors="replace")
                            else:
                                body_str = (
                                    body[:max_body_size].decode(
                                        "utf-8", errors="replace"
                                    )
                                    + f"... [truncated, total size: {len(body)} bytes]"
                                )
                            span.set_attribute("http.request.body", body_str)
                except Exception as e:
                    logger.debug(f"Failed to capture HTTPX request body: {e}")

        except Exception as e:
            logger.debug(f"Error in HTTPX request_hook: {e}")

    return request_hook


def _create_httpx_response_hook(capture_settings: dict, logger: logging.Logger):
    """Create a response hook for HTTPX client to capture response headers and body."""

    def response_hook(span, request, response):
        """Hook called when an HTTPX response is received."""
        if span is None or not span.is_recording():
            return

        try:
            # Capture response headers
            if capture_settings.get("capture_response_headers"):
                for header_name, header_value in response.headers.items():
                    # Skip sensitive headers
                    if header_name.lower() in ("authorization", "cookie", "set-cookie"):
                        header_value = "[REDACTED]"
                    span.set_attribute(
                        f"http.response.header.{header_name}", header_value
                    )

            # Capture response body
            if capture_settings.get("capture_response_body"):
                try:
                    # HTTPX response body is in response.content
                    if hasattr(response, "content") and response.content:
                        body = response.content
                        max_body_size = capture_settings.get("max_body_size", 4096)
                        if isinstance(body, bytes):
                            if len(body) <= max_body_size:
                                body_str = body.decode("utf-8", errors="replace")
                            else:
                                body_str = (
                                    body[:max_body_size].decode(
                                        "utf-8", errors="replace"
                                    )
                                    + f"... [truncated, total size: {len(body)} bytes]"
                                )
                            span.set_attribute("http.response.body", body_str)
                except Exception as e:
                    logger.debug(f"Failed to capture HTTPX response body: {e}")

        except Exception as e:
            logger.debug(f"Error in HTTPX response_hook: {e}")

    return response_hook


def _create_httpx_async_request_hook(capture_settings: dict, logger: logging.Logger):
    """Create an async request hook for HTTPX client to capture request headers and body."""

    async def async_request_hook(span, request):
        """Async hook called when an HTTPX request is made."""
        if span is None or not span.is_recording():
            return

        try:
            # Capture request headers
            if capture_settings.get("capture_request_headers"):
                for header_name, header_value in request.headers.items():
                    # Skip sensitive headers
                    if header_name.lower() in ("authorization", "cookie", "set-cookie"):
                        header_value = "[REDACTED]"
                    span.set_attribute(
                        f"http.request.header.{header_name}", header_value
                    )

            # Capture request body
            if capture_settings.get("capture_request_body"):
                try:
                    body = None
                    max_body_size = capture_settings.get("max_body_size", 4096)

                    # Debug: Log request object attributes (use INFO level for visibility)
                    request_attrs = [
                        attr for attr in dir(request) if not attr.startswith("_")
                    ]
                    logger.debug(
                        f"[OTEL DEBUG] HTTPX request type: {type(request).__name__}, attrs: {request_attrs[:10]}..."
                    )

                    # Try different ways to get the request body
                    # Method 1: request.content (bytes) - most common
                    if hasattr(request, "content"):
                        content = request.content
                        content_preview = content[:100] if content else b"empty"
                        logger.debug(
                            f"[OTEL DEBUG] request.content type: {type(content)}, len: {len(content) if content else 0}, preview: {content_preview}"
                        )
                        if content:
                            body = content

                    # Method 2: request.stream (for streaming requests)
                    if body is None and hasattr(request, "stream"):
                        stream = request.stream
                        stream_attrs = [
                            attr for attr in dir(stream) if not attr.startswith("__")
                        ]
                        logger.debug(
                            f"[OTEL DEBUG] request.stream type: {type(stream).__name__}, attrs: {stream_attrs[:10]}"
                        )

                        # Try _stream first (ByteStream uses this)
                        if hasattr(stream, "_stream"):
                            inner_stream = stream._stream
                            logger.debug(
                                f"[OTEL DEBUG] Found stream._stream: {type(inner_stream)}"
                            )
                            if isinstance(inner_stream, bytes):
                                body = inner_stream
                                logger.debug(
                                    f"[OTEL DEBUG] _stream is bytes, len: {len(body)}"
                                )
                            elif hasattr(inner_stream, "read"):
                                # It's a file-like object (BytesIO), try to read and reset
                                try:
                                    current_pos = (
                                        inner_stream.tell()
                                        if hasattr(inner_stream, "tell")
                                        else 0
                                    )
                                    body = inner_stream.read()
                                    if hasattr(inner_stream, "seek"):
                                        inner_stream.seek(current_pos)
                                    logger.debug(
                                        f"[OTEL DEBUG] Read from _stream: {type(body)}, len: {len(body) if body else 0}"
                                    )
                                except Exception as read_err:
                                    logger.debug(
                                        f"[OTEL DEBUG] _stream read failed: {read_err}"
                                    )
                        # Fallback to _content
                        elif hasattr(stream, "_content") and stream._content:
                            body = stream._content
                            logger.debug(
                                f"[OTEL DEBUG] Found stream._content: {type(body)}, len: {len(body) if body else 0}"
                            )
                        elif hasattr(stream, "body") and stream.body:
                            body = stream.body
                            logger.debug(
                                f"[OTEL DEBUG] Found stream.body: {type(body)}"
                            )
                        elif hasattr(stream, "_body") and stream._body:
                            body = stream._body
                            logger.debug(
                                f"[OTEL DEBUG] Found stream._body: {type(body)}"
                            )

                    # Method 3: Check if request has _content attribute
                    if body is None and hasattr(request, "_content"):
                        body = request._content
                        logger.debug(
                            f"[OTEL DEBUG] Found request._content: {type(body)}"
                        )

                    # Method 4: Try to read from stream if it's a ByteStream
                    if body is None and hasattr(request, "stream"):
                        stream = request.stream
                        # Check if it's an IteratorByteStream or similar
                        stream_type = type(stream).__name__
                        logger.debug(f"[OTEL DEBUG] Stream type name: {stream_type}")

                        # For ByteStream, try to get the underlying bytes
                        if hasattr(stream, "__iter__"):
                            # Don't consume the iterator, just log that it exists
                            logger.info(
                                "[OTEL DEBUG] Stream is iterable, cannot capture without consuming"
                            )

                    if body:
                        if isinstance(body, bytes):
                            if len(body) <= max_body_size:
                                body_str = body.decode("utf-8", errors="replace")
                            else:
                                body_str = (
                                    body[:max_body_size].decode(
                                        "utf-8", errors="replace"
                                    )
                                    + f"... [truncated, total size: {len(body)} bytes]"
                                )
                            span.set_attribute("http.request.body", body_str)
                            logger.debug(
                                f"[OTEL DEBUG] Captured request body: {len(body)} bytes"
                            )
                        elif isinstance(body, str):
                            if len(body) <= max_body_size:
                                span.set_attribute("http.request.body", body)
                            else:
                                span.set_attribute(
                                    "http.request.body",
                                    body[:max_body_size]
                                    + f"... [truncated, total size: {len(body)} chars]",
                                )
                            logger.debug(
                                f"[OTEL DEBUG] Captured request body: {len(body)} chars"
                            )
                    else:
                        logger.info("[OTEL DEBUG] No request body found to capture")
                except Exception as e:
                    logger.warning(
                        f"[OTEL DEBUG] Failed to capture HTTPX async request body: {e}"
                    )

        except Exception as e:
            logger.debug(f"Error in HTTPX async_request_hook: {e}")

    return async_request_hook


def _create_httpx_async_response_hook(capture_settings: dict, logger: logging.Logger):
    """Create an async response hook for HTTPX client to capture response headers and body."""

    async def async_response_hook(span, request, response):
        """Async hook called when an HTTPX response is received."""
        if span is None or not span.is_recording():
            return

        try:
            # Capture response headers
            if capture_settings.get("capture_response_headers"):
                for header_name, header_value in response.headers.items():
                    # Skip sensitive headers
                    if header_name.lower() in ("authorization", "cookie", "set-cookie"):
                        header_value = "[REDACTED]"
                    span.set_attribute(
                        f"http.response.header.{header_name}", header_value
                    )

            # Capture response body
            if capture_settings.get("capture_response_body"):
                try:
                    # For async responses, we need to read the content
                    # Note: This may not work for streaming responses
                    if hasattr(response, "content") and response.content:
                        body = response.content
                        max_body_size = capture_settings.get("max_body_size", 4096)
                        if isinstance(body, bytes):
                            if len(body) <= max_body_size:
                                body_str = body.decode("utf-8", errors="replace")
                            else:
                                body_str = (
                                    body[:max_body_size].decode(
                                        "utf-8", errors="replace"
                                    )
                                    + f"... [truncated, total size: {len(body)} bytes]"
                                )
                            span.set_attribute("http.response.body", body_str)
                except Exception as e:
                    logger.debug(f"Failed to capture HTTPX async response body: {e}")

        except Exception as e:
            logger.debug(f"Error in HTTPX async_response_hook: {e}")

    return async_response_hook


def _create_requests_request_hook(capture_settings: dict, logger: logging.Logger):
    """Create a request hook for Requests library to capture request headers and body."""

    def request_hook(span, request):
        """Hook called when a Requests request is made."""
        if span is None or not span.is_recording():
            return

        try:
            # Capture request headers
            if capture_settings.get("capture_request_headers"):
                for header_name, header_value in request.headers.items():
                    # Skip sensitive headers
                    if header_name.lower() in ("authorization", "cookie", "set-cookie"):
                        header_value = "[REDACTED]"
                    span.set_attribute(
                        f"http.request.header.{header_name}", header_value
                    )

            # Capture request body
            if capture_settings.get("capture_request_body"):
                try:
                    # Requests body is in request.body
                    if hasattr(request, "body") and request.body:
                        body = request.body
                        max_body_size = capture_settings.get("max_body_size", 4096)
                        if isinstance(body, bytes):
                            if len(body) <= max_body_size:
                                body_str = body.decode("utf-8", errors="replace")
                            else:
                                body_str = (
                                    body[:max_body_size].decode(
                                        "utf-8", errors="replace"
                                    )
                                    + f"... [truncated, total size: {len(body)} bytes]"
                                )
                            span.set_attribute("http.request.body", body_str)
                        elif isinstance(body, str):
                            if len(body) <= max_body_size:
                                span.set_attribute("http.request.body", body)
                            else:
                                span.set_attribute(
                                    "http.request.body",
                                    body[:max_body_size]
                                    + f"... [truncated, total size: {len(body)} chars]",
                                )
                except Exception as e:
                    logger.debug(f"Failed to capture Requests request body: {e}")

        except Exception as e:
            logger.debug(f"Error in Requests request_hook: {e}")

    return request_hook


def _create_requests_response_hook(capture_settings: dict, logger: logging.Logger):
    """Create a response hook for Requests library to capture response headers and body."""

    def response_hook(span, request, response):
        """Hook called when a Requests response is received."""
        if span is None or not span.is_recording():
            return

        try:
            # Capture response headers
            if capture_settings.get("capture_response_headers"):
                for header_name, header_value in response.headers.items():
                    # Skip sensitive headers
                    if header_name.lower() in ("authorization", "cookie", "set-cookie"):
                        header_value = "[REDACTED]"
                    span.set_attribute(
                        f"http.response.header.{header_name}", header_value
                    )

            # Capture response body
            if capture_settings.get("capture_response_body"):
                try:
                    # Requests response body is in response.content or response.text
                    if hasattr(response, "content") and response.content:
                        body = response.content
                        max_body_size = capture_settings.get("max_body_size", 4096)
                        if isinstance(body, bytes):
                            if len(body) <= max_body_size:
                                body_str = body.decode("utf-8", errors="replace")
                            else:
                                body_str = (
                                    body[:max_body_size].decode(
                                        "utf-8", errors="replace"
                                    )
                                    + f"... [truncated, total size: {len(body)} bytes]"
                                )
                            span.set_attribute("http.response.body", body_str)
                except Exception as e:
                    logger.debug(f"Failed to capture Requests response body: {e}")

        except Exception as e:
            logger.debug(f"Error in Requests response_hook: {e}")

    return response_hook


def _setup_requests_instrumentation(logger: logging.Logger) -> None:
    """Setup Requests instrumentation for tracing sync HTTP client requests."""
    try:
        from opentelemetry.instrumentation.requests import RequestsInstrumentor

        from shared.telemetry.config import get_http_capture_settings

        # Get HTTP capture settings
        capture_settings = get_http_capture_settings()

        # Build hooks for capturing request/response data
        request_hook = None
        response_hook = None

        if capture_settings.get("capture_request_headers") or capture_settings.get(
            "capture_request_body"
        ):
            request_hook = _create_requests_request_hook(capture_settings, logger)

        if capture_settings.get("capture_response_headers") or capture_settings.get(
            "capture_response_body"
        ):
            response_hook = _create_requests_response_hook(capture_settings, logger)

        RequestsInstrumentor().instrument(
            request_hook=request_hook,
            response_hook=response_hook,
        )
        logger.info("✓ Requests instrumentation enabled")

        # Log capture settings
        if any(capture_settings.values()):
            enabled_captures = [k for k, v in capture_settings.items() if v]
            logger.info(
                f"  Requests capture enabled for: {', '.join(enabled_captures)}"
            )

    except ImportError:
        logger.debug("Requests instrumentation not available (package not installed)")
    except Exception as e:
        logger.warning(f"Failed to setup Requests instrumentation: {e}")


def _setup_system_metrics_instrumentation(logger: logging.Logger) -> None:
    """Setup system metrics instrumentation for CPU, memory, etc."""
    try:
        from opentelemetry.instrumentation.system_metrics import \
            SystemMetricsInstrumentor

        SystemMetricsInstrumentor().instrument()
        logger.info("✓ System metrics instrumentation enabled")
    except ImportError:
        logger.debug(
            "System metrics instrumentation not available (package not installed)"
        )
    except Exception as e:
        logger.warning(f"Failed to setup System metrics instrumentation: {e}")
