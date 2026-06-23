# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

from app.services.channels import messager_config


class FakeQuery:
    def __init__(self, row):
        self.row = row

    def filter(self, *args):
        return self

    def first(self):
        return self.row


class FakeSession:
    def __init__(self, row):
        self.row = row
        self.closed = False

    def query(self, model):
        return FakeQuery(self.row)

    def close(self):
        self.closed = True


def test_channel_config_helpers_read_messager_spec(monkeypatch):
    channel = SimpleNamespace(
        json={
            "spec": {
                "defaultTeamId": 42,
                "defaultModelName": "gpt-test",
                "config": {
                    "user_mapping_mode": "staff_id",
                    "user_mapping_config": {"tenant": "acme"},
                },
            }
        }
    )
    session = FakeSession(channel)
    monkeypatch.setattr(messager_config, "SessionLocal", lambda: session)

    assert messager_config.get_channel_default_team_id(7) == 42
    assert messager_config.get_channel_default_model_name(7) == "gpt-test"
    assert messager_config.get_channel_user_mapping_config(7) == {
        "mode": "staff_id",
        "config": {"tenant": "acme"},
    }
    assert session.closed is True


def test_channel_config_helpers_return_defaults_for_missing_channel(monkeypatch):
    session = FakeSession(None)
    monkeypatch.setattr(messager_config, "SessionLocal", lambda: session)

    assert messager_config.get_channel_default_team_id(7) is None
    assert messager_config.get_channel_default_model_name(7) is None
    assert messager_config.get_channel_user_mapping_config(7) == {
        "mode": "select_user",
        "config": None,
    }
