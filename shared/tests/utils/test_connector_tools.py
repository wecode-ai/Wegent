import pytest

from shared.utils.connector_tools import qualify_connector_tool, split_connector_tool


@pytest.mark.parametrize(
    ("slug", "tool", "expected"),
    [
        ("reports", "archive__lookup", "reports__archive__lookup"),
        ("reports__archive", "lookup", "reports_u_uarchive__lookup"),
        ("reports_u", "__lookup", "reports_uu____lookup"),
        ("reports-archive", "lookup", "reports-archive__lookup"),
    ],
)
def test_names_identify_exactly_one_app_and_tool(slug, tool, expected):
    assert qualify_connector_tool(slug, tool) == expected
    assert split_connector_tool(expected) == (slug, tool)


@pytest.mark.parametrize(
    "name", ["", "reports", "__lookup", "reports__", "reports_x__lookup"]
)
def test_malformed_names_cannot_alias_another_identity(name):
    with pytest.raises(ValueError, match="Invalid connector tool name"):
        split_connector_tool(name)
