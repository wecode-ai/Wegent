# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for what a code wiki run is told, beyond its standing instructions.

Prompt quality cannot be asserted, but its contract can. The two modes differ in
whether an unwritten page means "unchanged" or "gone", and confusing them deletes or
resurrects pages -- so that stays pinned here, next to the mode that decides it.

The standing instructions moved to the ``code-wiki-ghost`` system prompt and are
covered by ``test_code_wiki_ghost.py``. They were not dropped: a constraint with no
test is a constraint nobody will notice losing.
"""

from app.services.knowledge.code_wiki.prompts import (
    WikiRunContext,
    build_diagram_correction,
    build_full_prompt,
    build_incremental_prompt,
    build_prompt,
)


def _context(**overrides) -> WikiRunContext:
    defaults = dict(project_name="wecode-ai/Wegent", generation_id=42)
    defaults.update(overrides)
    return WikiRunContext(**defaults)


# --- the write contract ----------------------------------------------------


def test_a_full_rebuild_says_an_unwritten_page_is_absent():
    prompt = build_full_prompt(_context())

    assert "begins empty" in prompt
    # Not the whole sentence: it wraps, and a test that breaks on reflowing a
    # paragraph reports a formatting change as a lost instruction.
    assert "page the wiki should contain" in prompt


def test_an_incremental_run_says_an_unwritten_page_is_kept():
    """The opposite of a full run, and confusing them deletes or resurrects pages."""
    prompt = build_incremental_prompt(_context())

    assert "copy of the published" in prompt
    assert "does **not** remove it" in prompt


def test_only_the_incremental_mode_offers_explicit_removal():
    """A full run removes a page by not writing it; declaring it would be redundant."""
    assert "declare its removal" in build_incremental_prompt(_context())
    assert "declare its removal" not in build_full_prompt(_context())


def test_the_deletion_rule_stays_with_the_mode():
    """It reads like a fixed instruction and is not. Stated only in the system prompt
    it would have to pick one of the two answers, and either choice is wrong half the
    time: a full rebuild that declares removals wastes them, an incremental run that
    does not declare them silently keeps pages whose subject is gone."""
    full = build_full_prompt(_context())
    incremental = build_incremental_prompt(_context())

    assert "begins empty" in full and "begins empty" not in incremental
    assert "copy of the published" in incremental


# --- run context -----------------------------------------------------------


def test_the_incremental_prompt_lists_what_changed():
    prompt = build_incremental_prompt(
        _context(
            previous_commit="aaaa",
            head_commit="bbbb",
            changed_paths=["backend/app/main.py", "frontend/src/app.tsx"],
        )
    )

    assert "aaaa" in prompt and "bbbb" in prompt
    assert "backend/app/main.py" in prompt


def test_the_incremental_prompt_lists_the_pages_that_exist():
    """Without it the agent cannot tell an update from a new page."""
    prompt = build_incremental_prompt(_context(existing_pages=["index", "arch/api"]))

    assert "arch/api" in prompt


def test_an_incremental_update_keeps_related_diagrams_current():
    prompt = build_incremental_prompt(_context())

    assert "diagram" in prompt
    assert "affected flow" in prompt
    assert "accurate diagram unchanged" in prompt


def test_the_submit_skill_remains_the_only_command_authority():
    prompt = build_incremental_prompt(_context())

    assert "wiki_submit skill" in prompt
    assert "node wiki_submit.js" not in prompt
    assert "--generation-id" not in prompt


def test_an_empty_change_list_is_stated_rather_than_left_blank():
    prompt = build_incremental_prompt(_context())

    assert "no file list was available" in prompt


def test_an_empty_wiki_is_stated_rather_than_left_blank():
    prompt = build_incremental_prompt(_context())

    assert "currently empty" in prompt


def test_the_generation_id_travels_with_the_run():
    assert "42" in build_full_prompt(_context())


def test_the_mode_selects_the_prompt():
    assert build_prompt(_context(), full=True) == build_full_prompt(_context())
    assert build_prompt(_context(), full=False) == build_incremental_prompt(_context())


# --- diagram feedback ------------------------------------------------------


def test_diagram_problems_come_back_as_a_correction():
    correction = build_diagram_correction(["index: line 4 is not a diagram type"])

    assert correction is not None
    assert "index: line 4" in correction
    assert "paths unchanged" in correction


def test_no_diagram_problems_means_no_follow_up():
    assert build_diagram_correction([]) is None
