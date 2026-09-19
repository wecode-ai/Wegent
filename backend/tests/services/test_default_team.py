from app.models.kind import Kind
from app.models.user import User
from app.services.default_team import resolve_default_team


def add_team(db, owner, name="default-agent", namespace="default", modes=None):
    team = Kind(
        user_id=owner,
        kind="Team",
        name=name,
        namespace=namespace,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": name, "namespace": namespace},
            "spec": {
                "members": [],
                "collaborationModel": "coordinate",
                "bind_mode": modes or ["chat"],
            },
        },
    )
    db.add(team)
    db.commit()
    return team


def test_default_is_authorized_and_public_has_priority(test_db):
    user = User(user_name="default-reader", password_hash="unused", is_active=True)
    test_db.add(user)
    test_db.commit()
    public = add_team(test_db, 0)
    add_team(test_db, user.id)
    add_team(test_db, user.id + 1000)
    for index in range(110):
        add_team(test_db, user.id, name=f"other-{index}")

    team = resolve_default_team(
        test_db, user_id=user.id, mode="chat", name="default-agent", namespace="default"
    )
    assert team["id"] == public.id
    assert "bots" in team

    public.is_active = False
    test_db.commit()
    team = resolve_default_team(
        test_db, user_id=user.id, mode="chat", name="default-agent", namespace="default"
    )
    assert team["user_id"] == user.id


def test_default_does_not_expose_private_or_incompatible_teams(test_db):
    user = User(
        user_name="default-private-reader", password_hash="unused", is_active=True
    )
    test_db.add(user)
    test_db.commit()
    add_team(test_db, user.id + 1000)
    assert (
        resolve_default_team(
            test_db,
            user_id=user.id,
            mode="chat",
            name="default-agent",
            namespace="default",
        )
        is None
    )
    add_team(test_db, 0, modes=["code"])
    assert (
        resolve_default_team(
            test_db,
            user_id=user.id,
            mode="chat",
            name="default-agent",
            namespace="default",
        )
        is None
    )
    assert (
        resolve_default_team(
            test_db,
            user_id=user.id,
            mode="code",
            name="default-agent",
            namespace="default",
        )
        is not None
    )
    assert (
        resolve_default_team(
            test_db,
            user_id=user.id,
            mode="code",
            name="default-agent",
            namespace="other",
        )
        is None
    )
