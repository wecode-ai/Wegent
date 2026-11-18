"""Behavior and actual SELECT budgets on plugin read projections."""

import pytest

from tests.services.plugin_batch_read_cases import (
    coalescing_case,
    installation_budget_case,
    installation_edge_case,
    publication_broken_reference_case,
    publication_budget_case,
    snapshot_case,
)


@pytest.mark.parametrize("count", [0, 1, 20, 100])
@pytest.mark.parametrize("device", [None, "", "host-1", "missing", "   "])
def test_installation_budget(test_db, count, device):
    installation_budget_case(test_db, count, device)


@pytest.mark.parametrize("count", [0, 1, 20, 100])
@pytest.mark.parametrize("admin", [True, False])
def test_publication_budget(test_db, count, admin):
    publication_budget_case(test_db, count, admin)


@pytest.mark.parametrize(
    "case",
    [
        installation_edge_case,
        snapshot_case,
        publication_broken_reference_case,
        coalescing_case,
    ],
)
def test_projection_edges(test_db, case):
    case(test_db)
