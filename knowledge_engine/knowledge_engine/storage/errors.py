# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Storage error contracts without execution SDK imports."""


class MilvusRowTooLargeError(ValueError):
    """One complete row cannot fit; its original content is never truncated."""

    code = "milvus_row_too_large"
    retryable = False

    def __init__(
        self,
        row: dict,
        size: int,
        budget: int,
        *,
        broker_rejected: bool = False,
    ) -> None:
        reason = "broker message-size limit" if broker_rejected else "message budget"
        node_id = row.get("id", row.get("parent_node_id", "unknown"))
        self.details = {
            "node_id": node_id,
            "serialized_bytes": size,
            "effective_budget_bytes": budget,
            "broker_rejected": broker_rejected,
        }
        super().__init__(
            f"Milvus row exceeds {reason}: node_id={node_id} "
            f"serialized_bytes={size} effective_budget_bytes={budget}; "
            "content was not truncated"
        )
