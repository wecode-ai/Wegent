# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Real, disposable MySQL replication and hybrid gateway for upload E2E."""

from __future__ import annotations

import json
import os
import secrets
import socket
import subprocess
import time
from collections import Counter
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import Any, Iterator

import httpx
from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL, CursorResult, Engine, RowMapping, make_url

from app.db.base import Base
from app.models import User  # Import the complete model registry before create_all.


def execute(engine: Engine, statement: str, **parameters: object) -> CursorResult[Any]:
    """Execute fixture administration in autocommit mode."""
    with engine.connect() as connection:
        return connection.execute(text(statement), parameters)


def isolated_url(variable: str) -> URL:
    """Reject developer/production databases before any administrative writes."""
    url = make_url(os.environ[variable])
    if (
        url.get_backend_name() != "mysql"
        or url.database != "wegent_test"
        or url.host not in {"127.0.0.1", "localhost", "mysql", "mysql-replica"}
    ):
        raise RuntimeError(
            f"{variable} must name the isolated MySQL wegent_test fixture"
        )
    return url


class ReplicaFixture:
    """Own one database on two real servers, with a controllable SQL applier."""

    def __init__(self, cleanup: ExitStack) -> None:
        self.primary_url = isolated_url("DATABASE_URL")
        self.replica_url = isolated_url("E2E_REPLICA_DATABASE_URL")
        self.database = "wegent_test_upload_" + secrets.token_hex(6)
        self.account = "upload_" + secrets.token_hex(6)
        self.password = secrets.token_urlsafe(24)
        self.primary = self.admin(self.primary_url, cleanup)
        self.replica = self.admin(self.replica_url, cleanup)
        identities = [
            execute(server, "SELECT @@server_uuid").scalar_one()
            for server in (self.primary, self.replica)
        ]
        assert identities[0] != identities[1], "two distinct MySQL servers are required"
        self.server_uuids = identities
        assert not execute(
            self.replica, "SHOW REPLICA STATUS"
        ).first(), (
            "the replica must be a disposable server without existing replication"
        )
        self.create_accounts(cleanup)
        self.configure_replication(cleanup)
        self.writer = self.application_url(self.primary_url)
        self.reader = self.application_url(self.replica_url)
        self.db = create_engine(
            self.primary_url.set(database=self.database), hide_parameters=True
        )
        cleanup.callback(self.db.dispose)
        Base.metadata.create_all(self.db)
        self.sync()
        self.enable_audit(cleanup)

    @staticmethod
    def admin(url: URL, cleanup: ExitStack) -> Engine:
        """Keep administrative connections separate from application pools."""
        engine = create_engine(
            url.set(database=None), isolation_level="AUTOCOMMIT", hide_parameters=True
        )
        cleanup.callback(engine.dispose)
        return engine

    def application_url(self, url: URL) -> str:
        """Use a unique account so server audit rows identify this gateway only."""
        return url.set(
            username=self.account, password=self.password, database=self.database
        ).render_as_string(hide_password=False)

    def create_accounts(self, cleanup: ExitStack) -> None:
        """Create only named fixture databases and accounts, on both servers."""
        for server in (self.primary, self.replica):
            execute(server, f"CREATE DATABASE `{self.database}` CHARACTER SET utf8mb4")
            cleanup.callback(execute, server, f"DROP DATABASE `{self.database}`")
            execute(
                server,
                "CREATE USER :account@'%' IDENTIFIED WITH mysql_native_password BY :pw",
                account=self.account,
                pw=self.password,
            )
            cleanup.callback(
                execute, server, "DROP USER :account@'%'", account=self.account
            )
            privileges = "ALL" if server is self.primary else "SELECT"
            execute(
                server,
                f"GRANT {privileges} ON `{self.database}`.* TO :account@'%'",
                account=self.account,
            )

    def configure_replication(self, cleanup: ExitStack) -> None:
        """Replicate subsequent fixture DDL and rows from a real binlog position."""
        assert execute(self.primary, "SELECT @@log_bin").scalar_one() == 1
        execute(
            self.primary,
            "GRANT REPLICATION SLAVE ON *.* TO :account@'%'",
            account=self.account,
        )
        source = execute(self.primary, "SHOW MASTER STATUS").mappings().one()
        primary_id = execute(self.primary, "SELECT @@server_id").scalar_one()
        execute(self.replica, f"SET GLOBAL server_id={int(primary_id) + 1}")
        execute(
            self.replica,
            f"CHANGE REPLICATION FILTER REPLICATE_DO_DB=({self.database})",
        )
        execute(
            self.replica,
            "CHANGE MASTER TO MASTER_HOST=:host, MASTER_PORT=:port, "
            "MASTER_USER=:account, MASTER_PASSWORD=:pw, "
            "MASTER_LOG_FILE=:file, MASTER_LOG_POS=:position, GET_MASTER_PUBLIC_KEY=1",
            host=os.environ["E2E_REPLICATION_SOURCE_HOST"],
            port=int(os.environ.get("E2E_REPLICATION_SOURCE_PORT", "3306")),
            account=self.account,
            pw=self.password,
            file=source["File"],
            position=source["Position"],
        )
        cleanup.callback(execute, self.replica, "RESET REPLICA ALL")
        cleanup.callback(execute, self.replica, "STOP REPLICA")
        execute(self.replica, "START REPLICA")

    def sync(self) -> None:
        """Wait on a binlog barrier, never on an assumed replication delay."""
        source = execute(self.primary, "SHOW MASTER STATUS").mappings().one()
        result = execute(
            self.replica,
            "SELECT MASTER_POS_WAIT(:file, :position, 30)",
            file=source["File"],
            position=source["Position"],
        ).scalar_one()
        status = execute(self.replica, "SHOW REPLICA STATUS").mappings().one()
        assert result is not None and result >= 0, (
            "replication barrier failed: "
            f"IO={status['Last_IO_Error']} SQL={status['Last_SQL_Error']}"
        )
        assert status["Replica_SQL_Running"] == "Yes"

    @contextmanager
    def paused(self) -> Iterator[None]:
        """Hold the real replica at a known snapshot throughout one request."""
        self.sync()
        execute(self.replica, "STOP REPLICA SQL_THREAD")
        status = execute(self.replica, "SHOW REPLICA STATUS").mappings().one()
        assert status["Replica_SQL_Running"] == "No"
        try:
            yield
        finally:
            execute(self.replica, "START REPLICA SQL_THREAD")
            self.sync()

    def enable_audit(self, cleanup: ExitStack) -> None:
        """Retain server-side execution evidence without changing query routing."""
        for server in (self.primary, self.replica):
            old = execute(
                server, "SELECT @@global.general_log, @@global.log_output"
            ).one()
            cleanup.callback(
                execute, server, "SET GLOBAL log_output=:value", value=old[1]
            )
            cleanup.callback(
                execute, server, "SET GLOBAL general_log=:value", value=old[0]
            )
            execute(server, "SET GLOBAL log_output='TABLE'")
            execute(server, "SET GLOBAL general_log=ON")

    def audit_events(self, server: Engine) -> list[Any]:
        """Read only this gateway's server-side events, preserving execution order."""
        return execute(
            server,
            "SELECT event_time, thread_id, command_type, "
            "CONVERT(argument USING utf8mb4) AS argument FROM mysql.general_log "
            "WHERE user_host LIKE :account ORDER BY event_time",
            account=self.account + "[%",
        ).all()

    def mark(self) -> list[Counter[tuple[Any, ...]]]:
        """Snapshot events instead of comparing clocks in different session zones."""
        return [
            Counter(tuple(event) for event in self.audit_events(server))
            for server in (self.primary, self.replica)
        ]

    def assert_primary_refresh(
        self, context_id: int, since: list[Counter[tuple[Any, ...]]], count: int = 1
    ) -> None:
        """Prove committed refresh SELECTs execute on the primary, not the replica."""
        events = []
        for server, snapshot in zip((self.primary, self.replica), since):
            remaining = snapshot.copy()
            observed = []
            for event in self.audit_events(server):
                key = tuple(event)
                if remaining[key]:
                    remaining[key] -= 1
                else:
                    observed.append(event)
            events.append(observed)

        def refresh(event: Any) -> bool:
            sql = " ".join(event.argument.split())
            return (
                event.command_type == "Execute"
                and sql.startswith(
                    "SELECT subtask_contexts.id, subtask_contexts.subtask_id,"
                )
                and " AS " not in sql
                and sql.endswith(f"WHERE subtask_contexts.id = {context_id}")
            )

        primary = [event for event in events[0] if refresh(event)]
        assert (
            len(primary) == count
        ), f"expected {count} primary refreshes, got {len(primary)}"
        assert not any(refresh(event) for event in events[1]), "refresh reached replica"
        assert any(
            event.argument.upper() == "COMMIT"
            and event.event_time < primary[0].event_time
            for event in events[0]
        ), "refresh must follow the upload commit"
        with (Path(os.environ["E2E_REPORT_DIR"]) / "audit.jsonl").open("a") as report:
            report.write(
                json.dumps(
                    {
                        "context_id": context_id,
                        "primary_refreshes_after_commit": len(primary),
                        "replica_refreshes": 0,
                    }
                )
                + "\n"
            )

    def attachment(
        self, context_id: int, *, replica: bool = False
    ) -> RowMapping | None:
        """Inspect stored bytes and metadata on the chosen real server."""
        return (
            execute(
                self.replica if replica else self.primary,
                f"SELECT id, name, status, binary_data, type_data FROM "
                f"`{self.database}`.subtask_contexts WHERE id=:id",
                id=context_id,
            )
            .mappings()
            .first()
        )


