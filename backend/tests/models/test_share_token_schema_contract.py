"""Fresh schemas retain the unique key used by the existing downgrade."""

import json
from pathlib import Path

from sqlalchemy.dialects.mysql import dialect
from sqlalchemy.schema import CreateTable

from app.models.share_link import ShareLink


def test_fresh_share_token_schema_has_the_migration_unique_key():
    sql = str(CreateTable(ShareLink.__table__).compile(dialect=dialect()))
    assert "CONSTRAINT uniq_share_links_token_hash UNIQUE (token_hash)" in sql
    schema = json.loads(
        (Path(__file__).parents[3] / "backend-rs/migrations/schema.json").read_text()
    )
    table = next(row for row in schema["tables"] if row["table"] == "share_links")
    assert any(
        "CONSTRAINT uniq_share_links_token_hash UNIQUE (token_hash)" in statement
        for statement in table["statements"]
    )
