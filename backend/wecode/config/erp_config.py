# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
ERP configuration settings.

Reads ERP OpenSearch API v2 configuration from environment variables.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class ErpConfig(BaseSettings):
    """ERP OpenSearch API v2 configuration wrapper."""

    ERP_OPENSEARCH_BASE_URL: str = ""
    ERP_CLIENT_ID: str = ""
    ERP_CLIENT_secret: str = ""
    ERP_API_TIMEOUT: int = 30

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


erp_config = ErpConfig()
