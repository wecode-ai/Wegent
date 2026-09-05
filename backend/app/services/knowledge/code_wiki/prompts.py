# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""What changes from one code wiki run to the next.

**The standing instructions are not here.** Coverage, grounding, discovery, planning,
use of git history and what to leave out live in the ``code-wiki-ghost`` system prompt
(``init_data/02-public-resources.yaml``). Page-write commands live in the
``wiki_submit`` skill. They are identical on every run and describe the agent or its
tool rather than the request, so repeating them in each message buys nothing and lets
the copies drift.

What remains is the part that genuinely differs: which repository, which version,
what changed since the published one, which pages exist, and which of the two modes
is running.

One rule stays with the mode rather than moving to the system prompt: whether a page
left unwritten disappears. It reads like a fixed instruction and is not — a full
rebuild starts from nothing, an incremental run starts from a copy — and stating it
alongside the mode is what keeps the two from being merged as duplicates later.
"""

from dataclasses import dataclass
from typing import Optional, Sequence

from app.services.knowledge.code_wiki.generation_strategy import (
    COORDINATOR_ADAPTIVE,
    COORDINATOR_SOLO,
)


@dataclass(frozen=True)
class WikiRunContext:
    """What the agent is being asked to document."""

    project_name: str
    generation_id: int
    head_commit: str = ""
    language: str = "English"
    # Incremental runs only.
    previous_commit: str = ""
    changed_paths: Sequence[str] = ()
    existing_pages: Sequence[str] = ()
    reviewer_agent_type: str = ""
    section_writer_agent_type: str = ""
    strategy_id: str = ""


def build_full_prompt(context: WikiRunContext) -> str:
    """Instructions for rebuilding a wiki from nothing."""
    if context.strategy_id == COORDINATOR_ADAPTIVE:
        return _build_adaptive_full_prompt(context)
    if context.strategy_id == COORDINATOR_SOLO:
        return _build_solo_full_prompt(context)
    return f"""\
Document the repository **{context.project_name}**, from scratch.

## This run

- Generation: `{context.generation_id}`
- Commit: `{context.head_commit or "current HEAD"}`
- Language: {context.language}
- This is a **full rebuild**: the wiki is being written from scratch.

Your version begins empty. A page you do not write is not in the wiki, so write every
page the wiki should contain, including the ones an earlier run already covered.
Declaring a removal does nothing here, because there is nothing to remove from.

## Required Writer/Reviewer quality loop

Read the wiki_submit skill's `REVIEW_CONTRACT.md` completely and follow its persisted
handoff protocol. Draft the complete Plan handoff and run `review-open` before using the
Claude Code `Task` or `Agent` tool to delegate to
`{context.reviewer_agent_type or "the configured reviewer agent"}`. Give that Reviewer
only this generation ID and the phase; it recovers the authoritative handoff with
`review-status`.

Run every Reviewer synchronously, never in the background. After it returns, run
`review-status` exactly once and follow its `nextAction`. If the phase remains `ready`,
fail the generation because the Reviewer returned without submitting a verdict; do not
sleep, poll, or delegate a replacement Reviewer. The persisted state is the recovery
source after context compaction.
If `review` or `review-status` exits 3, the generation has already ended: do not retry
wiki_submit, delegate another Reviewer, write pages, or call `complete`; stop this run
and return that terminal diagnostic immediately.
This run uses the backend-enforced `plan_only` review policy. The Writer opens the Plan
handoff but never submits the Reviewer verdict. After Plan passes, write every planned
page and call `complete`; do not open QA or Recheck. If the Coordinator discovers one
necessary page that the passed Plan did not cover, do not submit it directly: before
delegating or writing that page, use the Plan amendment protocol in REVIEW_CONTRACT.md.
Only the Coordinator opens that handoff; its passed effective plan becomes the new
authoritative page set. Confirm that `review-status`
returns `reviewPolicy=plan_only` and follow its `nextAction` as authoritative.
When the passed Writing Plan uses scoped mode, delegate each Work Package to
`{context.section_writer_agent_type or "the configured Section Writer agent"}` with
only this generation ID and Work Package ID. The Section Writer recovers its complete
scope from the persisted passed Plan. Trust submitted-page status rather than a
subagent's prose response, and handle only missing planned pages after each delegation.
Do not delegate in coordinator mode. Write coordinator-owned synthesis pages only
after the relevant Work Packages have submitted their domain pages.
Incremental-only shortcuts do not apply to this run.\
"""


def _build_adaptive_full_prompt(context: WikiRunContext) -> str:
    """A full rebuild whose Coordinator chooses page authorship by source scope."""
    return f"""\
Document the repository **{context.project_name}**, from scratch.

## This run

- Generation: `{context.generation_id}`
- Commit: `{context.head_commit or "current HEAD"}`
- Language: {context.language}
- Strategy: `coordinator_adaptive`
- This is a **full rebuild**: the wiki is being written from scratch.

Your version begins empty. A page nobody writes is not in the wiki, so account for
every planned page, including pages an earlier run already covered. Declaring a
removal does nothing here, because there is nothing to remove from.

## Adaptive Coordinator protocol

Do not open Plan, QA, Recheck, or other Reviewer phases, and do not delegate a
Reviewer. This strategy deliberately has no review loop.

Start with shallow discovery: identify the repository topology, important workflows,
state owners, integration boundaries, and representative tests without deeply reading
every planned scope. Build one ordered page plan. For every page record its path,
purpose, concrete `Must explain` questions, seed paths, related or prerequisite pages,
and exactly one author: `coordinator` or `writer:<work-package-id>`.

