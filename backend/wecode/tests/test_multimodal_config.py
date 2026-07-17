# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Tests for the internal multimodal configuration (MultimodalSettings)."""

import importlib

from wecode.config.multimodal_config import MultimodalSettings, multimodal_settings


class TestDefaultValues:
    """MultimodalSettings ships sensible defaults for the internal build."""

    def test_multimodal_enabled_field_default_is_false(self):
        """The global kill switch field default is False (opt-in).

        We check the model field's default value rather than the instantiated
        setting, because the running environment's .env file may override it.
        """
        field_info = MultimodalSettings.model_fields["KNOWLEDGE_MULTIMODAL_ENABLED"]
        assert field_info.default is False

    def test_gcs_gateway_base_default(self):
        settings = MultimodalSettings()
        assert settings.GCS_GATEWAY_BASE == "http://i.aigc.weibo.com"

    def test_gcs_appkey_default(self):
        settings = MultimodalSettings()
        assert settings.GCS_APPKEY == "2720640420"

    def test_gcs_model_id_default(self):
        settings = MultimodalSettings()
        assert settings.GCS_MODEL_ID == "gcs-standard"

    def test_gcs_type_default(self):
        settings = MultimodalSettings()
        assert settings.GCS_TYPE == "google-cloud"

    def test_gcs_message_default(self):
        settings = MultimodalSettings()
        assert settings.GCS_MESSAGE == "wegent-gemini-video"

    def test_gcs_paths_default(self):
        settings = MultimodalSettings()
        assert (
            settings.MULTIMODAL_GCS_UPLOAD_PATH == "/api/internal/multimodal-gcs/upload"
        )

    def test_model_config_resolve_path_default(self):
        settings = MultimodalSettings()
        assert (
            settings.MULTIMODAL_MODEL_CONFIG_RESOLVE_PATH
            == "/api/internal/model-config/resolve"
        )

    def test_conversion_queue_default(self):
        settings = MultimodalSettings()
        assert (
            settings.KNOWLEDGE_MULTIMODAL_CONVERSION_QUEUE
            == "knowledge_multimodal_conversion"
        )


class TestEnvOverride:
    """Settings can be overridden via environment variables."""

    def test_gcs_gateway_base_can_be_overridden(self, monkeypatch):
        monkeypatch.setenv("GCS_GATEWAY_BASE", "https://custom.gateway.com")
        settings = MultimodalSettings()
        assert settings.GCS_GATEWAY_BASE == "https://custom.gateway.com"

    def test_multimodal_enabled_can_be_overridden(self, monkeypatch):
        monkeypatch.setenv("KNOWLEDGE_MULTIMODAL_ENABLED", "true")
        settings = MultimodalSettings()
        assert settings.KNOWLEDGE_MULTIMODAL_ENABLED is True


class TestSingleton:
    """The module-level multimodal_settings is a MultimodalSettings instance."""

    def test_singleton_is_multimodal_settings(self):
        assert isinstance(multimodal_settings, MultimodalSettings)

    def test_singleton_has_gcs_gateway_base(self):
        assert hasattr(multimodal_settings, "GCS_GATEWAY_BASE")
        assert multimodal_settings.GCS_GATEWAY_BASE == "http://i.aigc.weibo.com"
