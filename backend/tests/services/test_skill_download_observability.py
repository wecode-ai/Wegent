# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging

from starlette.responses import Response

from app.services.skill_download_observability import (
    SkillDownloadMetadata,
    add_skill_download_headers,
    begin_skill_download,
)


def test_skill_download_observation_records_safe_fields(caplog) -> None:
    observation = begin_skill_download("/api/v1/kinds/skills/42/download")
    assert observation is not None

    with caplog.at_level(
        logging.INFO,
        logger="app.services.skill_download_observability",
    ):
        duration_ms = observation.finish(
            metadata=SkillDownloadMetadata(
                skill_name="wegent-knowledge",
                cache_source="skill_binary",
                bytes_count=8192,
            ),
            status_code=200,
            request_id="skill-download-request",
        )

    assert duration_ms >= 0
    message = caplog.records[-1].message
    assert "skill_id=42" in message
    assert "skill_name=wegent-knowledge" in message
    assert "cache_source=skill_binary" in message
    assert "bytes=8192" in message
    assert "duration_ms=" in message
    assert "result=success" in message
    assert "inflight=" in message
    assert "status=200" in message
    assert "token" not in message.lower()


def test_skill_download_headers_encode_non_ascii_name() -> None:
    observation = begin_skill_download("/api/v1/kinds/skills/public/7/download")
    assert observation is not None
    metadata = SkillDownloadMetadata(
        skill_name="知识库 Skill",
        cache_source="skill_binary",
        bytes_count=12,
    )
    response = Response()

    add_skill_download_headers(
        response,
        observation=observation,
        metadata=metadata,
        backend_time_ms=3.5,
    )
    observation.finish(
        metadata=metadata,
        status_code=200,
        request_id="request-7",
    )

    assert response.headers["X-Wegent-Skill-Id"] == "7"
    assert (
        response.headers["X-Wegent-Skill-Name"] == "%E7%9F%A5%E8%AF%86%E5%BA%93%20Skill"
    )
    assert response.headers["X-Wegent-Skill-Cache-Source"] == "skill_binary"
    assert response.headers["X-Wegent-Skill-Bytes"] == "12"
    assert response.headers["X-Wegent-Backend-Time-Ms"] == "3.50"


def test_non_skill_download_path_is_ignored() -> None:
    assert begin_skill_download("/api/v1/kinds/skills/42") is None


def test_inflight_reflects_concurrent_backend_downloads(caplog) -> None:
    first = begin_skill_download("/api/v1/kinds/skills/1/download")
    second = begin_skill_download("/api/v1/kinds/skills/2/download")
    assert first is not None
    assert second is not None
    metadata = SkillDownloadMetadata(
        skill_name="wegent-knowledge",
        cache_source="skill_binary",
        bytes_count=1,
    )

    with caplog.at_level(
        logging.INFO,
        logger="app.services.skill_download_observability",
    ):
        second.finish(metadata=metadata, status_code=200, request_id="request-2")
        first.finish(metadata=metadata, status_code=200, request_id="request-1")

    observations = [
        record.message
        for record in caplog.records
        if record.message.startswith("skill download observed")
    ]
    assert "skill_id=2" in observations[0]
    assert "inflight=2" in observations[0]
    assert "skill_id=1" in observations[1]
    assert "inflight=1" in observations[1]
