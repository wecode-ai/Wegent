# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Tests for GCS gateway TAuth2 authentication helpers."""

import types
from unittest.mock import MagicMock, patch

import pytest

from wecode.service.gcs import gcs_auth
from wecode.service.gcs.gcs_models import GcsGatewayError


class TestGetAuthHeaders:
    """get_auth_headers returns TAuth2 headers or raises on missing auth."""

    def test_returns_headers_with_authorization(self):
        with patch.object(gcs_auth, "auth_headers") as mock_auth:
            mock_auth.return_value = {"Authorization": "TAuth2 token=abc"}
            headers = gcs_auth.get_auth_headers()
        assert "Authorization" in headers
        assert "TAuth2" in headers["Authorization"]

    def test_raises_when_no_authorization(self):
        with patch.object(gcs_auth, "auth_headers") as mock_auth:
            mock_auth.return_value = {}
            with pytest.raises(GcsGatewayError) as exc_info:
                gcs_auth.get_auth_headers()
        assert exc_info.value.error_code == "gcs_auth_failed"

    def test_passes_weibo_video_uid(self):
        """get_auth_headers signs with the shared WEIBO_VIDEO_UID."""
        with patch.object(gcs_auth, "auth_headers") as mock_auth:
            mock_auth.return_value = {"Authorization": "ok"}
            gcs_auth.get_auth_headers()
        mock_auth.assert_called_once()
        passed_uid = mock_auth.call_args.args[0]
        from app.services.weibo_account_binding import WEIBO_VIDEO_UID

        assert passed_uid == WEIBO_VIDEO_UID


class TestInvalidateTauthCache:
    """invalidate_tauth_cache clears TAuth token, preferring public API."""

    def test_calls_invalidate_cache_when_available(self):
        """If tauth module exposes invalidate_cache(), use it."""
        mock_invalidate = MagicMock()
        fake_module = types.SimpleNamespace(invalidate_cache=mock_invalidate)
        # The function does `from app.services import tauth as _tauth_mod`,
        # which reads the `tauth` attribute from the already-imported
        # `app.services` package. Patch that attribute directly.
        import app.services

        with patch.object(app.services, "tauth", fake_module):
            gcs_auth.invalidate_tauth_cache()
        mock_invalidate.assert_called_once()

    def test_clears_cached_token_when_no_public_api(self):
        """Fallback: clear the private _cached_token attribute."""
        fake_module = types.SimpleNamespace(_cached_token="stale-token")
        import app.services

        with patch.object(app.services, "tauth", fake_module):
            gcs_auth.invalidate_tauth_cache()
        assert fake_module._cached_token is None

    def test_warns_when_neither_available(self):
        """Neither invalidate_cache nor _cached_token → log warning, no crash."""
        fake_module = types.SimpleNamespace()
        import app.services

        with patch.object(app.services, "tauth", fake_module):
            gcs_auth.invalidate_tauth_cache()
        assert not hasattr(fake_module, "_cached_token")
