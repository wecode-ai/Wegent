# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Tests for GCS gateway data classes, exceptions, and constants."""

from wecode.config.multimodal_config import multimodal_settings
from wecode.service.gcs.gcs_models import (
    GCS_APPKEY,
    GCS_GATEWAY_BASE,
    GCS_MESSAGE,
    GCS_MODEL_ID,
    GCS_TYPE,
    GcsGatewayError,
    GcsSessionInvalid,
    GcsUploadResult,
)


class TestGcsGatewayError:
    """GcsGatewayError carries error_code + gateway_code for endpoint mapping."""

    def test_carries_error_code_and_message(self):
        err = GcsGatewayError("gcs_file_too_large", "File exceeds limit")
        assert err.error_code == "gcs_file_too_large"
        assert "File exceeds limit" in str(err)

    def test_carries_optional_gateway_code(self):
        err = GcsGatewayError("gcs_upstream_error", "bad request", code=400)
        assert err.gateway_code == 400

    def test_gateway_code_defaults_to_none(self):
        err = GcsGatewayError("gcs_auth_failed", "auth failed")
        assert err.gateway_code is None


class TestGcsSessionInvalid:
    """GcsSessionInvalid is a GcsGatewayError with a default error_code."""

    def test_is_gcs_gateway_error_subclass(self):
        assert issubclass(GcsSessionInvalid, GcsGatewayError)

    def test_default_error_code(self):
        err = GcsSessionInvalid()
        assert err.error_code == "gcs_session_invalid"

    def test_custom_message(self):
        err = GcsSessionInvalid("custom reason")
        assert "custom reason" in str(err)


class TestConstantsFromConfig:
    """Constants are sourced from multimodal_settings, not hardcoded."""

    def test_gateway_base_matches_config(self):
        assert GCS_GATEWAY_BASE == multimodal_settings.GCS_GATEWAY_BASE

    def test_appkey_matches_config(self):
        assert GCS_APPKEY == multimodal_settings.GCS_APPKEY

    def test_all_config_fields_have_defaults(self):
        assert multimodal_settings.GCS_GATEWAY_BASE == "http://i.aigc.weibo.com"
        assert multimodal_settings.GCS_APPKEY == "2720640420"
        assert multimodal_settings.GCS_MODEL_ID == "gcs-standard"
        assert multimodal_settings.GCS_TYPE == "google-cloud"
        assert multimodal_settings.GCS_MESSAGE == "wegent-gemini-video"
        assert GCS_MODEL_ID == "gcs-standard"
        assert GCS_TYPE == "google-cloud"
        assert GCS_MESSAGE == "wegent-gemini-video"


class TestGcsUploadResult:
    """Frozen dataclass for simple-upload results."""

    def test_field_access(self):
        result = GcsUploadResult(
            object_name="obj/123.png",
            gs_url="gs://bucket/obj/123.png",
            request_id="req-1",
            file_size=55672,
            content_type="image/png",
        )
        assert result.object_name == "obj/123.png"
        assert result.gs_url == "gs://bucket/obj/123.png"
        assert result.request_id == "req-1"
        assert result.file_size == 55672
        assert result.content_type == "image/png"

    def test_is_frozen(self):
        result = GcsUploadResult(
            object_name="", gs_url="", request_id=None, file_size=0, content_type=""
        )
        try:
            result.object_name = "mutated"
            assert False, "Should have raised FrozenInstanceError"
        except AttributeError:
            pass
