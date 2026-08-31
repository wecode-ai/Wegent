# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.services.prompt_protection_evaluation import (
    DATASET_VERSION,
    EvaluationSample,
    load_evaluation_dataset,
    load_external_model_config,
    run_prompt_protection_evaluation,
)

DATASET_PATH = (
    Path(__file__).resolve().parents[2] / "evaluations/prompt_protection/v1.jsonl"
)


def _sample(
    sample_id: str,
    category: str,
    *,
    user_input: str | None = None,
) -> EvaluationSample:
    expected_risks = () if category == "legitimate" else (category,)
    return EvaluationSample(
        id=sample_id,
        dataset_version=DATASET_VERSION,
        policy_version="prompt-protection-v1",
        language="en",
        category=category,
        technique="test",
        expected_risks=expected_risks,
        team_name="Support",
        team_description="Answer support questions",
        system_prompt="Internal prompt sentinel",
        user_input=user_input or sample_id,
    )


def test_versioned_dataset_is_strict_bilingual_and_covers_required_techniques():
    samples = load_evaluation_dataset(DATASET_PATH)

    assert len(samples) == 60
    assert {sample.language for sample in samples} == {"zh-CN", "en"}
    assert {sample.category for sample in samples} == {
        "purpose_violation",
        "system_prompt_extraction",
        "default_knowledge_exfiltration",
        "legitimate",
    }
    techniques = {sample.technique for sample in samples}
    assert {
        "direct",
        "enumeration",
        "bulk_read",
        "verbatim",
        "role_play",
        "encoding_rewrite",
        "core_request",
        "supporting_request",
    } <= techniques


def test_dataset_rejects_policy_drift_and_extra_fields(tmp_path):
    payload = json.loads(DATASET_PATH.read_text(encoding="utf-8").splitlines()[0])
    payload["policy_version"] = "stale-policy"
    payload["unexpected"] = "field"
    path = tmp_path / "invalid.jsonl"
    path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(ValueError, match="schema"):
        load_evaluation_dataset(path)


def test_model_config_must_be_external_and_match_explicit_model(tmp_path):
    repository_root = tmp_path / "repository"
    repository_root.mkdir()
    external_config = tmp_path / "resolved-model.json"
    external_config.write_text(
        json.dumps(
            {
                "model_id": "guard-model",
                "base_url": "https://model.example/v1",
                "api_key": "credential-sentinel",
            }
        ),
        encoding="utf-8",
    )

    loaded = load_external_model_config(
        external_config,
        expected_model_id="guard-model",
        repository_root=repository_root,
    )

    assert loaded["api_key"] == "credential-sentinel"
    with pytest.raises(ValueError, match="model_id"):
        load_external_model_config(
            external_config,
            expected_model_id="another-model",
            repository_root=repository_root,
        )

    internal_config = repository_root / "model.json"
    internal_config.write_text(external_config.read_text(), encoding="utf-8")
    with pytest.raises(ValueError, match="仓库外"):
        load_external_model_config(
            internal_config,
            expected_model_id="guard-model",
            repository_root=repository_root,
        )


@pytest.mark.asyncio
async def test_mock_evaluation_runs_every_dataset_sample_once_through_production_gate():
    samples = load_evaluation_dataset(DATASET_PATH)
    expected_by_input = {
        sample.user_input: list(sample.expected_risks) for sample in samples
    }

    async def classify_once(**kwargs):
        protected_input = json.loads(kwargs["protected_input"])
        return json.dumps({"risks": expected_by_input[protected_input["user_input"]]})

    complete = AsyncMock(side_effect=classify_once)
    adapter = SimpleNamespace(complete=complete)

    report = await run_prompt_protection_evaluation(
        samples=samples,
        model_config={
            "model_id": "deterministic-mock",
            "base_url": "https://unused.example/v1",
        },
        model_id="deterministic-mock",
        model_adapter=adapter,
    )

    assert complete.await_count == len(samples)
    assert report.execution_status == "completed"
    assert report.effect_gate_status == "passed"
    assert report.metrics.purpose_violation_block_rate == 1.0
    assert report.metrics.system_prompt_extraction_block_rate == 1.0
    assert report.metrics.default_knowledge_exfiltration_block_rate == 1.0
    assert report.metrics.overall_attack_block_rate == 1.0
    assert report.metrics.normal_false_rejection_rate == 0.0
    assert report.metrics.fail_open_compliance_rate == 1.0


@pytest.mark.asyncio
async def test_technical_failures_fail_open_but_attack_still_fails_effect_gate():
    samples = (
        _sample("purpose-timeout", "purpose_violation"),
        _sample("system-parse", "system_prompt_extraction"),
        _sample("knowledge-block", "default_knowledge_exfiltration"),
        _sample("normal-allow", "legitimate"),
    )
    complete = AsyncMock(
        side_effect=[
            TimeoutError(),
            "not-json-model-output-sentinel",
            '{"risks":["default_knowledge_exfiltration"]}',
            '{"risks":[]}',
        ]
    )

    report = await run_prompt_protection_evaluation(
        samples=samples,
        model_config={
            "model_id": "deterministic-mock",
            "base_url": "https://unused.example/v1",
        },
        model_id="deterministic-mock",
        model_adapter=SimpleNamespace(complete=complete),
    )

    assert complete.await_count == len(samples)
    assert report.effect_gate_status == "failed"
    assert report.metrics.model_call_failure_count == 1
    assert report.metrics.parse_failure_count == 1
    assert report.metrics.fail_open_compliance_rate == 1.0
    assert report.failures.attack_false_negative_ids == (
        "purpose-timeout",
        "system-parse",
    )
    assert report.failures.model_call_failure_ids == ("purpose-timeout",)
    assert report.failures.parse_failure_ids == ("system-parse",)


@pytest.mark.asyncio
async def test_report_contains_only_metadata_metrics_and_sample_ids():
    content_sentinel = "PROTECTED-CONTENT-SENTINEL"
    credential_sentinel = "CREDENTIAL-SENTINEL"
    samples = (
        _sample("purpose-id", "purpose_violation", user_input=content_sentinel),
        _sample("system-id", "system_prompt_extraction"),
        _sample("knowledge-id", "default_knowledge_exfiltration"),
        _sample("normal-id", "legitimate"),
    )
    complete = AsyncMock(
        side_effect=[
            '{"risks":["purpose_violation"]}',
            '{"risks":["system_prompt_extraction"]}',
            '{"risks":["default_knowledge_exfiltration"]}',
            '{"risks":[]}',
        ]
    )

    report = await run_prompt_protection_evaluation(
        samples=samples,
        model_config={
            "model_id": "deterministic-mock",
            "base_url": "https://unused.example/v1",
            "api_key": credential_sentinel,
        },
        model_id="deterministic-mock",
        model_adapter=SimpleNamespace(complete=complete),
    )
    serialized = json.dumps(report.to_safe_dict())

    assert content_sentinel not in serialized
    assert "Internal prompt sentinel" not in serialized
    assert credential_sentinel not in serialized
    assert "not-json-model-output-sentinel" not in serialized
    assert set(report.to_safe_dict()) == {
        "execution_status",
        "effect_gate_status",
        "model_id",
        "policy_version",
        "dataset_version",
        "evaluated_at",
        "sample_count",
        "metrics",
        "thresholds",
        "failures",
    }
