# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Claim request contracts keep Runtime capacity server-authoritative."""

import pytest
from pydantic import ValidationError

from app.schemas.project_chat import (
    LoopItemExecutionClaim,
    LoopItemExecutionDeviceClaim,
)


@pytest.mark.parametrize(
    ("schema", "payload"),
    [
        (
            LoopItemExecutionClaim,
            {
                "agentId": "agent-1",
                "executionDeviceId": "device-1",
                "deviceCapacity": 20,
            },
        ),
        (
            LoopItemExecutionDeviceClaim,
            {"executionDeviceId": "device-1", "deviceCapacity": 20},
        ),
    ],
)
def test_claim_rejects_caller_reported_device_capacity(schema, payload) -> None:
    with pytest.raises(ValidationError, match="deviceCapacity"):
        schema.model_validate(payload)
