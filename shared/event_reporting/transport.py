# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import ssl
from typing import Protocol

from .config import EventReporterConfig


class EventTransport(Protocol):
    async def start(self) -> None: ...

    async def send(self, payload: bytes) -> None: ...

    async def stop(self) -> None: ...


class KafkaTransport:
    """Lazy aiokafka adapter used only when event reporting is enabled."""

    def __init__(self, config: EventReporterConfig) -> None:
        self._config = config
        self._producer = None

    async def start(self) -> None:
        from aiokafka import AIOKafkaProducer

        tls = None
        if self._config.security_protocol in {"SSL", "SASL_SSL"}:
            tls = ssl.create_default_context(cafile=self._config.ssl_cafile or None)
        self._producer = AIOKafkaProducer(
            bootstrap_servers=self._config.bootstrap_servers,
            client_id=self._config.client_id,
            acks=self._config.acks,
            compression_type=self._config.compression_type or None,
            linger_ms=self._config.linger_ms,
            request_timeout_ms=self._config.request_timeout_ms,
            security_protocol=self._config.security_protocol,
            sasl_mechanism=self._config.sasl_mechanism,
            sasl_plain_username=self._config.sasl_username or None,
            sasl_plain_password=self._config.sasl_password or None,
            ssl_context=tls,
        )
        await self._producer.start()

    async def send(self, payload: bytes) -> None:
        if self._producer is None:
            raise RuntimeError("Kafka transport is not started")
        await self._producer.send_and_wait(self._config.topic, payload)

    async def stop(self) -> None:
        if self._producer is not None:
            await self._producer.stop()
            self._producer = None
