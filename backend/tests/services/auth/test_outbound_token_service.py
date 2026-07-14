# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for outbound token service."""

import jwt
import pytest
from sqlalchemy.orm import Session

from app.schemas.token_issuer import (
    SigningKeyCreateRequest,
    TokenIssuerCreateRequest,
    TokenIssueRequest,
)
from app.services.auth.outbound_token_service import (
    OutboundTokenValidationError,
    outbound_token_service,
)


def test_issue_outbound_token_round_trips_with_public_key(
    test_db: Session,
    test_user,
):
    signing_key = outbound_token_service.create_signing_key(
        test_db,
        SigningKeyCreateRequest(name="vip-signing-key", description="for vip"),
    )
    issuer = outbound_token_service.create_token_issuer(
        test_db,
        TokenIssuerCreateRequest(
            name="vip-issuer",
            signing_key_id=signing_key.id,
            issuer="wegent",
            audience="vip_sql_platform",
            default_ttl_seconds=600,
            max_ttl_seconds=900,
            description="vip outbound issuer",
            enabled=True,
        ),
    )

    issued = outbound_token_service.issue_token(
        test_db,
        issuer_id=issuer.id,
        user=test_user,
        expires_in=300,
    )

    claims = jwt.decode(
        issued.access_token,
        signing_key.public_key_pem,
        algorithms=["RS256"],
        audience="vip_sql_platform",
        issuer="wegent",
    )

    assert issued.token_type == "Bearer"
    assert issued.expires_in == 300
    assert issued.issuer_id == issuer.id
    assert claims["sub"] == f"user:{test_user.id}"
    assert claims["aud"] == "vip_sql_platform"
    assert claims["user_id"] == test_user.id
    assert claims["user_name"] == test_user.user_name
    assert claims["issuer_id"] == issuer.id
    assert claims["jti"]
    assert claims["exp"] - claims["iat"] == 300


def test_cannot_enable_issuer_with_disabled_signing_key(
    test_db: Session,
):
    signing_key = outbound_token_service.create_signing_key(
        test_db,
        SigningKeyCreateRequest(name="disabled-base-key"),
    )
    outbound_token_service.toggle_signing_key_status(test_db, signing_key.id)

    with pytest.raises(OutboundTokenValidationError) as exc_info:
        outbound_token_service.create_token_issuer(
            test_db,
            TokenIssuerCreateRequest(
                name="blocked-issuer",
                signing_key_id=signing_key.id,
                issuer="wegent",
                audience="blocked-service",
                default_ttl_seconds=600,
                max_ttl_seconds=900,
                enabled=True,
            ),
        )

    assert "disabled signing key" in str(exc_info.value)


def test_cannot_disable_signing_key_while_enabled_issuer_references_it(
    test_db: Session,
):
    signing_key = outbound_token_service.create_signing_key(
        test_db,
        SigningKeyCreateRequest(name="shared-key"),
    )
    outbound_token_service.create_token_issuer(
        test_db,
        TokenIssuerCreateRequest(
            name="active-issuer",
            signing_key_id=signing_key.id,
            issuer="wegent",
            audience="vip_sql_platform",
            default_ttl_seconds=600,
            max_ttl_seconds=900,
            enabled=True,
        ),
    )

    with pytest.raises(OutboundTokenValidationError) as exc_info:
        outbound_token_service.toggle_signing_key_status(test_db, signing_key.id)

    assert "Disable dependent token issuers" in str(exc_info.value)


def test_cannot_delete_signing_key_while_disabled_issuer_references_it(
    test_db: Session,
):
    signing_key = outbound_token_service.create_signing_key(
        test_db,
        SigningKeyCreateRequest(name="delete-guard-key"),
    )
    outbound_token_service.create_token_issuer(
        test_db,
        TokenIssuerCreateRequest(
            name="disabled-issuer",
            signing_key_id=signing_key.id,
            issuer="wegent",
            audience="vip_sql_platform",
            default_ttl_seconds=600,
            max_ttl_seconds=900,
            enabled=False,
        ),
    )

    with pytest.raises(OutboundTokenValidationError) as exc_info:
        outbound_token_service.delete_signing_key(test_db, signing_key.id)

    assert "still referenced" in str(exc_info.value)
    assert exc_info.value.error_code == "SIGNING_KEY_DELETE_BLOCKED_BY_ISSUER"


