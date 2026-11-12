"""Verify staging against the desktop checkpoint's real MySQL and MinIO."""

import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier, Event, get_ident
from time import monotonic


def verify_upload_race(arguments, receipt, isolation: str) -> None:
    """Observe the actual Thread mutex before committing a synthetic new asset."""
    import hashlib

    from fastapi import HTTPException
    from sqlalchemy import event, text
    from sqlalchemy.orm import Session

    from app.models.delivery import LoopItem, LoopItemAttachment
    from app.services.thread_migration import apply_thread_migration

    base_factory = arguments["session_factory"]
    with base_factory() as db:
        engine = db.get_bind().execution_options(isolation_level=isolation)

    @contextmanager
    def factory():
        with Session(bind=engine) as current:
            yield current

    arguments = {**arguments, "session_factory": factory}
    worker = {"identity": None}
    statements = []

    def trace(_connection, _cursor, statement, _parameters, _context, _many):
        if get_ident() == worker["identity"]:
            statements.append(" ".join(statement.split()))

    def migrate():
        worker["identity"] = get_ident()
        return apply_thread_migration(
            **arguments, assets=receipt, retain_source_project=True
        )

    event.listen(engine, "before_cursor_execute", trace)
    thread_id = arguments["inventory"].entries[0].thread_id
    storage = arguments["storage"]
    suffix = isolation.lower().replace(" ", "-")
    key = receipt.objects[0].source_key.rsplit("/", 1)[0] + f"/concurrent-{suffix}"
    content = b"Committed while migration waits on the source Thread"
    storage.put_bytes(key, content, "application/octet-stream")
    with factory() as upload:
        assert upload.execute(
            text("SELECT @@transaction_isolation")
        ).scalar_one() == isolation.replace(" ", "-")
        upload.query(LoopItem).filter_by(id=thread_id).with_for_update().one()
        holder = upload.execute(text("SELECT CONNECTION_ID()")).scalar_one()
        upload.add(
            LoopItemAttachment(
                id=f"migration-concurrent-{suffix}",
                loop_item_id=thread_id,
                object_key=key,
                size_bytes=len(content),
                sha256=hashlib.sha256(content).hexdigest(),
            )
        )
        upload.flush()
        pool = ThreadPoolExecutor(max_workers=1)
        pending = pool.submit(migrate)
        observed = False
        try:
            deadline = monotonic() + 15
            while monotonic() < deadline:
                with factory() as probe:
                    waits = (
                        probe.execute(
                            text(
                                """
                        SELECT requested.LOCK_DATA
                        FROM performance_schema.data_lock_waits waits
                        JOIN performance_schema.data_locks requested
                          ON requested.ENGINE_LOCK_ID=waits.REQUESTING_ENGINE_LOCK_ID
                        JOIN performance_schema.data_locks held
                          ON held.ENGINE_LOCK_ID=waits.BLOCKING_ENGINE_LOCK_ID
                        JOIN performance_schema.threads owner
                          ON owner.THREAD_ID=held.THREAD_ID
                        WHERE owner.PROCESSLIST_ID=:holder
                          AND requested.OBJECT_NAME='loop_items'
                          AND requested.INDEX_NAME='PRIMARY'
                    """
                            ),
                            {"holder": holder},
                        )
                        .scalars()
                        .all()
                    )
                if any(thread_id in str(value) for value in waits):
                    observed = True
                    print(
                        f"Migration {isolation} observed source Thread wait: {waits}",
                        flush=True,
                    )
                    break
                if pending.done():
                    pending.result()
                    raise AssertionError("Migration did not wait for the Thread")
                Event().wait(0.03)
        finally:
            upload.commit()
        try:
            assert observed, "Did not observe exact source Thread row wait"
            try:
                pending.result(timeout=20)
            except HTTPException as exc:
                assert exc.status_code == 409 and "inventory changed" in str(exc.detail)
            else:
                print(
                    json.dumps({"migration_isolation": isolation, "sql": statements}),
                    flush=True,
                )
                raise AssertionError("Migration missed the newly committed attachment")
        finally:
            pool.shutdown(wait=True)
            event.remove(engine, "before_cursor_execute", trace)


