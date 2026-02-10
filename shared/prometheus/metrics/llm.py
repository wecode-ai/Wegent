# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""LLM and tool Prometheus metrics for Chat Shell.

Provides metrics for LLM calls, MCP tools, Skills, and Attachments:
- llm_requests_total: Counter for LLM API calls
- llm_request_duration_seconds: Histogram for LLM call latency
- llm_first_token_duration_seconds: Histogram for time to first token
- llm_tokens_total: Counter for token usage
- mcp_requests_total: Counter for MCP tool calls
- skill_requests_total: Counter for Skill invocations
- attachment_processing_total: Counter for attachment processing
"""

from typing import Optional

from prometheus_client import Counter, Histogram

from shared.prometheus.registry import get_registry

# Histogram buckets for LLM operations (longer than HTTP)
LLM_DURATION_BUCKETS = (
    0.1,
    0.5,
    1.0,
    2.0,
    5.0,
    10.0,
    20.0,
    30.0,
    60.0,
    120.0,
    300.0,
    600.0,
    float("inf"),
)

# Histogram buckets for first token latency
FIRST_TOKEN_BUCKETS = (
    0.1,
    0.25,
    0.5,
    0.75,
    1.0,
    1.5,
    2.0,
    3.0,
    5.0,
    10.0,
    float("inf"),
)

# Histogram buckets for MCP/Skill operations
TOOL_DURATION_BUCKETS = (
    0.1,
    0.25,
    0.5,
    1.0,
    2.5,
    5.0,
    10.0,
    30.0,
    60.0,
    float("inf"),
)


class LLMMetrics:
    """LLM metrics collection class.

    Provides metrics for monitoring LLM API performance:
    - Request counts by model and provider
    - Request latency distribution
    - First token latency for streaming
    - Token usage tracking
    """

    def __init__(self, registry=None):
        """Initialize LLM metrics.

        Args:
            registry: Optional Prometheus registry. Uses global registry if not provided.
        """
        self._registry = registry or get_registry()
        self._requests_total: Optional[Counter] = None
        self._request_duration: Optional[Histogram] = None
        self._first_token_duration: Optional[Histogram] = None
        self._tokens_total: Optional[Counter] = None

    @property
    def requests_total(self) -> Counter:
        """Get or create the LLM requests total counter."""
        if self._requests_total is None:
            self._requests_total = Counter(
                "llm_requests_total",
                "Total number of LLM API requests",
                labelnames=["model", "provider", "status"],
                registry=self._registry,
            )
        return self._requests_total

    @property
    def request_duration(self) -> Histogram:
        """Get or create the LLM request duration histogram."""
        if self._request_duration is None:
            self._request_duration = Histogram(
                "llm_request_duration_seconds",
                "LLM API request duration in seconds",
                labelnames=["model", "provider", "status"],
                buckets=LLM_DURATION_BUCKETS,
                registry=self._registry,
            )
        return self._request_duration

    @property
    def first_token_duration(self) -> Histogram:
        """Get or create the first token duration histogram."""
        if self._first_token_duration is None:
            self._first_token_duration = Histogram(
                "llm_first_token_duration_seconds",
                "Time to first token in LLM streaming response",
                labelnames=["model", "provider"],
                buckets=FIRST_TOKEN_BUCKETS,
                registry=self._registry,
            )
        return self._first_token_duration

    @property
    def tokens_total(self) -> Counter:
        """Get or create the tokens total counter."""
        if self._tokens_total is None:
            self._tokens_total = Counter(
                "llm_tokens_total",
                "Total number of tokens processed",
                labelnames=["model", "provider", "type"],
                registry=self._registry,
            )
        return self._tokens_total

    def observe_request(
        self,
        model: str,
        provider: str,
        status: str,
        duration_seconds: float,
    ) -> None:
        """Record a completed LLM request.

        Args:
            model: Model name (e.g., "claude-3-5-sonnet")
            provider: Provider name (e.g., "anthropic")
            status: Request status ("success", "error", "timeout")
            duration_seconds: Request duration in seconds
        """
        self.requests_total.labels(model=model, provider=provider, status=status).inc()
        self.request_duration.labels(
            model=model, provider=provider, status=status
        ).observe(duration_seconds)

    def observe_first_token(
        self,
        model: str,
        provider: str,
        duration_seconds: float,
    ) -> None:
        """Record time to first token.

        Args:
            model: Model name
            provider: Provider name
            duration_seconds: Time to first token in seconds
        """
        self.first_token_duration.labels(model=model, provider=provider).observe(
            duration_seconds
        )

    def record_tokens(
        self,
        model: str,
        provider: str,
        input_tokens: int = 0,
        output_tokens: int = 0,
    ) -> None:
        """Record token usage.

        Args:
            model: Model name
            provider: Provider name
            input_tokens: Number of input tokens
            output_tokens: Number of output tokens
        """
        if input_tokens > 0:
            self.tokens_total.labels(model=model, provider=provider, type="input").inc(
                input_tokens
            )
        if output_tokens > 0:
            self.tokens_total.labels(model=model, provider=provider, type="output").inc(
                output_tokens
            )


class MCPMetrics:
    """MCP tool metrics collection class.

    Provides metrics for monitoring MCP tool performance:
    - Request counts by server, tool, and status
    - Request latency distribution
    - Connection attempt counts and status
    - Disconnection counts
    - Tool discovery duration
    """

    def __init__(self, registry=None):
        """Initialize MCP metrics."""
        self._registry = registry or get_registry()
        self._requests_total: Optional[Counter] = None
        self._request_duration: Optional[Histogram] = None
        self._connections_total: Optional[Counter] = None
        self._disconnections_total: Optional[Counter] = None
        self._tool_discovery_duration: Optional[Histogram] = None

    @property
    def requests_total(self) -> Counter:
        """Get or create the MCP requests total counter."""
        if self._requests_total is None:
            self._requests_total = Counter(
                "mcp_requests_total",
                "Total number of MCP tool requests",
                labelnames=["server", "tool", "status"],
                registry=self._registry,
            )
        return self._requests_total

    @property
    def request_duration(self) -> Histogram:
        """Get or create the MCP request duration histogram."""
        if self._request_duration is None:
            self._request_duration = Histogram(
                "mcp_request_duration_seconds",
                "MCP tool request duration in seconds",
                labelnames=["server", "tool", "status"],
                buckets=TOOL_DURATION_BUCKETS,
                registry=self._registry,
            )
        return self._request_duration

    @property
    def connections_total(self) -> Counter:
        """Get or create the MCP connections total counter."""
        if self._connections_total is None:
            self._connections_total = Counter(
                "mcp_connections_total",
                "Total number of MCP server connection attempts",
                labelnames=["server", "status"],
                registry=self._registry,
            )
        return self._connections_total

    @property
    def disconnections_total(self) -> Counter:
        """Get or create the MCP disconnections total counter."""
        if self._disconnections_total is None:
            self._disconnections_total = Counter(
                "mcp_disconnections_total",
                "Total number of MCP server disconnections",
                labelnames=["server"],
                registry=self._registry,
            )
        return self._disconnections_total

    @property
    def tool_discovery_duration(self) -> Histogram:
        """Get or create the MCP tool discovery duration histogram."""
        if self._tool_discovery_duration is None:
            self._tool_discovery_duration = Histogram(
                "mcp_tool_discovery_duration_seconds",
                "Time taken to discover tools from MCP server",
                labelnames=["server", "status"],
                buckets=TOOL_DURATION_BUCKETS,
                registry=self._registry,
            )
        return self._tool_discovery_duration

    def observe_request(
        self,
        server: str,
        tool: str,
        status: str,
        duration_seconds: float,
    ) -> None:
        """Record a completed MCP tool request.

        Args:
            server: MCP server name
            tool: Tool name
            status: Request status ("success", "error", or "timeout")
            duration_seconds: Request duration in seconds
        """
        self.requests_total.labels(server=server, tool=tool, status=status).inc()
        self.request_duration.labels(server=server, tool=tool, status=status).observe(
            duration_seconds
        )

    def observe_connection(
        self,
        server: str,
        status: str,
    ) -> None:
        """Record an MCP server connection attempt.

        Args:
            server: MCP server name
            status: Connection status ("success", "error", or "timeout")
        """
        self.connections_total.labels(server=server, status=status).inc()

    def observe_disconnection(
        self,
        server: str,
    ) -> None:
        """Record an MCP server disconnection.

        Args:
            server: MCP server name
        """
        self.disconnections_total.labels(server=server).inc()

    def observe_tool_discovery(
        self,
        server: str,
        status: str,
        duration_seconds: float,
    ) -> None:
        """Record tool discovery duration for an MCP server.

        Args:
            server: MCP server name
            status: Discovery status ("success" or "error")
            duration_seconds: Discovery duration in seconds
        """
        self.tool_discovery_duration.labels(server=server, status=status).observe(
            duration_seconds
        )


class SkillMetrics:
    """Skill invocation metrics collection class."""

    def __init__(self, registry=None):
        """Initialize Skill metrics."""
        self._registry = registry or get_registry()
        self._requests_total: Optional[Counter] = None
        self._request_duration: Optional[Histogram] = None

    @property
    def requests_total(self) -> Counter:
        """Get or create the Skill requests total counter."""
        if self._requests_total is None:
            self._requests_total = Counter(
                "skill_requests_total",
                "Total number of Skill invocations",
                labelnames=["skill_name", "status"],
                registry=self._registry,
            )
        return self._requests_total

    @property
    def request_duration(self) -> Histogram:
        """Get or create the Skill request duration histogram."""
        if self._request_duration is None:
            self._request_duration = Histogram(
                "skill_request_duration_seconds",
                "Skill invocation duration in seconds",
                labelnames=["skill_name", "status"],
                buckets=TOOL_DURATION_BUCKETS,
                registry=self._registry,
            )
        return self._request_duration

    def observe_request(
        self,
        skill_name: str,
        status: str,
        duration_seconds: float,
    ) -> None:
        """Record a completed Skill invocation.

        Args:
            skill_name: Name of the skill
            status: Invocation status ("success" or "error")
            duration_seconds: Invocation duration in seconds
        """
        self.requests_total.labels(skill_name=skill_name, status=status).inc()
        self.request_duration.labels(skill_name=skill_name, status=status).observe(
            duration_seconds
        )


class AttachmentMetrics:
    """Attachment processing metrics collection class."""

    def __init__(self, registry=None):
        """Initialize Attachment metrics."""
        self._registry = registry or get_registry()
        self._processing_total: Optional[Counter] = None
        self._processing_duration: Optional[Histogram] = None

    @property
    def processing_total(self) -> Counter:
        """Get or create the attachment processing total counter."""
        if self._processing_total is None:
            self._processing_total = Counter(
                "attachment_processing_total",
                "Total number of attachment processing operations",
                labelnames=["type", "status"],
                registry=self._registry,
            )
        return self._processing_total

    @property
    def processing_duration(self) -> Histogram:
        """Get or create the attachment processing duration histogram."""
        if self._processing_duration is None:
            self._processing_duration = Histogram(
                "attachment_processing_duration_seconds",
                "Attachment processing duration in seconds",
                labelnames=["type", "status"],
                buckets=TOOL_DURATION_BUCKETS,
                registry=self._registry,
            )
        return self._processing_duration

    def observe_processing(
        self,
        attachment_type: str,
        status: str,
        duration_seconds: float,
    ) -> None:
        """Record attachment processing.

        Args:
            attachment_type: Type of attachment (e.g., "pdf", "image", "text")
            status: Processing status ("success" or "error")
            duration_seconds: Processing duration in seconds
        """
        self.processing_total.labels(type=attachment_type, status=status).inc()
        self.processing_duration.labels(type=attachment_type, status=status).observe(
            duration_seconds
        )


# Global instances
_llm_metrics: Optional[LLMMetrics] = None
_mcp_metrics: Optional[MCPMetrics] = None
_skill_metrics: Optional[SkillMetrics] = None
_attachment_metrics: Optional[AttachmentMetrics] = None


def get_llm_metrics() -> LLMMetrics:
    """Get the global LLM metrics instance."""
    global _llm_metrics
    if _llm_metrics is None:
        _llm_metrics = LLMMetrics()
    return _llm_metrics


def get_mcp_metrics() -> MCPMetrics:
    """Get the global MCP metrics instance."""
    global _mcp_metrics
    if _mcp_metrics is None:
        _mcp_metrics = MCPMetrics()
    return _mcp_metrics


def get_skill_metrics() -> SkillMetrics:
    """Get the global Skill metrics instance."""
    global _skill_metrics
    if _skill_metrics is None:
        _skill_metrics = SkillMetrics()
    return _skill_metrics


def get_attachment_metrics() -> AttachmentMetrics:
    """Get the global Attachment metrics instance."""
    global _attachment_metrics
    if _attachment_metrics is None:
        _attachment_metrics = AttachmentMetrics()
    return _attachment_metrics


def reset_llm_metrics() -> None:
    """Reset all LLM-related metrics (for testing)."""
    global _llm_metrics, _mcp_metrics, _skill_metrics, _attachment_metrics
    _llm_metrics = None
    _mcp_metrics = None
    _skill_metrics = None
    _attachment_metrics = None
