# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.api.endpoints.knowledge import _dump_retrieval_config_for_api
from app.schemas.knowledge import RetrievalConfigCreate, RetrievalConfigUpdate


@pytest.mark.unit
def test_dump_create_retrieval_config_preserves_explicit_fields_only() -> None:
    config = RetrievalConfigCreate(retriever_name="retriever-1")

    payload = _dump_retrieval_config_for_api(config)

    assert payload == {"retriever_name": "retriever-1"}


@pytest.mark.unit
def test_dump_update_retrieval_config_preserves_explicit_fields_only() -> None:
    config = RetrievalConfigUpdate(top_k=8)

    payload = _dump_retrieval_config_for_api(config)

    assert payload == {"top_k": 8}


@pytest.mark.unit
def test_dump_retrieval_config_keeps_explicit_retrieval_mode() -> None:
    config = RetrievalConfigCreate(retrieval_mode="vector")

    payload = _dump_retrieval_config_for_api(config)

    assert payload == {"retrieval_mode": "vector"}
