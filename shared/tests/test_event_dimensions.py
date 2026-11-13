from shared.event_reporting.dimensions import (
    ActorDimensions,
    KnowledgeBaseDimensions,
    knowledge_base_fields,
    resolve_actor_dimensions,
    set_actor_provider,
    set_knowledge_base_provider,
)


def test_actor_and_knowledge_base_providers_are_independent():
    set_actor_provider(lambda _: ActorDimensions("actor-org", "v1"))
    set_knowledge_base_provider(lambda _: KnowledgeBaseDimensions("asset-org", "v2"))
    try:
        assert resolve_actor_dimensions(7) == ActorDimensions("actor-org", "v1")
        assert knowledge_base_fields(7) == {
            "asset_org_id": "asset-org",
            "asset_org_version": "v2",
        }
        set_actor_provider(None)
        assert resolve_actor_dimensions(7) is None
        assert knowledge_base_fields(7)["asset_org_id"] == "asset-org"
    finally:
        set_actor_provider(None)
        set_knowledge_base_provider(None)


def test_provider_release_preserves_replacement():
    from shared.event_reporting import register_dimension_providers

    actor = lambda _: ActorDimensions("first")
    asset = lambda _: KnowledgeBaseDimensions("first")
    replacement = lambda _: ActorDimensions("replacement")
    release = register_dimension_providers(actor, asset)
    set_actor_provider(replacement)
    release()
    try:
        assert resolve_actor_dimensions(1).org_id == "replacement"
        assert knowledge_base_fields(1) == {}
    finally:
        set_actor_provider(None)
        set_knowledge_base_provider(None)


def test_old_release_cannot_remove_same_callbacks_registered_again():
    from shared.event_reporting import register_dimension_providers

    def actor(_):
        return ActorDimensions("actor")

    def asset(_):
        return KnowledgeBaseDimensions("asset")

    old_release = register_dimension_providers(actor, asset)
    new_release = register_dimension_providers(actor, asset)
    try:
        old_release()
        assert resolve_actor_dimensions(1) == ActorDimensions("actor")
        assert knowledge_base_fields(1) == {"asset_org_id": "asset"}
    finally:
        new_release()


def test_forked_child_does_not_inherit_dimension_providers():
    import os

    import pytest

    if not hasattr(os, "fork"):
        pytest.skip("fork is unavailable")
    set_actor_provider(lambda _: ActorDimensions("parent"))
    set_knowledge_base_provider(lambda _: KnowledgeBaseDimensions("parent"))
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(read_fd)
        clean = resolve_actor_dimensions(1) is None and knowledge_base_fields(1) == {}
        os.write(write_fd, b"clean" if clean else b"inherited")
        os.close(write_fd)
        os._exit(0)
    os.close(write_fd)
    try:
        result = os.read(read_fd, 32)
        _, status = os.waitpid(pid, 0)
        assert status == 0
        assert result == b"clean"
        assert resolve_actor_dimensions(1) == ActorDimensions("parent")
    finally:
        os.close(read_fd)
        set_actor_provider(None)
        set_knowledge_base_provider(None)
