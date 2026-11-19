"""The native bootstrap schema and revision graph retain the Python contract."""

import ast
import json
import re
from pathlib import Path

from sqlalchemy.dialects.mysql import dialect
from sqlalchemy.schema import CreateIndex, CreateTable

from app.db.base import Base

ROOT = Path(__file__).resolve().parents[3]
ASSETS = ROOT / "backend-rs" / "migrations"


def normalize_table_options(statement: str) -> tuple[str, tuple[str, ...]]:
    """SQLAlchemy emits MySQL table options in process-dependent set order."""
    if not statement.startswith("CREATE TABLE"):
        return statement, ()
    body, options = statement.rsplit("\n)", 1)
    pattern = re.compile(r"\w+(?:=| )'(?:''|[^'])*'|\w+(?:=| )\w+")
    tokens = tuple(sorted(match.group() for match in pattern.finditer(options)))
    assert not pattern.sub("", options).strip(), options
    return body, tokens


def test_latest_rust_schema_matches_sqlalchemy_mysql_metadata() -> None:
    schema = json.loads((ASSETS / "schema.json").read_text())
    expected = {}
    for table in Base.metadata.sorted_tables:
        statements = [str(CreateTable(table).compile(dialect=dialect())).strip()]
        statements.extend(
            str(CreateIndex(index).compile(dialect=dialect())).strip()
            for index in sorted(table.indexes, key=lambda item: item.name)
        )
        expected[table.name] = [normalize_table_options(sql) for sql in statements]
    actual = {
        item["table"]: [normalize_table_options(sql) for sql in item["statements"]]
        for item in schema["tables"]
    }
    assert actual == expected


def test_native_revision_graph_preserves_all_alembic_dependencies() -> None:
    expected = {}
    for path in (ASSETS / "reference" / "versions").glob("*.py"):
        values = {}
        for node in ast.parse(path.read_text()).body:
            if isinstance(node, ast.Assign) and len(node.targets) == 1:
                target = node.targets[0]
            elif isinstance(node, ast.AnnAssign):
                target = node.target
            else:
                continue
            if isinstance(target, ast.Name) and target.id in {
                "revision",
                "down_revision",
                "depends_on",
            }:
                values[target.id] = ast.literal_eval(node.value)
        parents = values["down_revision"]
        assert values.get("depends_on") is None
        expected[values["revision"]] = (
            []
            if parents is None
            else [parents] if isinstance(parents, str) else list(parents)
        )
    actual = {}
    for path in (ASSETS / "revisions").glob("*.json"):
        item = json.loads(path.read_text())
        assert path.stem == item["revision"]
        actual[item["revision"]] = item["parents"]
    assert actual == expected


def test_newest_reference_revision_is_registered_in_native_assets() -> None:
    reference_revisions = {
        path.name.split("_", 1)[0]: path.stem
        for path in (ASSETS / "reference" / "versions").glob("*.py")
    }
    native_revisions = {path.stem for path in (ASSETS / "revisions").glob("*.json")}
    newest_reference = max(reference_revisions)
    newest_revision = reference_revisions[newest_reference].split("_")[1]
    assert newest_revision in native_revisions
