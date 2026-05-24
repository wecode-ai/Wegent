# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from pydantic import ValidationError

from app.schemas.summary import KnowledgeBaseSummaryUpdateRequest


def test_knowledge_base_summary_update_request_trims_whitespace():
    payload = KnowledgeBaseSummaryUpdateRequest(long_summary="  Manual summary  ")

    assert payload.long_summary == "Manual summary"


def test_knowledge_base_summary_update_request_rejects_whitespace_only():
    with pytest.raises(ValidationError):
        KnowledgeBaseSummaryUpdateRequest(long_summary="   ")


def test_knowledge_base_summary_update_request_trims_before_length_validation():
    payload = KnowledgeBaseSummaryUpdateRequest(
        long_summary=f"{' ' * 20}valid{' ' * 20}"
    )

    assert payload.long_summary == "valid"
