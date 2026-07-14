# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the wecode employee_id token-claim patch."""

import jwt

import wecode.api.outbound_token_service_patch  # noqa: F401  applies the patch
from app.schemas.token_issuer import (
    SigningKeyCreateRequest,
    TokenIssuerCreateRequest,
    TokenIssueRequest,
)
from app.services.auth.outbound_token_service import outbound_token_service
from wecode.models.erp_user import WecodeErpUser


def _make_issuer(test_db, name):
    key = outbound_token_service.create_signing_key(
        test_db, SigningKeyCreateRequest(name=f"{name}-key")
    )
    issuer = outbound_token_service.create_token_issuer(
        test_db,
        TokenIssuerCreateRequest(
            name=f"{name}-issuer",
            signing_key_id=key.id,
            issuer="wegent",
            audience="aud",
            default_ttl_seconds=600,
            max_ttl_seconds=900,
            enabled=True,
        ),
    )
    return key, issuer


def _decode(issued, key):
    return jwt.decode(
        issued.access_token,
        key.public_key_pem,
        algorithms=["RS256"],
        audience="aud",
        issuer="wegent",
    )


def test_employee_id_added_when_flag_set_and_row_present(test_db, test_user):
    test_db.add(WecodeErpUser(user_id=test_user.id, employee_id="12345"))
    test_db.commit()
    key, issuer = _make_issuer(test_db, "erp-present")
    issued = outbound_token_service.issue_token(
        test_db,
        issuer_id=issuer.id,
        user=test_user,
        request=TokenIssueRequest.model_validate(
            {"expires_in": 300, "include_employee_id": True}
        ),
    )
    assert _decode(issued, key)["employee_id"] == "12345"


def test_no_employee_id_when_flag_absent(test_db, test_user):
    test_db.add(WecodeErpUser(user_id=test_user.id, employee_id="12345"))
    test_db.commit()
    key, issuer = _make_issuer(test_db, "erp-noflag")
    issued = outbound_token_service.issue_token(
        test_db,
        issuer_id=issuer.id,
        user=test_user,
        request=TokenIssueRequest(expires_in=300),
    )
    assert "employee_id" not in _decode(issued, key)


def test_no_employee_id_when_row_missing(test_db, test_user):
    key, issuer = _make_issuer(test_db, "erp-missing")
    issued = outbound_token_service.issue_token(
        test_db,
        issuer_id=issuer.id,
        user=test_user,
        request=TokenIssueRequest.model_validate(
            {"expires_in": 300, "include_employee_id": True}
        ),
    )
    assert "employee_id" not in _decode(issued, key)


def test_no_employee_id_when_row_present_but_empty(test_db, test_user):
    # employee_id has server_default="", so an empty value is a real DB state
    # distinct from a missing row; it must not produce a claim.
    test_db.add(WecodeErpUser(user_id=test_user.id, employee_id=""))
    test_db.commit()
    key, issuer = _make_issuer(test_db, "erp-empty")
    issued = outbound_token_service.issue_token(
        test_db,
        issuer_id=issuer.id,
        user=test_user,
        request=TokenIssueRequest.model_validate(
            {"expires_in": 300, "include_employee_id": True}
        ),
    )
    assert "employee_id" not in _decode(issued, key)


def test_issue_endpoint_includes_employee_id_end_to_end(
    test_client,
    test_admin_token,
    test_token,
    test_db,
    test_user,
):
    """Full HTTP path with wecode patches loaded via app import (registration)."""
    test_db.add(WecodeErpUser(user_id=test_user.id, employee_id="88888"))
    test_db.commit()

    admin_headers = {"Authorization": f"Bearer {test_admin_token}"}
    signing_key = test_client.post(
        "/api/admin/signing-keys",
        headers=admin_headers,
        json={"name": "erp-e2e-key"},
    ).json()
    issuer = test_client.post(
        "/api/admin/token-issuers",
        headers=admin_headers,
        json={
            "name": "erp-e2e-issuer",
            "signing_key_id": signing_key["id"],
            "issuer": "wegent",
            "audience": "aud",
            "default_ttl_seconds": 600,
            "max_ttl_seconds": 900,
            "enabled": True,
        },
    ).json()

    issue_response = test_client.post(
        f"/api/v1/token-issuers/{issuer['id']}/issue",
        headers={"Authorization": f"Bearer {test_token}"},
        json={"expires_in": 300, "include_employee_id": True},
    )
    assert issue_response.status_code == 200
    claims = jwt.decode(
        issue_response.json()["access_token"],
        signing_key["public_key_pem"],
        algorithms=["RS256"],
        audience="aud",
        issuer="wegent",
    )
    assert claims["employee_id"] == "88888"


def test_no_erp_query_when_flag_absent(test_db, test_user, monkeypatch):
    # Issuance must stay cheap: the ERP table is only queried when the caller
    # opts in via include_employee_id.
    queried = []
    original_query = test_db.query

    def spy_query(*args, **kwargs):
        if args:
            queried.append(args[0])
        return original_query(*args, **kwargs)

    monkeypatch.setattr(test_db, "query", spy_query)

    key, issuer = _make_issuer(test_db, "erp-noquery")
    outbound_token_service.issue_token(
        test_db,
        issuer_id=issuer.id,
        user=test_user,
        request=TokenIssueRequest(expires_in=300),
    )
    assert WecodeErpUser not in queried


def test_db_error_degrades_gracefully(test_db, test_user, monkeypatch):
    from sqlalchemy.exc import SQLAlchemyError

    # A working row exists, but the ERP read is made to fail: issuance must
    # still succeed, just without the employee_id claim.
    test_db.add(WecodeErpUser(user_id=test_user.id, employee_id="12345"))
    test_db.commit()
    key, issuer = _make_issuer(test_db, "erp-dberr")  # do all setup queries first

    original_query = test_db.query

    def failing_query(entity, *args, **kwargs):
        if entity is WecodeErpUser:
            raise SQLAlchemyError("simulated DB failure")
        return original_query(entity, *args, **kwargs)

    monkeypatch.setattr(test_db, "query", failing_query)

    issued = outbound_token_service.issue_token(
        test_db,
        issuer_id=issuer.id,
        user=test_user,
        request=TokenIssueRequest.model_validate(
            {"expires_in": 300, "include_employee_id": True}
        ),
    )
    assert "employee_id" not in _decode(issued, key)