def free_port() -> int:
    """Reserve an unused loopback port without stopping existing services."""
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


@contextmanager
def gateway(fixture: ReplicaFixture, report: Path) -> Iterator[httpx.Client]:
    """Run the actual Python upstream and Rust gateway with separate read pools."""
    repository = Path(__file__).resolve().parents[3]
    binary = Path(os.environ["WEGENT_RS_BINARY_PATH"]).resolve()
    assert binary.is_file(), "build the current Rust gateway before E2E"
    port, upstream = free_port(), free_port()
    assert port != upstream
    empty_env = report / "gateway.env"
    empty_env.write_text("")
    # This registered internal handler is not cut over in the default route
    # table yet. Exercise its existing Rust upload caller without migrating it.
    routes = report / "routes.toml"
    routes.write_text(
        "include = "
        + json.dumps([str(repository / "backend-rs/config/routes.toml")])
        + '\n[[routes]]\nmethods = ["POST"]\n'
        + 'path = "/api/internal/conversion/callback/completed"\n'
    )
    environment = {
        **os.environ,
        "DATABASE_URL": fixture.writer,
        "DATABASE_SLAVE_URL": fixture.reader,
        "WEGENT_RS_BINARY_PATH": str(binary),
        "WEGENT_RS_LISTEN_HOST": "127.0.0.1",
        "WEGENT_RS_LISTEN_PORT": str(port),
        "WEGENT_PYTHON_UPSTREAM_PORT": str(upstream),
        "WEGENT_HYBRID_STATE_FILE": str(report / "hybrid.state"),
        "WEGENT_BACKEND_RS_ENV_FILE": str(empty_env),
        "WEGENT_RS_ROUTES_FILE": str(routes),
        "BREEZE_LOG_DIR": str(report / "rust"),
        "LOG_DIR": str(report / "python"),
        "DB_AUTO_MIGRATE": "false",
        "INIT_DATA_ENABLED": "false",
        "EMBEDDED_CELERY_ENABLED": "false",
        "SCHEDULED_TASKS_ENABLED": "false",
        "ATTACHMENT_STORAGE_BACKEND": "mysql",
        "RUST_LOG": "info",
    }
    with (report / "gateway.log").open("w") as log:
        process = subprocess.Popen(
            ["bash", "backend-rs/scripts/start-hybrid-backend.sh"],
            cwd=repository,
            env=environment,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            with httpx.Client(
                base_url=f"http://127.0.0.1:{port}", timeout=30
            ) as client:
                deadline = time.monotonic() + 180
                while True:
                    assert process.poll() is None, "gateway exited; inspect gateway.log"
                    try:
                        if client.get("/api/health").is_success:
                            break
                    except httpx.TransportError:
                        pass
                    assert (
                        time.monotonic() < deadline
                    ), "gateway readiness deadline exceeded"
                    time.sleep(0.2)
                yield client
        finally:
            process.terminate()
            process.wait(timeout=30)