Choose authorship early. Write a page yourself when you already have enough evidence,
especially `index`, `quickstart`, compact local topics, and final cross-page assembly.
When a scope requires deeper reading across modules or its `Must explain` questions
exceed your evidence, delegate one complete research-and-writing Work Package to
`{context.section_writer_agent_type or "the configured Section Writer agent"}`. Pass
the generation ID plus that package's full page contracts, seed paths, prerequisites,
known source-grounded facts, and output language. The same Writer must complete the
package's remaining exploration and page submission in that one synchronous call; do
not run a separate exploration delegation first, do not delegate one agent per page,
and do not ask a Writer to delegate again. Keep related module and workflow pages in
one package when doing so lets that Writer reuse evidence.

Once a scope is delegated, do not deeply reread it. Reconcile the pages actually
submitted after each package rather than trusting its prose response. Handle only
missing or rejected pages, and never rewrite a successfully delegated page merely to
change its voice.

Before writing any coordinator-owned page, reread that page's purpose, `Must explain`
questions, seed paths, and prerequisite pages. Coordinator-owned and delegated pages
must meet the same standard: explain mechanisms, state changes, boundaries, failure or
recovery behaviour, practical change guidance, and resolvable source citations where
the source supports them. Use completed prerequisite pages for shared facts instead of
deriving those facts from source again.

Write or delegate every planned page, then call `complete` with every resulting path in
the intended reading order. Follow the existing wiki_submit completion and Mermaid
feedback rules. Incremental-only shortcuts do not apply to this run.\
"""


def _build_solo_full_prompt(context: WikiRunContext) -> str:
    """A full rebuild whose Coordinator is the only researcher and author."""
    return f"""\
Document the repository **{context.project_name}**, from scratch.

## This run

- Generation: `{context.generation_id}`
- Commit: `{context.head_commit or "current HEAD"}`
- Language: {context.language}
- Strategy: `coordinator_solo`
- This is a **full rebuild**: the wiki is being written from scratch.

Your version begins empty. You are the sole author, so write every planned page,
including pages an earlier run already covered. Declaring a removal does nothing here,
because there is nothing to remove from.

## Solo Coordinator protocol

Do not call the Claude Code `Task` or `Agent` tool and do not delegate research,
writing, review, or QA. Do not open Plan, QA, Recheck, or other Reviewer phases. This
strategy deliberately has no subagent or review loop.

First build one ordered page plan. For every page record its path, purpose, concrete
`Must explain` questions, seed paths, and prerequisite pages. Then inspect the source
needed to answer those questions and write every page yourself. Work through related
areas in a dependency-aware order so that later pages reuse facts established in
earlier pages instead of rediscovering them.

Before writing each page, reread that page's purpose, `Must explain` questions, seed
paths, and prerequisite pages. Every page must meet the same engineering contract:
explain mechanisms, state changes, boundaries, failure or recovery behaviour, practical
change guidance, and resolvable source citations where the source supports them. Do not
replace this with a directory inventory or a thin overview merely because the repository
is large.

Write every planned page, then call `complete` with every resulting path in the intended
reading order. Follow the existing wiki_submit completion and Mermaid feedback rules.
Incremental-only shortcuts do not apply to this run.\
"""


def build_incremental_prompt(context: WikiRunContext) -> str:
    """Instructions for revising a wiki after a set of changes."""
    changed = (
        "\n".join(f"- {path}" for path in context.changed_paths)
        or "- (no file list was available)"
    )
    existing = (
        "\n".join(f"- {path}" for path in context.existing_pages)
        or "- (the wiki is currently empty)"
    )
    return f"""\
Update the wiki for **{context.project_name}** to account for recent changes. It
already exists and is mostly correct; bring the parts the changes affect back in
line, rather than rewriting it.

## What changed

Between `{context.previous_commit or "the last documented commit"}` and
`{context.head_commit or "current HEAD"}`:
{changed}

## Pages that exist now

{existing}

## What to do

- Revise only the pages the changes actually affect. Leave the rest untouched — an
  unchanged page costs nothing to keep and is expensive to rewrite.
- When a changed page contains or should contain a diagram of the affected flow,
  lifecycle or data model, update that diagram with the surrounding prose. Leave an
  accurate diagram unchanged.
- **Read a page before you revise it.** Your version already holds every published
  page, and what you send replaces the whole page, so revising one without reading it
  first silently discards whatever it said. Use the read operation documented by the
  wiki_submit skill; a missing page means it is new.
- Refresh the `index` overview if the set of pages changed.
- If a change makes a page's subject disappear, remove that page explicitly.
- Add pages only where the changes introduced something the wiki has no place for.

## This run

- Generation: `{context.generation_id}`
- Language: {context.language}
- This is an **incremental update**: your version starts as a copy of the published
  wiki, so pages you do not touch are carried over unchanged.

To remove a page, declare its removal explicitly by path. Simply not writing a page
does **not** remove it in this mode.\
"""


def build_prompt(context: WikiRunContext, *, full: bool) -> str:
    """Instructions for a run, chosen by mode."""
    return build_full_prompt(context) if full else build_incremental_prompt(context)


def build_diagram_correction(warnings: Sequence[str]) -> Optional[str]:
    """Ask the agent to fix diagrams that will not render.

    Returned by the publish gate with the page paths intact, so the agent can rewrite
    only the affected pages and conclude the same generation again.
    """
    if not warnings:
        return None
    listed = "\n".join(f"- {warning}" for warning in warnings)
    return (
        "Some Mermaid diagrams in the pages you wrote will not render. Fix them and "
        "write those pages again, keeping their paths unchanged:\n"
        f"{listed}"
    )
