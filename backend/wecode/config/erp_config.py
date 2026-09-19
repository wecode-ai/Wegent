# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
ERP configuration settings.

Reads ERP OpenSearch API v2 configuration from environment variables.
"""

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class ErpConfig(BaseSettings):
    """ERP OpenSearch API v2 configuration wrapper."""

    ERP_OPENSEARCH_BASE_URL: str = ""
    ERP_CLIENT_ID: str = ""
    ERP_CLIENT_secret: str = ""
    ERP_API_TIMEOUT: float = 1.0

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @model_validator(mode="after")
    def _check_consistency(self) -> "ErpConfig":
        """Reject partial configuration where some but not all of the
        ERP credentials are set, which silently breaks every ERP call.
        Either all three values are configured, or none are.
        """
        values = (
            self.ERP_OPENSEARCH_BASE_URL,
            self.ERP_CLIENT_ID,
            self.ERP_CLIENT_secret,
        )
        present = [bool(v) for v in values]
        if any(present) and not all(present):
            raise ValueError(
                "ERP config is partial: ERP_OPENSEARCH_BASE_URL, "
                "ERP_CLIENT_ID, and ERP_CLIENT_secret must all be set "
                "together, or all be empty."
            )
        return self


erp_config = ErpConfig()