def verify_operator_cli(report, actor_id: int):
    backend = Path(__file__).resolve().parents[4] / "backend"
    with TemporaryDirectory(prefix="thread-migration-operator-") as directory:
        inventory_path = Path(directory) / "inventory.json"
        receipt_path = Path(directory) / "receipts.json"
        inventory_path.write_text(json.dumps(report.to_dict()))
        command = [
            "uv",
            "run",
            "python",
            str(backend / "scripts/migrate_threads.py"),
            "--inventory-file",
            str(inventory_path),
            "--receipts-file",
            str(receipt_path),
            "--actor-user",
            str(actor_id),
            "--retain-source-project",
        ]
        verify_operator_disconnect(report, actor_id, command, receipt_path)
        first = subprocess.run(
            command, cwd=backend, capture_output=True, text=True, timeout=30
        )
        assert first.returncode == 0, first.stdout + first.stderr
        result = json.loads(first.stdout)
        assert not result["replayed"] and receipt_path.is_file()
        stored = receipt_path.read_bytes()
        second = subprocess.run(
            command, cwd=backend, capture_output=True, text=True, timeout=30
        )
        assert second.returncode == 0, second.stdout + second.stderr
        replay = json.loads(second.stdout)
        assert replay["replayed"] and replay["checkpoint_id"] == result["checkpoint_id"]
        assert receipt_path.read_bytes() == stored
        return result


def history_insert_observation_deadline(process, receipt_path) -> float:
    """Wait for real asset preparation before timing the SQL fault injection."""
    preparation_deadline = monotonic() + 30
    while True:
        if process.poll() is not None:
            stdout, stderr = process.communicate()
            raise AssertionError(
                f"Writer exited before receipt preparation: {stdout}{stderr}"
            )
        if monotonic() >= preparation_deadline:
            raise AssertionError("Writer did not persist receipts within 30 seconds")
        if receipt_path.is_file():
            return monotonic() + 20
        Event().wait(0.03)


