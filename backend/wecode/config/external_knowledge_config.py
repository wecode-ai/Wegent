# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""External knowledge configuration for internal providers."""

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class ExternalKnowledgeSettings(BaseSettings):
    """Configuration for read-only external knowledge providers."""

    AP_KNOWLEDGE_BASE_URL: str = (
        "https://apgateway.erp.sina.com.cn/proxy/" "test-knowledge-matrix.api.weibo.com"
    )
    AP_KNOWLEDGE_SYSTEM_TOKEN: str = ""
    AP_KNOWLEDGE_TENANT_ID: str = "Wegent"
    AP_KNOWLEDGE_TIMEOUT: float = 30.0
    AP_KNOWLEDGE_MCP_PATH: str = "/mcp/knowledge-external/sse"
    AP_KNOWLEDGE_HEALTH_PATH: str = "/mcp/knowledge-external/health"
    AP_KNOWLEDGE_IFRAME_HOSTS: set[str] = Field(
        default_factory=lambda: {"apgateway.erp.sina.com.cn"}
    )

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def ap_mcp_url(self) -> str:
        """Return the full AP MCP JSON-RPC endpoint URL."""
        return self._join_url(self.AP_KNOWLEDGE_BASE_URL, self.AP_KNOWLEDGE_MCP_PATH)

    @property
    def ap_health_url(self) -> str:
        """Return the full AP health endpoint URL."""
        return self._join_url(self.AP_KNOWLEDGE_BASE_URL, self.AP_KNOWLEDGE_HEALTH_PATH)

    @staticmethod
    def _join_url(base_url: str, path: str) -> str:
        return f"{base_url.rstrip('/')}/{path.lstrip('/')}"


external_knowledge_settings = ExternalKnowledgeSettings()
