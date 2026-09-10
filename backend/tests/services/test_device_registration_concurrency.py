"""Concurrent first registrations must keep one persistent runtime identity."""

import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.kind import Kind
from app.models.user import User
from app.services.device_service import device_service


def test_concurrent_first_registration_preserves_one_device(tmp_path):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'registration.db'}",
        connect_args={"check_same_thread": False, "timeout": 10},
    )
    for table in (User.__table__, Kind.__table__):
        table.create(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    original_updated_at = datetime(2020, 1, 1)
    with sessions.begin() as db:
        user = User(
            user_name="synthetic-registration",
            password_hash="unused",
            updated_at=original_updated_at,
        )
        db.add(user)
    user_id = user.id
    ready = threading.Barrier(8)

    def register(_):
        with sessions() as db:
            ready.wait(timeout=10)
            return device_service.upsert_device_crd(
                db,
                user_id=user_id,
                device_id="simultaneous-native-routes",
                name="Synthetic device",
                runtime_instance_id="same-runtime-instance",
            ).id

    try:
        with ThreadPoolExecutor(max_workers=8) as pool:
            ids = list(pool.map(register, range(8)))
        assert len(set(ids)) == 1
        with sessions() as db:
            assert db.query(Kind).filter_by(kind="Device").count() == 1
            assert db.get(User, user_id).updated_at == original_updated_at
    finally:
        engine.dispose()
