# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for outbound token service."""

import jwt
import pytest
from sqlalchemy.orm import Session

from app.schemas.token_issuer import SigningKeyCreateRequest, TokenIssuerCreateRequest
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
