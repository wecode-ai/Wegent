"""Guard the approved invariants and require executable coverage for each."""

import ast
import hashlib
import re
from pathlib import Path

ROOT = Path(__file__).parents[2]
CONTRACT = ROOT / "docs/zh/wegent/developer-guide/collaboration-permissions.md"
APPROVED_CONTRACT_SHA256 = (
    "f8e06ae0758330044b989047b1b686a01055812cb761e1bbfad99e9dc4ff9c61"
)


def test_approved_permission_contract_requires_explicit_review_to_change():
    rows = "\n".join(
        line for line in CONTRACT.read_text().splitlines() if line.startswith("| CP")
    )
    assert (
        hashlib.sha256(rows.encode()).hexdigest() == APPROVED_CONTRACT_SHA256
    ), "Changing a CP invariant requires explicit user approval and corresponding regression updates"


def test_every_permission_invariant_has_executable_regression_coverage():
    approved = set(re.findall(r"\| (CP\d{2}) \|", CONTRACT.read_text()))
    covered = set()
    for file in (ROOT / "backend/tests").rglob("test_*.py"):
        for node in ast.walk(ast.parse(file.read_text())):
            if isinstance(
                node, (ast.FunctionDef, ast.AsyncFunctionDef)
            ) and node.name.startswith("test_"):
                covered.update(
                    value.upper() for value in re.findall(r"cp\d{2}", node.name)
                )
    assert approved == {f"CP{i:02d}" for i in range(1, 21)}
    assert (
        approved <= covered
    ), f"Missing contract coverage: {sorted(approved - covered)}"
