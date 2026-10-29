---
sidebar_position: 27
title: Rust Authentication Compatibility
---

# Rust Authentication Compatibility

Rust-owned APIs use their corresponding Python authentication dependencies as the compatibility
reference. The active route configuration still determines ownership; changing shared authentication
does not migrate or switch other APIs.

## Session JWTs

Session entry points reuse backend-rs/src/auth.rs and jwt_compat.rs rather than creating independent
JWT validators with library defaults.

Verification checks the signature and configured algorithm, claims, session purpose, and active user,
in that order. The active key and configured legacy decode-only keys are supported. Key rotation must not bypass claim checks. Each alternative credential branch must validate its
own signature, time and purpose requirements.

The python-jose session contract is:

- Scope follows Python truthiness: missing, null, false, zero, empty strings, empty arrays and empty
  objects are falsey. Nonempty scopes are not user sessions. token_use permits only missing, null or
  wework_access.
- exp, nbf and iat are optional by default. Present values use Python int() conversion semantics.
- exp earlier than the current integer timestamp is expired; nbf later than now is not yet valid.
  There is no expiration leeway. Session iat validation checks integer conversion without an
  additional future-issued restriction.
- Present sub and jti claims must be strings. Session authentication additionally requires a valid
  username and an active user.
- Session decoding supplies neither audience nor access_token, so tokens containing aud or at_hash
  are rejected.

## Entry Points and Other Tokens

Standard and optional OAuth2 dependencies accept a case-insensitive Bearer scheme and reject raw
JWT headers. Missing or wrong schemes remain distinct from invalid Bearer credentials.

Flexible dependencies preserve the corresponding Python credential order and header parsing:
X-API-Key, Authorization API key, session JWT, then Task Token. Their parsing must not be replaced
wholesale with standard OAuth2 behavior.

Task Tokens and Skill identity tokens use PyJWT validation rather than session-purpose rules.
PyJWT rejects future iat and treats exp equal to now as expired; it does not validate at_hash.
Every Task Token fallback requires task_id, subtask_id, user_id and user_name fields and
type=task_token. Skill identity tokens retain their own required fields and purpose checks.
Device proofs keep their separate signature, request binding, time window and device checks.

Database failures in standard user lookup remain server errors rather than invalid-credential 401s.
Optional authentication returns an anonymous result as Python does; each business endpoint still
enforces its anonymous-access policy.

## Verification

The Python reference fixtures use a fixed clock and a test key, with no real tokens or user data.
Regenerate them with:

    uv run --no-project --with python-jose==3.5.0 --with PyJWT==2.10.1 python backend-rs/tests/fixtures/generate_jwt_python_cases.py

Rust unit tests check the fixtures, entry-point wiring, expired-token rejection, legacy keys, invalid
signatures and algorithms, token-purpose restrictions and database failure classification. Existing
Rust CI runs them through cargo test --locked. The existing Responses HTTP E2E suite also checks
session claims and Task fallback boundaries through the real gateway, MySQL and Redis; the same
Rust CI runs it through responses_large_json. Never log or commit JWTs, API keys, signing secrets or
authentication-file contents.
