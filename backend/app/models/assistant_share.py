"""Schema metadata for the Rust-owned assistant sharing API."""

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    Index,
    Integer,
    String,
    Table,
    false,
    text,
)
from sqlalchemy.dialects import mysql
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.sql.functions import now
from sqlalchemy.types import JSON

from app.db.base import Base

_SOURCE_ID = String(64).with_variant(
    mysql.VARCHAR(64, charset="ascii", collation="ascii_bin"), "mysql"
)
_RESOURCE_KIND = String(9).with_variant(mysql.ENUM("assistant", "team"), "mysql")
_REVISION = BigInteger().with_variant(mysql.BIGINT(unsigned=True), "mysql")
_DATETIME = DateTime().with_variant(mysql.DATETIME(fsp=6), "mysql")
_TABLE_OPTIONS = {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"}


class _ShareTimestamp(now):
    name = "now"
    inherit_cache = True


@compiles(_ShareTimestamp, "mysql")
def _compile_mysql_share_timestamp(element, compiler, **kwargs) -> str:
    return "CURRENT_TIMESTAMP(6)"


def _timestamp(name: str) -> Column:
    return Column(name, _DATETIME, nullable=False, server_default=_ShareTimestamp())


assistant_share_definitions = Table(
    "assistant_share_definitions",
    Base.metadata,
    Column("owner_user_id", Integer, primary_key=True),
    Column("resource_kind", _RESOURCE_KIND, primary_key=True),
    Column("source_id", _SOURCE_ID, primary_key=True),
    Column("definition", JSON, nullable=False),
    Column("revision", _REVISION, nullable=False, server_default=text("1")),
    _timestamp("created_at"),
    _timestamp("updated_at"),
    **_TABLE_OPTIONS,
)

assistant_share_grants = Table(
    "assistant_share_grants",
    Base.metadata,
    Column("owner_user_id", Integer, primary_key=True),
    Column("resource_kind", _RESOURCE_KIND, primary_key=True),
    Column("source_id", _SOURCE_ID, primary_key=True),
    Column("recipient_user_id", Integer, primary_key=True),
    Column("allow_copy", Boolean, nullable=False),
    Column("direct_enabled", Boolean, nullable=False, server_default=false()),
    Column("copied_revision", _REVISION),
    Column("revoked_at", _DATETIME),
    _timestamp("created_at"),
    _timestamp("updated_at"),
    Index(
        "assistant_share_recipient",
        "recipient_user_id",
        "revoked_at",
        "owner_user_id",
        "resource_kind",
        "source_id",
    ),
    **_TABLE_OPTIONS,
)

assistant_team_member_copies = Table(
    "assistant_team_member_copies",
    Base.metadata,
    Column("owner_user_id", Integer, primary_key=True),
    Column("source_id", _SOURCE_ID, primary_key=True),
    Column("recipient_user_id", Integer, primary_key=True),
    Column("copied_revision", _REVISION, nullable=False),
    Index(
        "assistant_member_copy_recipient",
        "recipient_user_id",
        "owner_user_id",
        "source_id",
    ),
    **_TABLE_OPTIONS,
)
