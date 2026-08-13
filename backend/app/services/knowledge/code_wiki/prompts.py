# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""What changes from one code wiki run to the next.

**The standing instructions are not here.** Coverage, grounding, discovery, planning,
use of git history, what to leave out and how to hand pages back live in the
``code-wiki-ghost`` system prompt (``init_data/02-public-resources.yaml``). They are
identical on every run and describe the agent rather than the request, so repeating
them in each message bought nothing — and left the same rules written twice, since
that prompt already covered submitting and removal in its own words.

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


def build_full_prompt(context: WikiRunContext) -> str:
    """Instructions for rebuilding a wiki from nothing."""
    return f"""\
Document the repository **{context.project_name}**, from scratch.

## This run

- Generation: `{context.generation_id}`
- Commit: `{context.head_commit or "current HEAD"}`
- Language: {context.language}
- This is a **full rebuild**: the wiki is being written from scratch.

Your version begins empty. A page you do not write is not in the wiki, so write every
page the wiki should contain, including the ones an earlier run already covered.
Declaring a removal does nothing here, because there is nothing to remove from.\
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
- **Read a page before you revise it.** Your version already holds every published
  page, and what you send replaces the whole page, so revising one without reading it
  first silently discards whatever it said:
  `node wiki_submit.js read --generation-id <id> --path <path>`
  It exits with no output when the page does not exist yet, which means it is new.
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

    Sent back as a follow-up rather than treated as a failure: a broken diagram is a
    local display fault, and a version is not worth discarding over one.
    """
    if not warnings:
        return None
    listed = "\n".join(f"- {warning}" for warning in warnings)
    return (
        "Some Mermaid diagrams in the pages you wrote will not render. Fix them and "
        "write those pages again, keeping their paths unchanged:\n"
        f"{listed}"
    )
