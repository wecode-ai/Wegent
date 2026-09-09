def authorize() -> dict[str, Any]:
    """Obtain a new provider grant using its supported native authorization flow.

    Open the system browser, validate state and redirect URI, and use PKCE S256.
    Keep the verifier and tokens in memory; return only the credential mapping.
    Set expires_at to absolute Unix seconds. Never reuse a different CLI's grant
    unless it supports transferring exclusive refresh ownership to this broker.
    Put additional renewal/revocation secrets in provider_private; the backend
    excludes that object from business execution credentials.
    """
    raise AuthError("Provider authorization is not configured")


def refresh(credential: dict[str, Any]) -> dict[str, Any]:
    """Refresh once; never retry an uncertain provider request or persist tokens.

    Return access_token and expires_at, plus refresh_token when rotated.
    The SDK preserves unchanged account fields and non-rotated refresh tokens.
    The host commits the result under a platform lease before business dispatch.
    """
    raise AuthError("Provider refresh is not configured")


def revoke(credential: dict[str, Any]) -> None:
    """Revoke the provider grant; return only after provider confirmation.

    Use the provider's documented revocation endpoint. A failure must raise;
    never turn a network timeout into apparent successful revocation.
    This callback must be idempotent: the native worker retries after outages
    or a lost acknowledgement. A provider-confirmed already-revoked grant is
    success. Never revoke an unrelated account or a newly authorized grant.
    """
    raise AuthError("Provider revocation is not configured")