def verify_operator_disconnect(report, actor_id, command, receipt_path) -> None:
    """Disconnect the actual writer after Thread/link/participant changes flush."""
    from sqlalchemy import text

    from app.db.session import get_db_session
    from app.models.delivery import (
        CollaborationChatGroup,
        LoopItem,
        LoopItemComment,
        ThreadMigrationCheckpoint,
        ThreadParticipant,
        ThreadProjectLink,
    )
    from app.models.project_chat_message import ProjectChatMessage

    thread_id = report.entries[0].thread_id
    with get_db_session() as held:
        comment = (
            held.query(LoopItemComment)
            .filter(
                LoopItemComment.loop_item_id == thread_id,
                LoopItemComment.cloud_project_id == report.source_project_id,
                LoopItemComment.description != "",
            )
            .first()
        )
        assert comment is not None
        comment_id = str(comment.id)
        # A real, uncommitted uniqueness conflict blocks history insertion late
        # in the transaction. It never becomes an actual group message.
        held.add(
            ProjectChatMessage(
                message_id=comment_id,
                project_id=report.target_group_id,
                task_id="",
                sender_type="user",
                sender_id=str(actor_id),
                message_type="text",
                content="Uncommitted fixture collision",
            )
        )
        held.flush()
        holder = held.execute(text("SELECT CONNECTION_ID()")).scalar_one()
        holder_transaction = held.execute(
            text(
                """
            SELECT DISTINCT locks.ENGINE_TRANSACTION_ID
            FROM performance_schema.data_locks locks
            JOIN performance_schema.threads owner ON owner.THREAD_ID=locks.THREAD_ID
            WHERE owner.PROCESSLIST_ID=:holder
              AND locks.OBJECT_NAME='project_chat_messages'
              AND locks.LOCK_TYPE='TABLE'
        """
            ),
            {"holder": holder},
        ).scalar_one()
        process = subprocess.Popen(
            command,
            cwd=Path(__file__).resolve().parents[4] / "backend",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        waiter = None
        try:
            deadline = history_insert_observation_deadline(process, receipt_path)
            while monotonic() < deadline:
                with get_db_session() as probe:
                    # Keep the holder's original transaction identity. A waiter
                    # can materialize its implicit record lock, and INNODB_TRX
                    # snapshots need not yet include a newly waiting transaction.
                    rows = probe.execute(
                        text(
                            """
                        SELECT requester.PROCESSLIST_ID, requester.PROCESSLIST_INFO,
                               requested.INDEX_NAME, requested.LOCK_DATA
                        FROM performance_schema.data_lock_waits waits
                        JOIN performance_schema.data_locks requested
                          ON requested.ENGINE_LOCK_ID=waits.REQUESTING_ENGINE_LOCK_ID
                        JOIN performance_schema.threads requester
                          ON requester.THREAD_ID=waits.REQUESTING_THREAD_ID
                        WHERE waits.BLOCKING_ENGINE_TRANSACTION_ID=:holder_transaction
                          AND requested.OBJECT_NAME='project_chat_messages'
                    """
                        ),
                        {"holder_transaction": holder_transaction},
                    ).all()
                if rows:
                    assert len({row[0] for row in rows}) == 1
                    waiter = int(rows[0][0])
                    assert "INSERT INTO project_chat_messages" in rows[0][1]
                    assert receipt_path.is_file()
                    with get_db_session() as killer:
                        killer.execute(text(f"KILL CONNECTION {waiter}"))
                    print(
                        "Migration interrupted at actual history insert: "
                        f"connection={waiter}, index={rows[0][2]}",
                        flush=True,
                    )
                    break
                if process.poll() is not None:
                    stdout, stderr = process.communicate()
                    raise AssertionError(
                        f"Writer exited before interruption: {stdout}{stderr}"
                    )
                Event().wait(0.03)
            if waiter is None:
                with get_db_session() as probe:
                    raw_waits = (
                        probe.execute(
                            text("SELECT * FROM performance_schema.data_lock_waits")
                        )
                        .mappings()
                        .all()
                    )
                    transactions = (
                        probe.execute(
                            text(
                                "SELECT trx_id, trx_mysql_thread_id, "
                                "trx_state, trx_query "
                                "FROM information_schema.innodb_trx"
                            )
                        )
                        .mappings()
                        .all()
                    )
                    message_locks = (
                        probe.execute(
                            text(
                                "SELECT ENGINE_TRANSACTION_ID, THREAD_ID, OBJECT_NAME, "
                                "INDEX_NAME, LOCK_TYPE, LOCK_MODE, "
                                "LOCK_STATUS, LOCK_DATA "
                                "FROM performance_schema.data_locks "
                                "WHERE OBJECT_NAME='project_chat_messages'"
                            )
                        )
                        .mappings()
                        .all()
                    )
                    diagnostics = probe.execute(
                        text(
                            """
                        SELECT requester.PROCESSLIST_ID, requester.PROCESSLIST_INFO,
                               requested.OBJECT_NAME, requested.INDEX_NAME,
                               requested.LOCK_DATA
                        FROM performance_schema.data_lock_waits waits
                        JOIN performance_schema.data_locks requested
                          ON requested.ENGINE_LOCK_ID=waits.REQUESTING_ENGINE_LOCK_ID
                        JOIN performance_schema.data_locks blocker
                          ON blocker.ENGINE_LOCK_ID=waits.BLOCKING_ENGINE_LOCK_ID
                        JOIN performance_schema.threads owner
                          ON owner.THREAD_ID=blocker.THREAD_ID
                        JOIN performance_schema.threads requester
                          ON requester.THREAD_ID=requested.THREAD_ID
                        WHERE owner.PROCESSLIST_ID=:holder
                    """
                        ),
                        {"holder": holder},
                    ).all()
                print(
                    json.dumps(
                        {
                            "disconnect_barrier_waits": [
                                list(row) for row in diagnostics
                            ],
                            "receipts_saved": receipt_path.exists(),
                            "writer_exit": process.poll(),
                            "holder_connection": holder,
                            "all_waits": [dict(row) for row in raw_waits],
                            "transactions": [dict(row) for row in transactions],
                            "message_locks": [dict(row) for row in message_locks],
                        },
                        default=str,
                    ),
                    flush=True,
                )
        finally:
            held.rollback()
            stdout, stderr = process.communicate(timeout=30)
        print(
            json.dumps(
                {
                    "disconnect_writer_stages": [
                        line
                        for line in stderr.splitlines()
                        if line.startswith('{"migration_stage":')
                    ]
                }
            ),
            flush=True,
        )
        if waiter is None:
            print(
                json.dumps(
                    {
                        "disconnect_writer_stdout_bytes": len(stdout.encode()),
                        "disconnect_writer_stderr_bytes": len(stderr.encode()),
                        "disconnect_writer_exit": process.returncode,
                    }
                ),
                flush=True,
            )
        assert waiter is not None, "Did not observe the late history insert wait"
        assert process.returncode != 0 and "2013" in stderr, stdout + stderr
    with get_db_session() as db:
        thread = db.get(LoopItem, thread_id)
        group = db.get(CollaborationChatGroup, report.target_group_id)
        assert (thread.cloud_project_id, thread.version) == (
            report.source_project_id,
            report.entries[0].version,
        )
        assert (group.version, group.next_item_number) == (
            report.target_version,
            report.target_next_item_number,
        )
        assert db.query(ThreadParticipant).filter_by(parent_id=thread_id).count() == 0
        assert (
            db.query(ThreadProjectLink).filter_by(loop_item_id=thread_id).count() == 0
        )
        assert (
            db.query(ThreadMigrationCheckpoint)
            .filter_by(parent_id=group.id, cloud_project_id=report.source_project_id)
            .count()
            == 0
        )
        assert (
            db.get(LoopItemComment, comment_id).cloud_project_id
            == report.source_project_id
        )


def verify_conditional_create(storage, receipt) -> None:
    sources = [copy.source_key for copy in receipt.objects[:2]]
    assert storage.get_bytes(sources[0]) != storage.get_bytes(sources[1])
    target = receipt.objects[0].target_key + ".conditional-race"
    ready = Barrier(2)

    def create(source):
        ready.wait(timeout=10)
        return storage.copy_object_if_absent(source, target)

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(create, sources))
    assert outcomes.count(True) == 1, outcomes
    assert outcomes.count(False) == 1, outcomes
    winner = sources[outcomes.index(True)]
    expected = storage.get_bytes(winner)
    assert storage.get_bytes(target) == expected
    for source in sources:
        assert storage.copy_object_if_absent(source, target) is False
        assert storage.get_bytes(target) == expected


