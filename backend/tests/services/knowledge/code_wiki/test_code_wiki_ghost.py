# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""The standing instructions a code wiki agent carries, wherever they are written.

These used to be built into every run's message and were covered by the prompt tests.
Moving them into the ``code-wiki-ghost`` system prompt is only an improvement if the
coverage moves with them: each one forbids a specific way generated wikis go wrong,
and a constraint with no test is a constraint nobody will notice losing.

Asserted against the YAML rather than a rendered prompt because that file *is* the
prompt -- nothing in Python assembles it, so nothing else can be checked instead.
"""

from pathlib import Path

import pytest
import yaml

GHOST_NAME = "code-wiki-ghost"


@pytest.fixture(scope="module")
def system_prompt() -> str:
    resources = (
        Path(__file__).resolve().parents[4] / "init_data" / "02-public-resources.yaml"
    )
    for document in yaml.safe_load_all(resources.read_text()):
        if (
            document
            and document.get("kind") == "Ghost"
            and document.get("metadata", {}).get("name") == GHOST_NAME
        ):
            return document["spec"]["systemPrompt"]
    raise AssertionError(f"{GHOST_NAME} is not defined in 02-public-resources.yaml")


# --- what the wiki must cover ----------------------------------------------


@pytest.mark.parametrize(
    "subject",
    [
        "quickstart",
        "architecture overview",
        "source map",
        "key workflows",
        "domain concepts",
        "operations notes",
        "testing guidance",
        "integration points",
    ],
)
def test_the_expected_coverage_is_stated(system_prompt: str, subject: str):
    assert subject in system_prompt


# --- content discipline -----------------------------------------------------


def test_inventing_evidence_is_forbidden(system_prompt: str):
    """The failure that makes a generated wiki actively worse than none."""
    assert "Do not invent" in system_prompt


def test_the_agent_is_told_to_do_the_work_itself(system_prompt: str):
    """A real run fanned out into sub-agents and then sat blocking on their output
    until the whole task timed out, having submitted nothing.

    It is not an unreasonable instinct — a page each, read in parallel — but the
    pages cross-reference each other, so a sub-agent returns a summary of exactly
    the part that was needed in full.
    """
    assert "Plan the whole wiki first" in system_prompt
    # Not a ban. Delegating is allowed for a repository too large to survey, and only
    # after the plan exists -- a bounded question, not "write this page".
    assert "only when the repository is genuinely too large" in system_prompt


def test_how_much_to_read_is_bounded(system_prompt: str):
    """Reading everything is how a run exhausts its budget before writing."""
    assert "Do not read every file" in system_prompt


def test_history_is_asked_to_explain_why(system_prompt: str):
    """The one thing a reader cannot recover by reading the code."""
    assert "why" in system_prompt
    assert "history" in system_prompt.lower()


def test_the_relevance_test_is_carried(system_prompt: str):
    """The rule aimed at the generic, padded output the old wiki produced."""
    assert "would this change what someone does" in system_prompt


def test_pages_and_links_are_planned_before_writing(system_prompt: str):
    """Pages planned one at a time do not end up referencing each other."""
    assert "Before writing any page" in system_prompt
    assert "relationship" in system_prompt


# --- the write contract the projection depends on ---------------------------


def test_paths_are_stated_to_be_identities(system_prompt: str):
    """A shifting path republishes the page as a delete plus an insert, losing its
    place, its links and its search index."""
    assert "stable" in system_prompt
    assert "path" in system_prompt


def test_complete_content_is_required(system_prompt: str):
    """There is no patch format, so a partial page replaces a whole one."""
    assert "complete content" in system_prompt


def test_the_path_limits_match_what_the_validator_enforces(system_prompt: str):
    """A prompt promising more than the validator accepts fails at write time."""
    assert "4 folders" in system_prompt
    assert "differ only by case" in system_prompt


def test_a_page_is_asked_for_at_every_section(system_prompt: str):
    """A section with no page becomes a heading a reader cannot open. Asking here is
    what keeps the publish gate's warning rare."""
    assert "section that holds pages needs a page of its own" in system_prompt


def test_links_between_pages_are_given_a_form(system_prompt: str):
    """Left unsaid, an agent that has spent the run reading a repository writes
    repository-shaped links -- `./architecture/backend.md` -- and the reader resolves
    them only because it was taught to forgive that. Saying which form is wanted is
    what keeps that forgiveness from being the mechanism.
    """
    assert "[Backend](architecture/backend)" in system_prompt
    assert "not a URL" in system_prompt


def test_the_declared_order_is_explained_as_what_readers_see(system_prompt: str):
    """Otherwise the field looks like bookkeeping and gets filled in arbitrarily."""
    assert "--structure-order" in system_prompt
    assert "order readers see" in system_prompt


def test_the_agent_is_told_a_completed_run_can_still_be_refused(system_prompt: str):
    """It was told "marked as COMPLETED" while its version was discarded, and it is
    the only party that could still fix it — its checkout is there and the version
    accepts more writes. Now the call reports the outcome, and this says what to do
    with it.
    """
    assert "tells you whether the version was published" in system_prompt
    assert "`complete` again" in system_prompt


def test_the_agent_is_told_to_act_on_the_diagrams_it_is_handed_back(
    system_prompt: str,
):
    """Diagram findings arrive on a *successful* run, which is the part that needs
    saying: the natural reading of "published" is that there is nothing left to do,
    and the run is about to end with the only party who can fix them still on the
    machine."""
    assert "diagrams that will not render" in system_prompt
    assert "keeping their paths unchanged" in system_prompt


def test_the_run_is_required_to_be_finished(system_prompt: str):
    """Nothing is published until it is, and an unreported run blocks the wiki until
    the staleness sweep reclaims it hours later."""
    assert "complete --generation-id" in system_prompt
    assert "fail --generation-id" in system_prompt


def test_the_agent_is_told_it_has_no_scratch_space(system_prompt: str):
    """A real run left behind pages called "Curl Test" and "Test Page With Path" --
    the agent trying the submit tool out. It was not disobeying anything: nothing
    said that submitting publishes, so it had no reason to think a trial page was
    different from a real one.
    """
    assert "no scratch space" in system_prompt
    assert "remove it" in system_prompt


def test_the_deletion_rule_is_left_to_the_run(system_prompt: str):
    """It is the one instruction that is not the same every time -- a full rebuild
    starts empty, an incremental run starts from a copy. Stated here it would have to
    pick one, and either choice is wrong half the time.
    """
    assert "Only an incremental run removes pages by declaring them" in system_prompt
    assert "In a full rebuild the version starts empty" in system_prompt
