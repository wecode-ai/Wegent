# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for the template instantiation engine.

Covers:
- Inbox template with full resource chain (Ghost -> Bot -> Team -> Subscription -> WorkQueue)
- Direct-agent template with teamRef (only WorkQueue, no Ghost/Bot/Team/Subscription)
- Custom-team template (Ghost -> Bot -> Team -> WorkQueue, no Subscription)
- Subscription CRD JSON uses snake_case field names (event_type, not eventType)
"""

from unittest.mock import MagicMock, patch

import pytest

from app.models.kind import Kind
from app.services.template_instantiation import InboxTemplateInstantiator

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_kind(id_: int, name: str, kind_type: str) -> Kind:
    """Create a minimal Kind mock with id, name, and kind attributes."""
    k = MagicMock(spec=Kind)
    k.id = id_
    k.name = name
    k.kind = kind_type
    return k


def _make_template(resources: dict, display_name: str = "Test Template") -> Kind:
    """Build a fake Template Kind with the given resources spec."""
    template = MagicMock(spec=Kind)
    template.name = "test-template"
    template.json = {
        "spec": {
            "displayName": display_name,
            "category": "inbox",
            "resources": resources,
        }
    }
    return template


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def instantiator():
    return InboxTemplateInstantiator()


@pytest.fixture
def mock_db():
    """Return a mock SQLAlchemy session that auto-assigns IDs on flush."""
    db = MagicMock()
    _id_counter = [1]

    def _flush():
        # Simulate DB assigning IDs to newly added objects
        for call in db.add.call_args_list:
            obj = call[0][0]
            if not hasattr(obj, "id") or obj.id is None:
                obj.id = _id_counter[0]
                _id_counter[0] += 1

    db.flush.side_effect = _flush
    return db


# ---------------------------------------------------------------------------
# Test: full inbox template (Ghost -> Bot -> Team -> Subscription -> WorkQueue)
# ---------------------------------------------------------------------------


class TestInboxTemplate:
    """Full inbox automation template with all five resource types."""

    def test_creates_all_five_resources(self, instantiator, mock_db):
        """Instantiating an inbox template creates Ghost, Bot, Team, Subscription, WorkQueue."""
        template = _make_template(
            {
                "ghost": {"systemPrompt": "You are a summarizer."},
                "bot": {"shellName": "Chat"},
                "team": {"collaborationModel": "pipeline"},
                "subscription": {
                    "promptTemplate": "Summarize: {{inbox_message}}",
                    "retryCount": 1,
                    "timeoutSeconds": 300,
                },
                "queue": {"visibility": "private", "triggerMode": "immediate"},
            }
        )

        with patch(
            "app.services.template_instantiation.build_subscription_crd"
        ) as mock_build_crd:
            # build_subscription_crd returns a Pydantic-like object with model_dump
            fake_crd = MagicMock()
            fake_crd.model_dump.return_value = {
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Subscription",
                "metadata": {"name": "sub", "namespace": "default", "labels": {}},
                "spec": {
                    "trigger": {
                        "type": "event",
                        "event": {"event_type": "inbox_message"},
                    }
                },
            }
            mock_build_crd.return_value = fake_crd

            result = instantiator.instantiate(mock_db, user_id=1, template=template)

        # All five resource types should have been added
        added_kinds = [call[0][0].kind for call in mock_db.add.call_args_list]
        assert "Ghost" in added_kinds
        assert "Bot" in added_kinds
        assert "Team" in added_kinds
        assert "Subscription" in added_kinds
        assert "WorkQueue" in added_kinds

        # Response should have all IDs set
        assert result.ghostId is not None
        assert result.botId is not None
        assert result.teamId is not None
        assert result.subscriptionId is not None
        assert result.queueId is not None

    def test_subscription_json_uses_snake_case_event_type(self, instantiator, mock_db):
        """Subscription CRD JSON must use snake_case 'event_type', not camelCase 'eventType'."""
        template = _make_template(
            {
                "ghost": {"systemPrompt": "You are a helper."},
                "bot": {"shellName": "Chat"},
                "team": {"collaborationModel": "pipeline"},
                "subscription": {
                    "promptTemplate": "Process: {{inbox_message}}",
                    "retryCount": 1,
                    "timeoutSeconds": 300,
                },
                "queue": {"visibility": "private"},
            }
        )

        captured_subscription_json = {}

        def capturing_create_kind(db, user_id, kind_type, name, json_data):
            if kind_type == "Subscription":
                captured_subscription_json.update(json_data)
            # Simulate Kind creation
            k = MagicMock(spec=Kind)
            k.id = 99
            k.name = name
            k.kind = kind_type
            db.add(k)
            db.flush()
            return k

        with patch(
            "app.services.template_instantiation.build_subscription_crd"
        ) as mock_build_crd:
            fake_crd = MagicMock()
            fake_crd.model_dump.return_value = {
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Subscription",
                "metadata": {"name": "sub", "namespace": "default", "labels": {}},
                "spec": {
                    "trigger": {
                        "type": "event",
                        "event": {"event_type": "inbox_message"},
                    }
                },
            }
            mock_build_crd.return_value = fake_crd

            with patch.object(
                InboxTemplateInstantiator,
                "_create_kind",
                staticmethod(capturing_create_kind),
            ):
                instantiator.instantiate(mock_db, user_id=1, template=template)

        # Verify the CRD JSON passed to _create_kind uses snake_case
        trigger_event = (
            captured_subscription_json.get("spec", {})
            .get("trigger", {})
            .get("event", {})
        )
        assert "event_type" in trigger_event, (
            "Subscription JSON must use snake_case 'event_type', "
            f"got keys: {list(trigger_event.keys())}"
        )
        assert (
            "eventType" not in trigger_event
        ), "Subscription JSON must NOT use camelCase 'eventType'"

    def test_queue_uses_subscription_mode_when_subscription_present(
        self, instantiator, mock_db
    ):
        """WorkQueue autoProcess.mode must be 'subscription' when Subscription is created."""
        template = _make_template(
            {
                "ghost": {"systemPrompt": "Summarizer."},
                "bot": {"shellName": "Chat"},
                "team": {"collaborationModel": "pipeline"},
                "subscription": {
                    "promptTemplate": "Process: {{inbox_message}}",
                    "retryCount": 1,
                    "timeoutSeconds": 300,
                },
                "queue": {"visibility": "private"},
            }
        )

        captured_queue_json = {}

        def capturing_create_kind(db, user_id, kind_type, name, json_data):
            if kind_type == "WorkQueue":
                captured_queue_json.update(json_data)
            k = MagicMock(spec=Kind)
            k.id = 1
            k.name = name
            k.kind = kind_type
            db.add(k)
            db.flush()
            return k

        with patch(
            "app.services.template_instantiation.build_subscription_crd"
        ) as mock_build_crd:
            fake_crd = MagicMock()
            fake_crd.model_dump.return_value = {
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Subscription",
                "metadata": {"name": "sub", "namespace": "default", "labels": {}},
                "spec": {
                    "trigger": {
                        "type": "event",
                        "event": {"event_type": "inbox_message"},
                    }
                },
            }
            mock_build_crd.return_value = fake_crd

            with patch.object(
                InboxTemplateInstantiator,
                "_create_kind",
                staticmethod(capturing_create_kind),
            ):
                instantiator.instantiate(mock_db, user_id=1, template=template)

        auto_process = captured_queue_json.get("spec", {}).get("autoProcess", {})
        assert auto_process.get("mode") == "subscription"
        assert "subscriptionRef" in auto_process
        assert "teamRef" not in auto_process


# ---------------------------------------------------------------------------
# Test: direct-agent template with teamRef (only WorkQueue)
# ---------------------------------------------------------------------------


class TestDirectAgentTemplate:
    """Template that only creates a WorkQueue pointing to an existing Team."""

    def test_creates_only_work_queue(self, instantiator, mock_db):
        """A template with only 'queue' + teamRef creates exactly one WorkQueue."""
        template = _make_template(
            {
                "queue": {
                    "visibility": "private",
                    "triggerMode": "immediate",
                    "teamRef": {"name": "wegent-chat", "namespace": "default"},
                }
            }
        )

        result = instantiator.instantiate(mock_db, user_id=1, template=template)

        added_kinds = [call[0][0].kind for call in mock_db.add.call_args_list]
        assert added_kinds == [
            "WorkQueue"
        ], f"Expected only WorkQueue to be created, got: {added_kinds}"

        assert result.ghostId is None
        assert result.botId is None
        assert result.teamId is None
        assert result.subscriptionId is None
        assert result.queueId is not None

    def test_queue_uses_direct_agent_mode_with_team_ref(self, instantiator, mock_db):
        """WorkQueue autoProcess must use direct_agent mode with the specified teamRef."""
        template = _make_template(
            {
                "queue": {
                    "visibility": "private",
                    "teamRef": {"name": "wegent-chat", "namespace": "default"},
                }
            }
        )

        captured_queue_json = {}

        def capturing_create_kind(db, user_id, kind_type, name, json_data):
            if kind_type == "WorkQueue":
                captured_queue_json.update(json_data)
            k = MagicMock(spec=Kind)
            k.id = 1
            k.name = name
            k.kind = kind_type
            db.add(k)
            db.flush()
            return k

        with patch.object(
            InboxTemplateInstantiator,
            "_create_kind",
            staticmethod(capturing_create_kind),
        ):
            instantiator.instantiate(mock_db, user_id=1, template=template)

        auto_process = captured_queue_json.get("spec", {}).get("autoProcess", {})
        assert auto_process.get("mode") == "direct_agent"
        assert auto_process.get("teamRef", {}).get("name") == "wegent-chat"
        assert auto_process.get("teamRef", {}).get("namespace") == "default"
        assert "subscriptionRef" not in auto_process


# ---------------------------------------------------------------------------
# Test: custom-team template (Ghost -> Bot -> Team -> WorkQueue, no Subscription)
# ---------------------------------------------------------------------------


class TestCustomTeamTemplate:
    """Template that creates Ghost/Bot/Team but no Subscription."""

    @pytest.mark.parametrize(
        ("agent_config", "expected_namespace"),
        [
            (
                {"bind_model": "gpt-4.1", "bind_model_type": "public"},
                "default",
            ),
            (
                {
                    "bind_model": "private-model",
                    "bind_model_type": "user",
                    "bind_model_namespace": "personal-space",
                },
                "personal-space",
            ),
            (
                {
                    "bind_model": "group-model",
                    "bind_model_type": "group",
                    "bind_model_namespace": "team-space",
                },
                "team-space",
            ),
        ],
    )
    def test_bot_uses_standard_model_binding_fields(
        self, instantiator, mock_db, agent_config, expected_namespace
    ):
        """Bot creation should read bind_model_type/bind_model_namespace from template agentConfig."""
        template = _make_template(
            {
                "ghost": {"systemPrompt": "You are a chat assistant."},
                "bot": {
                    "shellName": "Chat",
                    "agentConfig": agent_config,
                },
                "team": {"collaborationModel": "solo"},
                "queue": {"visibility": "private"},
            }
        )

        captured_bot_json = {}

        def capturing_create_kind(db, user_id, kind_type, name, json_data):
            if kind_type == "Bot":
                captured_bot_json.update(json_data)
            k = MagicMock(spec=Kind)
            k.id = 1
            k.name = name
            k.kind = kind_type
            db.add(k)
            db.flush()
            return k

        with patch.object(
            InboxTemplateInstantiator,
            "_create_kind",
            staticmethod(capturing_create_kind),
        ):
            instantiator.instantiate(mock_db, user_id=1, template=template)

        assert captured_bot_json["spec"]["modelRef"] == {
            "name": agent_config["bind_model"],
            "namespace": expected_namespace,
        }

    def test_ghost_stores_precise_skill_refs_from_template_triplet(
        self, instantiator, mock_db
    ):
        """Ghost creation should persist resolved skill_refs when template provides name/namespace/userId."""
        template = _make_template(
            {
                "ghost": {
                    "systemPrompt": "You are a wiki organizer.",
                    "skillRefs": [
                        {
                            "name": "wegent-knowledge",
                            "namespace": "default",
                            "user_id": 0,
                        }
                    ],
                },
                "bot": {"shellName": "Chat"},
                "team": {"collaborationModel": "solo"},
                "queue": {"visibility": "private"},
            }
        )

        skill = MagicMock(spec=Kind)
        skill.id = 42
        skill.name = "wegent-knowledge"
        skill.kind = "Skill"
        skill.namespace = "default"
        skill.user_id = 0

        mock_db.query.return_value.filter.return_value.first.return_value = skill

        captured_ghost_json = {}

        def capturing_create_kind(db, user_id, kind_type, name, json_data):
            if kind_type == "Ghost":
                captured_ghost_json.update(json_data)
            k = MagicMock(spec=Kind)
            k.id = 1
            k.name = name
            k.kind = kind_type
            db.add(k)
            db.flush()
            return k

        with patch.object(
            InboxTemplateInstantiator,
            "_create_kind",
            staticmethod(capturing_create_kind),
        ):
            instantiator.instantiate(mock_db, user_id=1, template=template)

        assert captured_ghost_json["spec"]["skills"] == ["wegent-knowledge"]

    def test_ghost_stores_precise_preload_skill_refs_from_template_triplet(
        self, instantiator, mock_db
    ):
        """Ghost creation should persist resolved preload_skill_refs when template provides preload triplets."""
        template = _make_template(
            {
                "ghost": {
                    "systemPrompt": "You are a wiki organizer.",
                    "preloadSkillRefs": [
                        {
                            "name": "wegent-knowledge",
                            "namespace": "default",
                            "user_id": 0,
                        }
                    ],
                },
                "bot": {"shellName": "Chat"},
                "team": {"collaborationModel": "solo"},
                "queue": {"visibility": "private"},
            }
        )

        skill = MagicMock(spec=Kind)
        skill.id = 42
        skill.name = "wegent-knowledge"
        skill.kind = "Skill"
        skill.namespace = "default"
        skill.user_id = 0

        mock_db.query.return_value.filter.return_value.first.return_value = skill

        captured_ghost_json = {}

        def capturing_create_kind(db, user_id, kind_type, name, json_data):
            if kind_type == "Ghost":
                captured_ghost_json.update(json_data)
            k = MagicMock(spec=Kind)
            k.id = 1
            k.name = name
            k.kind = kind_type
            db.add(k)
            db.flush()
            return k

        with patch.object(
            InboxTemplateInstantiator,
            "_create_kind",
            staticmethod(capturing_create_kind),
        ):
            instantiator.instantiate(mock_db, user_id=1, template=template)

        assert captured_ghost_json["spec"]["preload_skills"] == ["wegent-knowledge"]

    def test_creates_ghost_bot_team_queue_without_subscription(
        self, instantiator, mock_db
    ):
        """Template without subscription creates Ghost, Bot, Team, WorkQueue only."""
        template = _make_template(
            {
                "ghost": {"systemPrompt": "You are a chat assistant."},
                "bot": {"shellName": "Chat"},
                "team": {"collaborationModel": "solo"},
                "queue": {"visibility": "private"},
            }
        )

        result = instantiator.instantiate(mock_db, user_id=1, template=template)

        added_kinds = [call[0][0].kind for call in mock_db.add.call_args_list]
        assert "Ghost" in added_kinds
        assert "Bot" in added_kinds
        assert "Team" in added_kinds
        assert "WorkQueue" in added_kinds
        assert "Subscription" not in added_kinds

        assert result.ghostId is not None
        assert result.botId is not None
        assert result.teamId is not None
        assert result.subscriptionId is None
        assert result.queueId is not None

    def test_single_bot_team_marks_member_as_leader(self, instantiator, mock_db):
        """Template-created single-bot Team should mark its only member as leader."""
        template = _make_template(
            {
                "ghost": {"systemPrompt": "You are a chat assistant."},
                "bot": {"shellName": "Chat"},
                "team": {"collaborationModel": "solo"},
                "queue": {"visibility": "private"},
            }
        )

        captured_team_json = {}

        def capturing_create_kind(db, user_id, kind_type, name, json_data):
            if kind_type == "Team":
                captured_team_json.update(json_data)
            k = MagicMock(spec=Kind)
            k.id = 1
            k.name = name
            k.kind = kind_type
            db.add(k)
            db.flush()
            return k

        with patch.object(
            InboxTemplateInstantiator,
            "_create_kind",
            staticmethod(capturing_create_kind),
        ):
            instantiator.instantiate(mock_db, user_id=1, template=template)

        assert captured_team_json["spec"]["members"] == [
            {
                "botRef": {
                    "name": captured_team_json["spec"]["members"][0]["botRef"]["name"],
                    "namespace": "default",
                },
                "prompt": "",
                "role": "leader",
                "requireConfirmation": False,
            }
        ]

    def test_queue_uses_direct_agent_mode_with_created_team(
        self, instantiator, mock_db
    ):
        """WorkQueue autoProcess uses direct_agent mode referencing the newly created Team."""
        template = _make_template(
            {
                "ghost": {"systemPrompt": "You are a chat assistant."},
                "bot": {"shellName": "Chat"},
                "team": {"collaborationModel": "solo"},
                "queue": {"visibility": "private"},
            }
        )

        captured_queue_json = {}

        def capturing_create_kind(db, user_id, kind_type, name, json_data):
            if kind_type == "WorkQueue":
                captured_queue_json.update(json_data)
            k = MagicMock(spec=Kind)
            k.id = 1
            k.name = name
            k.kind = kind_type
            db.add(k)
            db.flush()
            return k

        with patch.object(
            InboxTemplateInstantiator,
            "_create_kind",
            staticmethod(capturing_create_kind),
        ):
            instantiator.instantiate(mock_db, user_id=1, template=template)

        auto_process = captured_queue_json.get("spec", {}).get("autoProcess", {})
        assert auto_process.get("mode") == "direct_agent"
        assert "teamRef" in auto_process
        assert "subscriptionRef" not in auto_process

    def test_queue_missing_team_and_subscription_raises_error(
        self, instantiator, mock_db
    ):
        """A queue with no teamRef and no Team/Subscription should raise HTTPException."""
        from fastapi import HTTPException

        template = _make_template(
            {
                "queue": {"visibility": "private"},
            }
        )

        with pytest.raises(HTTPException) as exc_info:
            instantiator.instantiate(mock_db, user_id=1, template=template)

        assert exc_info.value.status_code == 400
        assert "auto-process" in exc_info.value.detail.lower()