def verify(source_id: int, target_id: int, actor_id: int) -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "backend"))
    from fastapi import HTTPException

    from app.db.session import get_db_session
    from app.models.delivery import LoopItem
    from app.models.loop_item_execution import LoopItemExecution
    from app.models.resource_member import ResourceMember
    from app.services.delivery.storage import delivery_storage
    from app.services.thread_migration import apply_thread_migration
    from app.services.thread_migration_assets import prepare_thread_migration_assets
    from app.services.thread_migration_inventory import inspect_thread_migration
    from app.services.thread_project_links import linked_project_id

    with get_db_session() as db:
        report = inspect_thread_migration(
            db,
            source_project_id=source_id,
            target_group_id=target_id,
            actor_user_id=actor_id,
        )
        assert len(report.entries) == 1
        assert len(report.entries[0].object_keys) >= 3
        grants = (
            db.query(ResourceMember)
            .filter(ResourceMember.resource_id.in_([source_id, target_id]))
            .count()
        )
        thread = db.get(LoopItem, report.entries[0].thread_id)
        original = (thread.cloud_project_id, thread.version, thread.current_delivery_id)
        execution = LoopItemExecution(
            loop_item_id=thread.id,
            cloud_project_id=str(source_id),
            executor_owner_user_id=actor_id,
            status="completed",
            runtime_device_id="migration-historical-private-device",
            runtime_task_id="migration-historical-private-task",
            execution_payload=json.dumps(
                {"origin_context": {"cloudProjectId": str(source_id)}}
            ),
        )
        db.add(execution)
        db.commit()
        execution_id = execution.id
    arguments = {
        "inventory": report,
        "actor_user_id": actor_id,
        "session_factory": get_db_session,
        "storage": delivery_storage,
    }
    receipt = prepare_thread_migration_assets(**arguments)
    for copy in receipt.objects:
        assert delivery_storage.get_bytes(
            copy.source_key
        ) == delivery_storage.get_bytes(copy.target_key)
    assert prepare_thread_migration_assets(**arguments) == receipt
    verify_conditional_create(delivery_storage, receipt)
    interrupted = receipt.objects[-1]
    delivery_storage.remove_objects([interrupted.target_key])
    assert prepare_thread_migration_assets(**arguments) == receipt
    delivery_storage.put_bytes(
        interrupted.target_key,
        b"deliberately corrupt staged bytes",
        "application/octet-stream",
    )
    try:
        prepare_thread_migration_assets(**arguments)
    except HTTPException as exc:
        assert exc.status_code == 409
        assert "different bytes" in str(exc.detail)
    else:
        raise AssertionError("Corrupt staged bytes were accepted")
    with get_db_session() as db:
        thread = db.get(LoopItem, report.entries[0].thread_id)
        assert (
            thread.cloud_project_id,
            thread.version,
            thread.current_delivery_id,
        ) == original
        assert (
            db.query(ResourceMember)
            .filter(ResourceMember.resource_id.in_([source_id, target_id]))
            .count()
            == grants
        )
        assert (
            inspect_thread_migration(
                db,
                source_project_id=source_id,
                target_group_id=target_id,
                actor_user_id=actor_id,
            ).to_dict()
            == report.to_dict()
        )
    try:
        apply_thread_migration(**arguments, assets=receipt, retain_source_project=True)
    except HTTPException as exc:
        assert exc.status_code == 409
    else:
        raise AssertionError("Ownership moved with corrupt staged bytes")
    delivery_storage.remove_objects([interrupted.target_key])
    assert prepare_thread_migration_assets(**arguments) == receipt
    for isolation in ("READ COMMITTED", "REPEATABLE READ"):
        verify_upload_race(arguments, receipt, isolation)
        with get_db_session() as db:
            report = inspect_thread_migration(
                db,
                source_project_id=source_id,
                target_group_id=target_id,
                actor_user_id=actor_id,
            )
        arguments["inventory"] = report
        receipt = prepare_thread_migration_assets(**arguments)
    result = verify_operator_cli(report, actor_id)
    with get_db_session() as db:
        thread = db.get(LoopItem, report.entries[0].thread_id)
        assert thread.cloud_project_id == str(target_id)
        assert thread.version == original[1] + 1
        assert thread.current_delivery_id == original[2]
        assert linked_project_id(db, thread.id) == str(source_id)
        history = db.get(LoopItemExecution, execution_id)
        assert history.cloud_project_id == str(target_id)
        assert history.executor_owner_user_id == actor_id
        assert history.runtime_task_id == "migration-historical-private-task"
        assert history.runtime_device_id == "migration-historical-private-device"
        assert history.runtime_origin_context == {"cloudProjectId": str(source_id)}
        assert (
            db.query(ResourceMember)
            .filter(ResourceMember.resource_id.in_([source_id, target_id]))
            .count()
            == grants
        )
    replay = apply_thread_migration(
        **arguments, assets=receipt, retain_source_project=True
    )
    assert replay.replayed and replay.checkpoint_id == result["checkpoint_id"]
    print(
        "Thread migration real asset copies, atomic ownership, checkpoint replay: PASS"
    )


if __name__ == "__main__":
    verify(*(int(value) for value in sys.argv[1:]))
