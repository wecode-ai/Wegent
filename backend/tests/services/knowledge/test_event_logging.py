from sqlalchemy import Column, Integer, create_engine, event
from sqlalchemy.orm import Session, declarative_base

from app.services.knowledge import event_logging
from shared.event_reporting.catalogs.knowledge import loaded_scalar

Base = declarative_base()


class Row(Base):
    __tablename__ = "fact_test"
    id = Column(Integer, primary_key=True)


def test_commit_snapshot_does_not_load_expired_orm(mocker):
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    facts = []
    mocker.patch.object(event_logging, "is_event_reporting_enabled", return_value=True)
    mocker.patch.object(
        event_logging,
        "observe",
        side_effect=lambda name, factory: facts.append(factory()),
    )
    with Session(engine, expire_on_commit=True) as db:
        row = Row(id=7)
        db.add(row)
        event_logging.after_commit_fact(
            db, "knowledge.document.created", {"document_id": loaded_scalar(row, "id")}
        )
        db.commit()

        def reject_sql(*args):
            raise AssertionError("reporting cannot query after commit")

        event.listen(engine, "before_cursor_execute", reject_sql)
        assert loaded_scalar(row, "id") is None
        assert facts == [{"document_id": 7}]
    engine.dispose()


def test_rollback_and_close_discard_pending_facts(mocker):
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    mocker.patch.object(event_logging, "is_event_reporting_enabled", return_value=True)
    emit = mocker.patch.object(event_logging, "observe")
    with Session(engine) as db:
        for close in (False, True):
            db.begin()
            event_logging.after_commit_fact(db, "knowledge.document.deleted", {})
            db.close() if close else db.rollback()
            db.commit()
        emit.assert_not_called()
    engine.dispose()


def test_disabled_transaction_logging_does_not_touch_session(mocker):
    mocker.patch.object(event_logging, "is_event_reporting_enabled", return_value=False)
    event_logging.after_commit_fact(None, "knowledge.document.created", {})


def test_transaction_batch_is_bounded(mocker):
    mocker.patch.object(event_logging, "is_event_reporting_enabled", return_value=True)
    with Session() as db:
        for _ in range(200):
            event_logging.after_commit_fact(db, "knowledge.document.created", {})
        assert len(db.info[event_logging._KEY]) == 128
