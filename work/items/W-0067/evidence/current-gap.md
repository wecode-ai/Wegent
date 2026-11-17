---
sidebar_position: 1
---

# W-0067 implementation evidence

The Issue attachments describe the original gap. It was reproduced again on
PR #4682 at `b9f416e9bb715c2d592d086a9976c693495f4a96` before this change:

```text
test_human_assignment_without_runtime_receipt_remains_queued: succeeded
test_human_assignment_without_delivery_has_no_completion_timestamp: timestamp set
test_human_assignment_preserves_the_persisted_workflow_stage: None != ux_spec
```

The regression invokes the real automation dispatch and human assignment methods,
with only the database/Issue assignment boundary mocked. The integration tests
use an isolated database, a real assignment and execution ledger, and fake external
object storage. They cover stage binding, accepted versus running, missing
deliverables, duplicate Delivery creation, reused Runtime bindings, failure and
cancellation. Reuse coverage rejects both an old draft and a delayed old create,
including missing immutable source identities. Terminal failures/cancellations
take precedence over stale waiting-user observations. Recipient-only projection
tests keep private Runtime addresses out of shared activity and other users' run
views. These tests do not claim live desktop or production verification.

Reproduce from `backend`:

```sh
uv run pytest tests/services/test_project_automation_human_receipts.py tests/services/test_project_automation_human_delivery.py tests/services/test_project_automation_human_privacy.py -q
```

This implementation builds on W-0061 PR #4682. W-0061 PR #4693 supplies separate
participation/publication projections; W-0065 PR #4678 is a design reference rather
than live hosting integration. They remain external merge dependencies. This PR
does not claim those dependencies are merged or the feature is released.

Enable `HUMAN_ASSIGNMENT_RECEIPTS_ENABLED` and
`HUMAN_AUTOMATION_RECEIPTS_ENABLED` together to exercise the new path. Both default
to false. The second setting implements `collab.humanAutomationReceipts.v1`.
With it disabled, new runs retain the previous assignment-success projection;
existing server-created execution/Delivery snapshots remain intact.

Stage succession and release authorization remain outside W-0067. Runtime
completion waits for one finalized Delivery containing every snapshotted required
deliverable. A notification, device acceptance, or public summary cannot complete
the automation run. Owner and device authority still come from the W-0061 ledger.
