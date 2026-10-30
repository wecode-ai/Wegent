"""Regenerate with uv run --no-project --with python-jose==3.5.0
--with PyJWT==2.10.1 backend-rs/tests/fixtures/generate_jwt_python_cases.py.
The fixtures use public test claims and a fixed clock, never real credentials.
"""

import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import jwt as pyjwt
from jose import jwt as jose_jwt

NOW = 2_000_000_000
ROOT = Path(__file__).resolve().parents[3]


class FrozenDatetime(datetime):
    @classmethod
    def now(cls, tz: Any = None) -> datetime:
        return datetime.fromtimestamp(NOW, tz=tz or timezone.utc)


def claim_cases() -> list[tuple[str, dict[str, Any]]]:
    cases = [
        ("ordinary", {}),
        ("wework_access", {"token_use": "wework_access"}),
        ("refresh", {"token_use": "wework_refresh"}),
        ("task_scope", {"scope": "task"}),
        ("api_scope", {"scope": "api_key"}),
    ]
    for label, value in [
        ("null", None),
        ("false", False),
        ("zero", 0),
        ("float_zero", 0.0),
        ("empty_string", ""),
        ("empty_list", []),
        ("empty_object", {}),
        ("true", True),
        ("one", 1),
        ("list", ["read"]),
        ("object", {"a": 1}),
    ]:
        cases.append(("scope_" + label, {"scope": value}))
    for field in ["exp", "nbf", "iat"]:
        for label, value in [
            ("past", NOW - 30),
            ("now", NOW),
            ("future", NOW + 30),
            ("string_future", str(NOW + 30)),
            ("string_past", str(NOW - 30)),
            ("float_future", NOW + 30.9),
            ("float_past", NOW - 30.9),
            ("bad_string", "not-a-number"),
            ("false", False),
            ("whitespace", "  +2000000030  "),
            ("unicode_whitespace", "\u00852000000030\u00a0"),
            ("control_prefix", "\x1c2000000030"),
            ("control_suffix", "2000000030\x1f"),
            ("underscore", "2_000_000_030"),
            ("unicode", "٢٠٠٠٠٠٠٠٣٠"),
            ("huge_string", "9" * 150),
        ]:
            cases.append((field + "_" + label, {field: value}))
    for label, value in [
        ("string", "other-service"),
        ("list", ["other-service"]),
        ("empty_list", []),
        ("null", None),
        ("integer", 123),
    ]:
        cases.append(("aud_" + label, {"aud": value}))
    for field in ["jti", "sub"]:
        for label, value in [
            ("string", "u"),
            ("integer", 123),
            ("null", None),
            ("empty_string", ""),
        ]:
            cases.append((field + "_" + label, {field: value}))
    return cases + [
        ("at_hash_present", {"at_hash": "test-value"}),
        ("nbf_string_decimal", {"nbf": "2000000030.5"}),
        ("iat_huge_float", {"iat": 1e200}),
        ("exp_huge_float", {"exp": 1e200}),
    ]


def library_result(library: Any, token: str) -> tuple[bool, str | None]:
    try:
        library.decode(token, "test-key", algorithms=["HS256"])
        return True, None
    except Exception as error:
        return False, type(error).__name__


def main() -> None:
    jose_jwt.datetime = FrozenDatetime
    pyjwt.api_jwt.datetime = FrozenDatetime
    spec = importlib.util.spec_from_file_location(
        "session_token", ROOT / "backend/app/core/session_token.py"
    )
    assert spec and spec.loader
    session_token = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(session_token)
    rows = []
    for name, delta in claim_cases():
        claims = {"sub": "u", **delta}
        token = jose_jwt.encode(claims, "test-key", algorithm="HS256")
        valid, error = library_result(jose_jwt, token)
        pyjwt_valid, pyjwt_error = library_result(pyjwt, token)
        session_valid = (
            valid
            and session_token.is_user_session_payload(claims)
            and isinstance(claims.get("sub"), str)
            and bool(claims.get("sub"))
        )
        rows.append(
            {
                "name": name,
                "claims": claims,
                "jose_valid": valid,
                "pyjwt_valid": pyjwt_valid,
                "session_valid": bool(session_valid),
                "python_exception": error,
                "pyjwt_exception": pyjwt_error,
            }
        )
    fixture = {
        "python_jose_version": "3.5.0",
        "pyjwt_version": "2.10.1",
        "now": NOW,
        "cases": rows,
    }
    output = Path(__file__).with_name("jwt-python-jose.json")
    content = json.dumps(fixture, indent=2) + "\n"
    if not output.exists() or output.read_text(encoding="utf-8") != content:
        output.write_text(content, encoding="utf-8")
    print(f"Generated {len(rows)} Python JWT cases")


if __name__ == "__main__":
    main()
