# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""A knowledge base generated and maintained by an agent from a source repository.

The modules divide along what each one decides:

- ``source`` / ``repo_state`` — which repository, and what it is at right now.
- ``run_mode`` — whether a run is needed at all, and how much of the wiki it rebuilds.
- ``version_store`` / ``page_path`` — the versions the agent writes into, and the page
  identity that lets an unchanged page keep its document id across runs.
- ``prompts`` — what the agent is told, which differs by mode.
- ``projection_plan`` / ``projection`` — what publishing a version would change, and
  the fixed ordering that applies it.
- ``publish_gate`` / ``publisher`` — whether a finished version may go live, and the
  single place that moves ``spec.publishedGenerationId``.
- ``generation`` / ``runner`` — the spine: starting a run and concluding it.
- ``side_effects`` — the adapters for the work that cannot join a transaction.

Nothing is re-exported here on purpose. ``app.services.knowledge`` resolves its own
exports lazily to avoid import cycles, and eagerly importing this package's modules
from here would pull that whole chain in at package-import time. Importing by module
path also keeps neighbours like ``publisher`` and ``publish_gate`` distinguishable at
the call site.
"""
