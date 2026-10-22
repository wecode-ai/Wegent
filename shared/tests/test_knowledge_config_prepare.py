# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Contract tests for the pure knowledge configuration module.

The module composes and validates knowledge retrieval configuration without
touching Wegent product tables. These tests drive it through a minimal caller
that only supplies authorized candidates and records, exactly like the second
service that reuses the module.
"""

from __future__ import annotations

import json
import subprocess
import sys
import textwrap
from typing import Any, Mapping

import pytest

from shared.knowledge_module import (
    DEFAULT_SCORE_THRESHOLD,
    DEFAULT_TOP_K,
    KnowledgeConfigError,
    RetrievalProfileRecord,
    RetrievalResource,
    evaluate_profile,
    prepare_knowledge_config,
    validate_knowledge_config,
    validate_retrieval_config_update,
)

_MISSING = object()


class _FakeAdapter:
    """Minimal caller adapter: only authorized candidates and stored records."""

    def __init__(
        self,
        *,
        profile: RetrievalProfileRecord | None = None,
        retriever: RetrievalResource | None = None,
        embedding_model: RetrievalResource | None = None,
        resolvers: dict[tuple[str, str], RetrievalResource | None] | None = None,
    ) -> None:
        self.profile = profile or RetrievalProfileRecord()
        self.retriever = retriever
        self.embedding_model = embedding_model
        self.resolvers = resolvers or {}
        self.default_retriever_calls: list[str] = []
        self.default_embedding_calls: list[str] = []
        self.resolved_retriever_calls: list[tuple[str, str]] = []
        self.resolved_embedding_calls: list[tuple[str, str]] = []

    def retrieval_profile(self) -> RetrievalProfileRecord:
        return self.profile

    def default_retriever(self, namespace: str) -> RetrievalResource | None:
        self.default_retriever_calls.append(namespace)
        return self.retriever

    def default_embedding_model(self, namespace: str) -> RetrievalResource | None:
        self.default_embedding_calls.append(namespace)
        return self.embedding_model

    def resolve_retriever(self, name: str, namespace: str) -> RetrievalResource | None:
        """Authorize a reference unless a test overrides it."""
        self.resolved_retriever_calls.append((name, namespace))
        override = self.resolvers.get((name, namespace), _MISSING)
        if override is not _MISSING:
            return override
        return RetrievalResource(name=name, kind="Retriever", namespace=namespace)

    def resolve_embedding_model(
        self, name: str, namespace: str
    ) -> RetrievalResource | None:
        self.resolved_embedding_calls.append((name, namespace))
        override = self.resolvers.get((name, namespace), _MISSING)
        if override is not _MISSING:
            return override
        return RetrievalResource(
            name=name, kind="Model", category="embedding", namespace=namespace
        )


def _valid_profile() -> RetrievalProfileRecord:
    return RetrievalProfileRecord(
        configured={
            "retriever_name": "profile-retriever",
            "retriever_namespace": "default",
            "embedding_config": {
                "model_name": "profile-embedding",
                "model_namespace": "default",
            },
            "retrieval_mode": "hybrid",
            "top_k": 8,
            "score_threshold": 0.3,
            "hybrid_weights": {"vector_weight": 0.6, "keyword_weight": 0.4},
        },
        retriever=RetrievalResource(name="profile-retriever", kind="Retriever"),
        embedding_model=RetrievalResource(
            name="profile-embedding", kind="Model", category="embedding"
        ),
    )


def test_explicit_input_wins_over_profile_and_candidates() -> None:
    adapter = _FakeAdapter(
        profile=_valid_profile(),
        retriever=RetrievalResource(name="candidate-retriever", kind="Retriever"),
        embedding_model=RetrievalResource(
            name="candidate-embedding", kind="Model", category="embedding"
        ),
    )

    config = prepare_knowledge_config(
        adapter,
        retrieval_config={
            "retriever_name": "requested-retriever",
            "embedding_config": {"model_name": "requested-embedding"},
            "retrieval_mode": "vector",
            "top_k": 3,
        },
    )

    assert config == {
        "retriever_name": "requested-retriever",
        "retriever_namespace": "default",
        "embedding_config": {
            "model_name": "requested-embedding",
            "model_namespace": "default",
        },
        "retrieval_mode": "vector",
        "top_k": 3,
        "score_threshold": 0.3,
        "hybrid_weights": {"vector_weight": 0.6, "keyword_weight": 0.4},
    }
    assert adapter.default_retriever_calls == []
    assert adapter.default_embedding_calls == []


def test_explicit_resource_arguments_fill_missing_profile_fields() -> None:
    adapter = _FakeAdapter(profile=_valid_profile())

    config = prepare_knowledge_config(
        adapter,
        retriever_name="argument-retriever",
        embedding_model_name="argument-embedding",
    )

    assert config is not None
    assert config["retriever_name"] == "argument-retriever"
    assert config["embedding_config"] == {
        "model_name": "argument-embedding",
        "model_namespace": "default",
    }
    assert config["retrieval_mode"] == "hybrid"


def test_missing_profile_falls_back_to_authorized_candidates() -> None:
    adapter = _FakeAdapter(
        retriever=RetrievalResource(name="candidate-retriever", kind="Retriever"),
        embedding_model=RetrievalResource(
            name="candidate-embedding", kind="Model", category="embedding"
        ),
    )

    config = prepare_knowledge_config(adapter, namespace="team-a")

    assert config == {
        "retriever_name": "candidate-retriever",
        "retriever_namespace": "default",
        "embedding_config": {
            "model_name": "candidate-embedding",
            "model_namespace": "default",
        },
        "retrieval_mode": "vector",
        "top_k": DEFAULT_TOP_K,
        "score_threshold": DEFAULT_SCORE_THRESHOLD,
    }
    assert adapter.default_retriever_calls == ["team-a"]
    assert adapter.default_embedding_calls == ["team-a"]


def test_invalid_profile_record_is_ignored() -> None:
    """A stored profile whose resources are not authorized is not usable."""
    adapter = _FakeAdapter(
        profile=RetrievalProfileRecord(
            configured={
                "retriever_name": "revoked",
                "embedding_config": {"model_name": "revoked"},
            }
        ),
        retriever=RetrievalResource(name="candidate-retriever", kind="Retriever"),
        embedding_model=RetrievalResource(
            name="candidate-embedding", kind="Model", category="embedding"
        ),
    )

    config = prepare_knowledge_config(adapter)

    assert config is not None
    assert config["retriever_name"] == "candidate-retriever"


def test_returns_none_when_no_retriever_or_embedding_is_available() -> None:
    assert prepare_knowledge_config(_FakeAdapter()) is None


def test_disabled_mode_returns_none_without_consulting_candidates() -> None:
    adapter = _FakeAdapter(
        retriever=RetrievalResource(name="candidate-retriever", kind="Retriever"),
        embedding_model=RetrievalResource(
            name="candidate-embedding", kind="Model", category="embedding"
        ),
    )

    assert prepare_knowledge_config(adapter, rag_config_mode="disabled") is None
    assert adapter.default_retriever_calls == []
    assert adapter.default_embedding_calls == []


def test_rejects_authorized_candidate_of_wrong_category() -> None:
    adapter = _FakeAdapter(
        retriever=RetrievalResource(name="candidate-retriever", kind="Retriever"),
        embedding_model=RetrievalResource(
            name="chat-model", kind="Model", category="llm"
        ),
    )

    with pytest.raises(KnowledgeConfigError, match="embedding"):
        prepare_knowledge_config(adapter)


def test_rejects_profile_whose_resolved_embedding_is_not_a_model_embedding() -> None:
    """The module decides profile validity from the resolved record categories."""
    profile = RetrievalProfileRecord(
        configured={
            "retriever_name": "shared-retriever",
            "embedding_config": {"model_name": "chat-model"},
        },
        retriever=RetrievalResource(name="shared-retriever", kind="Retriever"),
        embedding_model=RetrievalResource(
            name="chat-model", kind="Model", category="llm"
        ),
    )

    assert evaluate_profile(profile) == {
        "status": "invalid",
        "fallback_reason": "embedding_model_unavailable",
    }
    assert prepare_knowledge_config(_FakeAdapter(profile=profile)) is None


def test_profile_resolution_must_match_the_configured_references() -> None:
    """A resolved record for another reference does not vouch for this profile."""
    profile = RetrievalProfileRecord(
        configured={
            "retriever_name": "shared-retriever",
            "embedding_config": {"model_name": "shared-embedding"},
        },
        retriever=RetrievalResource(name="some-other-retriever", kind="Retriever"),
        embedding_model=RetrievalResource(
            name="shared-embedding", kind="Model", category="embedding"
        ),
    )

    assert evaluate_profile(profile) == {
        "status": "invalid",
        "fallback_reason": "retriever_unavailable",
    }
    assert prepare_knowledge_config(_FakeAdapter(profile=profile)) is None


def test_authorizes_the_references_selected_by_priority() -> None:
    """The final retriever and embedding references are checked for authorization."""
    adapter = _FakeAdapter(
        retriever=RetrievalResource(name="candidate-retriever", kind="Retriever"),
        embedding_model=RetrievalResource(
            name="candidate-embedding", kind="Model", category="embedding"
        ),
    )

    config = prepare_knowledge_config(
        adapter,
        namespace="team-a",
        retrieval_config={"retriever_name": "chosen-retriever"},
    )

    assert config is not None
    assert config["retriever_name"] == "chosen-retriever"
    assert config["embedding_config"]["model_name"] == "candidate-embedding"
    assert adapter.resolved_retriever_calls == [("chosen-retriever", "default")]
    assert adapter.resolved_embedding_calls == [("candidate-embedding", "default")]


def test_accepts_a_public_fallback_resolved_outside_the_requested_namespace() -> None:
    """A group reference may legitimately resolve to the public resource."""
    adapter = _FakeAdapter(
        embedding_model=RetrievalResource(
            name="public-embedding", kind="Model", category="embedding"
        ),
        resolvers={
            ("public-retriever", "team-a"): RetrievalResource(
                name="public-retriever", kind="Retriever", namespace="default"
            )
        },
    )

    config = prepare_knowledge_config(
        adapter,
        namespace="team-a",
        retrieval_config={
            "retriever_name": "public-retriever",
            "retriever_namespace": "team-a",
        },
    )

    assert config is not None
    assert config["retriever_name"] == "public-retriever"
    assert config["retriever_namespace"] == "team-a"
    assert config["embedding_config"] == {
        "model_name": "public-embedding",
        "model_namespace": "default",
    }


def test_rejects_an_unauthorized_or_missing_reference() -> None:
    adapter = _FakeAdapter(
        embedding_model=RetrievalResource(
            name="candidate-embedding", kind="Model", category="embedding"
        ),
        resolvers={("not-mine", "default"): None},
    )

    with pytest.raises(KnowledgeConfigError, match="not-mine"):
        prepare_knowledge_config(
            adapter, retrieval_config={"retriever_name": "not-mine"}
        )


def test_rejects_a_resolved_reference_of_the_wrong_category() -> None:
    adapter = _FakeAdapter(
        retriever=RetrievalResource(name="candidate-retriever", kind="Retriever"),
        resolvers={
            ("chat-model", "default"): RetrievalResource(
                name="chat-model", kind="Model", category="llm"
            )
        },
    )

    with pytest.raises(KnowledgeConfigError, match="chat-model"):
        prepare_knowledge_config(
            adapter,
            retrieval_config={"embedding_config": {"model_name": "chat-model"}},
        )


def test_rejects_a_resolution_that_names_another_resource() -> None:
    adapter = _FakeAdapter(
        embedding_model=RetrievalResource(
            name="candidate-embedding", kind="Model", category="embedding"
        ),
        resolvers={
            ("chosen-retriever", "default"): RetrievalResource(
                name="different-retriever", kind="Retriever"
            )
        },
    )

    with pytest.raises(KnowledgeConfigError, match="chosen-retriever"):
        prepare_knowledge_config(
            adapter, retrieval_config={"retriever_name": "chosen-retriever"}
        )


@pytest.mark.parametrize(
    "override, message",
    [
        ({"retrieval_mode": "unsupported"}, "retrieval_mode"),
        ({"top_k": 0}, "top_k"),
        ({"top_k": 11}, "top_k"),
        ({"score_threshold": 1.5}, "score_threshold"),
        (
            {"hybrid_weights": {"vector_weight": 0.9, "keyword_weight": 0.9}},
            "hybrid_weights",
        ),
        (
            {"hybrid_weights": {"vector_weight": 1.5, "keyword_weight": -0.5}},
            "hybrid_weights",
        ),
    ],
)
def test_rejects_invalid_new_config_values(
    override: Mapping[str, Any], message: str
) -> None:
    config = {
        "retriever_name": "retriever-1",
        "embedding_config": {"model_name": "embedding-1"},
        **override,
    }

    with pytest.raises(KnowledgeConfigError, match=message):
        validate_knowledge_config(config)


def test_validate_knowledge_config_keeps_legacy_extra_fields_and_defaults() -> None:
    config = validate_knowledge_config(
        {"retriever_name": "retriever-1", "embedding_config": {"model_name": "m"}}
    )

    assert config["retriever_namespace"] == "default"
    assert config["embedding_config"] == {
        "model_name": "m",
        "model_namespace": "default",
    }
    assert config["retrieval_mode"] == "vector"
    assert config["top_k"] == DEFAULT_TOP_K
    assert config["score_threshold"] == DEFAULT_SCORE_THRESHOLD


def test_validate_retrieval_config_update_checks_only_provided_fields() -> None:
    assert validate_retrieval_config_update({"retrieval_mode": "keyword"}) == {
        "retrieval_mode": "keyword"
    }
    with pytest.raises(KnowledgeConfigError, match="retrieval_mode"):
        validate_retrieval_config_update({"retrieval_mode": "unsupported"})
    with pytest.raises(KnowledgeConfigError, match="top_k"):
        validate_retrieval_config_update({"top_k": 11})


def test_evaluate_profile_reports_missing_incomplete_and_valid() -> None:
    assert evaluate_profile(RetrievalProfileRecord())["status"] == "missing"
    assert evaluate_profile(
        RetrievalProfileRecord(configured={"retriever_name": "only-retriever"})
    ) == {"status": "invalid", "fallback_reason": "profile_incomplete"}
    assert evaluate_profile(_valid_profile()) == {
        "status": "valid",
        "fallback_reason": None,
    }


def test_minimal_caller_produces_a_saveable_config() -> None:
    """A second service can build a persistable config without Wegent ORM."""
    records = {
        "profile": {
            "retriever_name": "shared-retriever",
            "embedding_config": {"model_name": "shared-embedding"},
        }
    }
    authorized = {
        ("Retriever", "shared-retriever"): RetrievalResource(
            name="shared-retriever", kind="Retriever"
        ),
        ("Model", "shared-embedding"): RetrievalResource(
            name="shared-embedding", kind="Model", category="embedding"
        ),
    }

    class _ServiceAdapter:
        def retrieval_profile(self) -> RetrievalProfileRecord:
            profile = records["profile"]
            retriever = authorized.get(("Retriever", profile["retriever_name"]))
            embedding = authorized.get(
                ("Model", profile["embedding_config"]["model_name"])
            )
            return RetrievalProfileRecord(
                configured=profile,
                retriever=retriever,
                embedding_model=embedding,
            )

        def default_retriever(self, namespace: str) -> RetrievalResource | None:
            return None

        def default_embedding_model(self, namespace: str) -> RetrievalResource | None:
            return None

        def resolve_retriever(
            self, name: str, namespace: str
        ) -> RetrievalResource | None:
            return authorized.get(("Retriever", name))

        def resolve_embedding_model(
            self, name: str, namespace: str
        ) -> RetrievalResource | None:
            return authorized.get(("Model", name))

    config = prepare_knowledge_config(_ServiceAdapter(), retrieval_config={"top_k": 6})

    assert config is not None
    assert config["retriever_name"] == "shared-retriever"
    assert config["top_k"] == 6
    # The persisted JSON stays readable by the existing product.
    assert json.loads(json.dumps(config)) == config


_BOUNDARY_SCRIPT = textwrap.dedent(
    """
    import json
    import sys

    from shared.knowledge_module import (
        RetrievalProfileRecord,
        RetrievalResource,
        prepare_knowledge_config,
    )

    class Adapter:
        def retrieval_profile(self):
            return RetrievalProfileRecord()

        def default_retriever(self, namespace):
            return RetrievalResource(name="opensource-retriever", kind="Retriever")

        def default_embedding_model(self, namespace):
            return RetrievalResource(
                name="opensource-embedding", kind="Model", category="embedding"
            )

        def resolve_retriever(self, name, namespace):
            return RetrievalResource(name=name, kind="Retriever", namespace=namespace)

        def resolve_embedding_model(self, name, namespace):
            return RetrievalResource(
                name=name, kind="Model", category="embedding", namespace=namespace
            )

    config = prepare_knowledge_config(Adapter(), namespace="default")
    forbidden = ("shared.models", "shared.db", "backend", "celery")
    loaded = sorted(
        name
        for name in sys.modules
        if any(name == item or name.startswith(f"{item}.") for item in forbidden)
    )
    print(json.dumps({"config": config, "loaded": loaded}))
    """
)


def test_module_composes_config_without_wegent_product_orm() -> None:
    """The module is usable by a service that never loads the product ORM."""
    result = subprocess.run(
        [sys.executable, "-c", _BOUNDARY_SCRIPT],
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["loaded"] == []
    assert payload["config"]["retriever_name"] == "opensource-retriever"
    assert payload["config"]["embedding_config"] == {
        "model_name": "opensource-embedding",
        "model_namespace": "default",
    }
    assert payload["config"]["top_k"] == DEFAULT_TOP_K
    assert payload["config"]["score_threshold"] == DEFAULT_SCORE_THRESHOLD
