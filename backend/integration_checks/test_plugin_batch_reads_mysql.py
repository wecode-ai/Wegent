"""The same read-contract cases against an isolated real MySQL database."""

import os
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.plugin_marketplace import Plugin, PluginDeviceInstallation
from app.models.plugin_publication import (
    PluginPublicationCheck,
    PluginPublicationRequest,
    PluginPublicationRevision,
)
from app.models.user import User
from tests.services.plugin_batch_read_cases import (
    coalescing_case,
    installation_budget_case,
    installation_edge_case,
    publication_broken_reference_case,
    publication_budget_case,
    snapshot_case,
)


@pytest.fixture
def batch_db():
    url = make_url(os.environ["PLUGIN_AUTH_MYSQL_TEST_URL"])
    assert url.get_backend_name() == "mysql" and url.host in {"127.0.0.1", "localhost"}
    assert url.database == "plugin_auth_test", "Use the disposable CI database server"
    name = f"plugin_batch_{uuid.uuid4().hex}"
    admin = create_engine(url.set(database="mysql"), isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.execute(text(f"CREATE DATABASE {name}"))
    engine = create_engine(url.set(database=name))
    try:
        for model in [
            User,
            Kind,
            Plugin,
            PluginDeviceInstallation,
            PluginPublicationRequest,
            PluginPublicationRevision,
            PluginPublicationCheck,
        ]:
            model.__table__.create(engine)
        with Session(engine) as db:
            yield db
    finally:
        engine.dispose()
        with admin.connect() as connection:
            connection.execute(text(f"DROP DATABASE {name}"))
        admin.dispose()


@pytest.mark.parametrize("count", [0, 1, 20, 100])
@pytest.mark.parametrize("device", [None, "host-1", "missing", "   "])
def test_installation_budget_mysql(batch_db, count, device):
    installation_budget_case(batch_db, count, device)


@pytest.mark.parametrize("count", [0, 1, 20, 100])
@pytest.mark.parametrize("admin", [True, False])
def test_publication_budget_mysql(batch_db, count, admin):
    publication_budget_case(batch_db, count, admin)


@pytest.mark.parametrize(
    "case",
    [
        installation_edge_case,
        snapshot_case,
        publication_broken_reference_case,
        coalescing_case,
    ],
)
def test_projection_edges_mysql(batch_db, case):
    case(batch_db)
