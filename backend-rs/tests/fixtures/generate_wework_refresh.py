"""Generate synthetic JWT/ES256 fixtures with the Python endpoint as oracle.

Run from the repository root:
uv run --directory backend --no-sync python ../backend-rs/tests/fixtures/generate_wework_refresh.py
The scalar 1 is a public test key, never a production device identity.
"""

import ast
import base64
import hashlib
import json
from collections.abc import Sequence
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import HTTPException, status
from jose import JWTError, jwt

ROOT = Path(__file__).resolve().parents[3]
NOW = 1_800_000_000
PATH = "/api/auth/wework/refresh"
KEY = "wework-refresh-public-test-secret"
DEVICE_KEY = ec.derive_private_key(1, ec.SECP256R1())


def b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def public_key(private_key: ec.EllipticCurvePrivateKey) -> dict[str, str]:
    point = private_key.public_key().public_numbers()
    return {
        "kty": "EC",
        "crv": "P-256",
        "x": b64(point.x.to_bytes(32, "big")),
        "y": b64(point.y.to_bytes(32, "big")),
    }


def python_oracle() -> dict[str, Any]:
    source = ROOT / "backend/app/api/endpoints/wework_auth.py"
    names = {
        "_base64url_decode",
        "_validated_device_public_key",
        "_device_key_thumbprint",
        "_token_hash",
        "_decode_refresh_token",
        "_verify_device_proof",
    }
    tree = ast.parse(source.read_text())
    tree.body = [
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name in names
    ]
    namespace = {
        "base64": base64,
        "hashlib": hashlib,
        "json": json,
        "jwt": jwt,
        "JWTError": JWTError,
        "HTTPException": HTTPException,
        "status": status,
        "time": SimpleNamespace(time=lambda: NOW),
        "settings": SimpleNamespace(SECRET_KEY=KEY, ALGORITHM="HS256"),
        "WEWORK_REFRESH_TOKEN_USE": "wework_refresh",
        "DEVICE_PROOF_MAX_AGE_SECONDS": 300,
    }
    exec(compile(tree, str(source), "exec"), namespace)
    return namespace


JWK = public_key(DEVICE_KEY)
THUMBPRINT = b64(
    hashlib.sha256(
        json.dumps(JWK, separators=(",", ":"), sort_keys=True).encode()
    ).digest()
)


def make_request(
    refresh: dict[str, Any] | None = None,
    proof: dict[str, Any] | None = None,
    header: dict[str, Any] | None = None,
    algorithm: str = "HS256",
    private_key: ec.EllipticCurvePrivateKey = DEVICE_KEY,
    secret: str = KEY,
    remove_refresh: Sequence[str] = (),
    remove_proof: Sequence[str] = (),
) -> dict[str, str]:
    claims = {
        "sub": "fixture-user",
        "user_id": 7,
        "token_use": "wework_refresh",
        "cnf": {"jkt": THUMBPRINT},
        "jti": "refresh-fixture",
        "exp": NOW + 3600,
    }
    claims.update(refresh or {})
    for name in remove_refresh:
        claims.pop(name, None)
    token = jwt.encode(claims, secret, algorithm=algorithm)
    payload = {
        "iat": NOW,
        "htm": "POST",
        "htu": PATH,
        "ath": b64(hashlib.sha256(token.encode()).digest()),
        "jti": "proof-fixture",
    }
    payload.update(proof or {})
    for name in remove_proof:
        payload.pop(name, None)
    headers = {"jwk": JWK, **(header or {})}
    return {
        "refresh_token": token,
        "proof": jwt.encode(payload, private_key, algorithm="ES256", headers=headers),
    }


def expected_result(
    oracle: dict[str, Any], request: dict[str, str], algorithm: str
) -> dict[str, Any]:
    oracle["settings"].ALGORITHM = algorithm
    try:
        claims = oracle["_decode_refresh_token"](request["refresh_token"])
        cnf = claims.get("cnf")
        thumbprint = cnf.get("jkt") if isinstance(cnf, dict) else None
        if not isinstance(thumbprint, str) or not thumbprint:
            raise HTTPException(401, "Invalid desktop refresh token")
        oracle["_verify_device_proof"](
            request["proof"], request["refresh_token"], thumbprint, PATH
        )
        if not isinstance(claims.get("sub"), str):
            raise HTTPException(401, "Invalid desktop refresh token")
        return {"status": 200}
    except HTTPException as error:
        return {"status": error.status_code, "detail": error.detail}


