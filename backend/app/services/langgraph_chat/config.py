"""LangGraph Chat Service configuration."""

import json
import logging
from typing import Dict, Any
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)


class LangGraphChatConfig(BaseSettings):
    """Configuration for LangGraph Chat Service."""

    model_config = SettingsConfigDict(env_prefix="LANGGRAPH_", case_sensitive=True)

    # Service switch
    CHAT_SERVICE_VERSION: str = "v1"  # v1=existing service, v2=LangGraph service

    # LLM configuration
    OPENAI_API_KEY: str = ""
    OPENAI_BASE_URL: str = "https://api.openai.com/v1"
    ANTHROPIC_API_KEY: str = ""
    GOOGLE_API_KEY: str = ""

    # Agent configuration
    DEFAULT_MAX_TOOL_ITERATIONS: int = 10
    TOOL_EXECUTION_TIMEOUT: int = 30  # seconds

    # MCP configuration
    CHAT_MCP_ENABLED: bool = False
    CHAT_MCP_SERVERS: str = "{}"  # JSON format

    # Skills configuration
    SKILLS_ENABLED: bool = True
    FILE_READER_MAX_LINES: int = 500

    # Redis configuration
    REDIS_CHECKPOINT_TTL: int = 3600  # checkpoint TTL (seconds)

    # OpenTelemetry configuration
    OTEL_ENABLED: bool = False
    OTEL_EXPORTER_ENDPOINT: str = ""
    OTEL_SERVICE_NAME: str = "langgraph-chat-service"

    def get_mcp_servers_config(self) -> Dict[str, Any]:
        """Parse MCP servers configuration from JSON string."""
        try:
            return json.loads(self.CHAT_MCP_SERVERS)
        except json.JSONDecodeError as e:
            logger.error(
                "Failed to parse CHAT_MCP_SERVERS JSON configuration: %s. Raw value: %s",
                str(e),
                self.CHAT_MCP_SERVERS,
            )
            return {}


# Global config instance
config = LangGraphChatConfig()
