# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Factories for the retriever and model Kinds a knowledge config resolves."""

from __future__ import annotations

from app.models.kind import Kind


def retriever_kind(user_id: int, name: str, namespace: str = "default") -> Kind:
    """Build an active Retriever Kind valid against the Retriever CRD schema."""
    return Kind(
        user_id=user_id,
        kind="Retriever",
        name=name,
        namespace=namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Retriever",
            "metadata": {"name": name, "namespace": namespace},
            "spec": {
                "storageConfig": {
                    "type": "elasticsearch",
                    "url": "http://search-v1",
                    "indexStrategy": {"mode": "per_user"},
                }
            },
        },
        is_active=True,
    )


def model_kind(
    user_id: int, name: str, model_type: str, namespace: str = "default"
) -> Kind:
    """Build an active Model Kind of the given catalog category."""
    return Kind(
        user_id=user_id,
        kind="Model",
        name=name,
        namespace=namespace,
        json={"spec": {"modelType": model_type}},
        is_active=True,
    )


def embedding_model_kind(user_id: int, name: str, namespace: str = "default") -> Kind:
    """Build an active embedding Model Kind."""
    return model_kind(user_id, name, "embedding", namespace)