def scenarios() -> list[tuple[str, dict[str, Any]]]:
    cases = [
        ("valid", {}),
        ("hs384", {"algorithm": "HS384"}),
        ("hs512", {"algorithm": "HS512"}),
        ("wrong_signing_key", {"secret": "different-public-test-secret"}),
        ("missing_exp", {"remove_refresh": ["exp"]}),
        ("missing_subject", {"remove_refresh": ["sub"]}),
        (
            "wrong_device_signature",
            {"private_key": ec.derive_private_key(2, ec.SECP256R1())},
        ),
    ]
    refresh_values = {
        "token_use": ["wework_access"],
        "cnf": [{}, {"jkt": ""}, {"jkt": 1}, {"jkt": "other"}],
        "exp": [NOW, NOW - 1, -1, "invalid", str(NOW - 1), str(NOW + 3600), NOW + 0.9],
        "nbf": [NOW, NOW + 1, "invalid", str(NOW + 1)],
        "iat": ["invalid"],
        "aud": ["other-service", []],
        "sub": [7],
        "jti": [7],
        "at_hash": ["other"],
    }
    proof_values = {
        "iat": [
            NOW + 30,
            NOW + 31,
            NOW - 300,
            NOW - 301,
            str(NOW),
            1.5,
            2**63 - 1,
            -(2**63),
        ],
        "htm": ["GET"],
        "htu": ["/api/other"],
        "ath": ["other"],
        "jti": ["", 7],
        "exp": [NOW - 1, "invalid"],
        "nbf": [NOW + 1],
        "aud": ["other-service"],
    }
    for group, fields in [("refresh", refresh_values), ("proof", proof_values)]:
        for field, values in fields.items():
            for index, value in enumerate(values):
                cases.append((f"{group}_{field}_{index}", {group: {field: value}}))
    for field in ["iat", "htm", "htu", "ath", "jti"]:
        cases.append((f"proof_missing_{field}", {"remove_proof": [field]}))
    cases.extend(
        [
            ("missing_jwk", {"header": {"jwk": None}}),
            ("wrong_curve", {"header": {"jwk": {**JWK, "crv": "P-384"}}}),
            ("short_coordinate", {"header": {"jwk": {**JWK, "x": "AA"}}}),
            ("non_string_coordinate", {"header": {"jwk": {**JWK, "x": 1}}}),
            (
                "invalid_curve_point",
                {
                    "header": {"jwk": {**JWK, "x": b64(bytes(32))}},
                    "refresh": {
                        "cnf": {
                            "jkt": b64(
                                hashlib.sha256(
                                    json.dumps(
                                        {**JWK, "x": b64(bytes(32))},
                                        separators=(",", ":"),
                                        sort_keys=True,
                                    ).encode()
                                ).digest()
                            )
                        }
                    },
                },
            ),
        ]
    )
    return cases


def main() -> None:
    oracle = python_oracle()
    cases = []
    for name, options in scenarios():
        request = make_request(**options)
        algorithm = options.get("algorithm", "HS256")
        with patch("jose.jwt.datetime") as clock:
            clock.now.return_value = datetime.fromtimestamp(NOW, timezone.utc)
            expected = expected_result(oracle, request, algorithm)
        cases.append(
            {
                "name": name,
                "algorithm": algorithm,
                "request": request,
                "expected": expected,
            }
        )
    output = Path(__file__).with_name("wework_refresh.json")
    output.write_text(
        json.dumps({"now": NOW, "secret": KEY, "cases": cases}, indent=2) + "\n"
    )
    print(f"Generated {len(cases)} synthetic cases using the Python endpoint")


if __name__ == "__main__":
    main()