def test_issue_outbound_token_uses_default_ttl_when_expires_in_is_none(
    test_db: Session,
    test_user,
):
    signing_key = outbound_token_service.create_signing_key(
        test_db,
        SigningKeyCreateRequest(name="default-ttl-key"),
    )
    issuer = outbound_token_service.create_token_issuer(
        test_db,
        TokenIssuerCreateRequest(
            name="default-ttl-issuer",
            signing_key_id=signing_key.id,
            issuer="wegent",
            audience="vip_sql_platform",
            default_ttl_seconds=600,
            max_ttl_seconds=900,
            enabled=True,
        ),
    )

    issued = outbound_token_service.issue_token(
        test_db,
        issuer_id=issuer.id,
        user=test_user,
        expires_in=None,
    )

    assert issued.expires_in == 600
    assert issued.expires_at - issued.issued_at == 600


@pytest.mark.parametrize("expires_in", [0, -1])
def test_issue_outbound_token_rejects_non_positive_ttl(
    test_db: Session,
    test_user,
    expires_in: int,
):
    signing_key = outbound_token_service.create_signing_key(
        test_db,
        SigningKeyCreateRequest(name=f"invalid-ttl-key-{expires_in}"),
    )
    issuer = outbound_token_service.create_token_issuer(
        test_db,
        TokenIssuerCreateRequest(
            name=f"invalid-ttl-issuer-{expires_in}",
            signing_key_id=signing_key.id,
            issuer="wegent",
            audience="vip_sql_platform",
            default_ttl_seconds=600,
            max_ttl_seconds=900,
            enabled=True,
        ),
    )

    with pytest.raises(OutboundTokenValidationError) as exc_info:
        outbound_token_service.issue_token(
            test_db,
            issuer_id=issuer.id,
            user=test_user,
            expires_in=expires_in,
        )

    assert "must be positive" in str(exc_info.value)


def _new_issuer(test_db, name):
    signing_key = outbound_token_service.create_signing_key(
        test_db, SigningKeyCreateRequest(name=f"{name}-key")
    )
    issuer = outbound_token_service.create_token_issuer(
        test_db,
        TokenIssuerCreateRequest(
            name=f"{name}-issuer",
            signing_key_id=signing_key.id,
            issuer="wegent",
            audience="aud",
            default_ttl_seconds=600,
            max_ttl_seconds=900,
            enabled=True,
        ),
    )
    return signing_key, issuer


def test_extra_claims_hook_merges_without_overriding_reserved(
    test_db, test_user, monkeypatch
):
    signing_key, issuer = _new_issuer(test_db, "hook")

    def fake_extra(self, db, *, user, issuer, request=None):
        return {"custom_claim": "ok", "sub": "hacked"}

    monkeypatch.setattr(
        type(outbound_token_service), "_collect_extra_claims", fake_extra
    )

    issued = outbound_token_service.issue_token(
        test_db,
        issuer_id=issuer.id,
        user=test_user,
        request=TokenIssueRequest(expires_in=300),
    )
    claims = jwt.decode(
        issued.access_token,
        signing_key.public_key_pem,
        algorithms=["RS256"],
        audience="aud",
        issuer="wegent",
    )
    assert claims["custom_claim"] == "ok"
    assert claims["sub"] == f"user:{test_user.id}"  # reserved 不被覆盖


def test_issue_request_ignores_unknown_fields_in_core(test_db, test_user):
    signing_key, issuer = _new_issuer(test_db, "unknown")
    req = TokenIssueRequest.model_validate(
        {"expires_in": 300, "include_employee_id": True}
    )
    issued = outbound_token_service.issue_token(
        test_db, issuer_id=issuer.id, user=test_user, request=req
    )
    claims = jwt.decode(
        issued.access_token,
        signing_key.public_key_pem,
        algorithms=["RS256"],
        audience="aud",
        issuer="wegent",
    )
    assert "employee_id" not in claims  # core 无扩展
