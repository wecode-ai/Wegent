# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field, fields
from typing import Any


@dataclass(frozen=True)
class EventReporterConfig:
    enabled: bool = False
    adv_attribution_enabled: bool = False
    adv_read_wiki_enabled: bool = False
    adv_model_storage_enabled: bool = False
    adv_quality_detail_enabled: bool = False
    adv_result_detail_limit: int = 10
    bootstrap_servers: str = ""
    topic: str = "knowledge-events-v1"
    environment: str = ""
    client_id: str = ""
    acks: str = "all"
    compression_type: str = "lz4"
    linger_ms: int = 20
    request_timeout_ms: int = 5_000
    delivery_timeout_ms: int = 5_000
    queue_max_bytes: int = 16 * 1024 * 1024
    event_max_bytes: int = 8 * 1024
    shutdown_timeout_ms: int = 8_000
    security_protocol: str = "PLAINTEXT"
    sasl_mechanism: str = "PLAIN"
    sasl_username: str = field(default="", repr=False)
    sasl_password: str = field(default="", repr=False)
    ssl_cafile: str = ""
    error: str | None = None

    @classmethod
    def from_env(cls, service_name: str) -> "EventReporterConfig":
        return cls.from_mapping(os.environ, service_name)

    @classmethod
    def from_mapping(
        cls, values: Mapping[str, Any], service_name: str
    ) -> EventReporterConfig:
        """Parse optional telemetry independently of fatal application settings."""
        defaults = cls()
        resolved: dict[str, Any] = {}
        try:
            for item in fields(cls):
                if item.name == "error":
                    continue
                name = (
                    "EVENT_REPORTING_ENABLED"
                    if item.name == "enabled"
                    else f"EVENT_KAFKA_{item.name.upper()}"
                )
                default = getattr(defaults, item.name)
                value = values.get(name, default)
                if isinstance(default, bool):
                    text = str(value).strip().lower()
                    if text not in {
                        "true",
                        "false",
                        "1",
                        "0",
                        "yes",
                        "no",
                        "on",
                        "off",
                    }:
                        raise ValueError("invalid boolean")
                    resolved[item.name] = text in {"true", "1", "yes", "on"}
                elif isinstance(default, int):
                    resolved[item.name] = int(value)
                else:
                    if not isinstance(value, str):
                        raise ValueError("invalid string")
                    resolved[item.name] = (
                        value if item.name == "sasl_password" else value.strip()
                    )
            resolved["client_id"] = (
                resolved["client_id"] or f"{service_name}-event-reporter"
            )
            return cls(**resolved)
        except (ValueError, TypeError, OverflowError):
            return cls(error="invalid_event_configuration")

    def validation_error(self) -> str | None:
        if self.error:
            return self.error
        if not self.enabled:
            return None
        if not self.bootstrap_servers:
            return "missing_bootstrap_servers"
        if not self.environment:
            return "missing_environment"
        if not self.topic:
            return "missing_topic"
        if self.queue_max_bytes <= 0:
            return "invalid_queue_max_bytes"
        if self.event_max_bytes <= 0:
            return "invalid_event_max_bytes"
        if self.event_max_bytes > self.queue_max_bytes:
            return "event_limit_exceeds_queue_limit"
        if self.event_max_bytes > 64 * 1024 or self.queue_max_bytes > 256 * 1024 * 1024:
            return "invalid_memory_limit"
        if self.linger_ms < 0:
            return "invalid_linger_ms"
        if self.request_timeout_ms <= 0:
            return "invalid_request_timeout_ms"
        if self.delivery_timeout_ms <= 0:
            return "invalid_delivery_timeout_ms"
        if self.shutdown_timeout_ms < 0:
            return "invalid_shutdown_timeout_ms"
        if not 0 <= self.adv_result_detail_limit <= 100:
            return "invalid_adv_result_detail_limit"
        if self.acks != "all":
            return "invalid_acks"
        if self.compression_type not in {"", "gzip", "snappy", "lz4", "zstd"}:
            return "invalid_compression"
        if self.security_protocol not in {
            "PLAINTEXT",
            "SSL",
            "SASL_PLAINTEXT",
            "SASL_SSL",
        }:
            return "invalid_security_protocol"
        if self.security_protocol.startswith("SASL"):
            if not self.sasl_username or not self.sasl_password:
                return "missing_sasl_credentials"
            if self.sasl_mechanism not in {"PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512"}:
                return "invalid_sasl_mechanism"
        return None
