# SPDX-License-Identifier: Apache-2.0
"""Plugin callbacks without descriptor, framing, or envelope boilerplate."""

from __future__ import annotations

import contextlib
import json
import os
from collections.abc import Callable, Sequence
from typing import Any, BinaryIO, Literal

from .runtime import native_execution_scope
from .transport import AuthError, open_pipe, read_frame, write_frame

Credential = dict[str, Any]
CredentialType = Literal["password", "bearer", "oauth2"]
_REQUIRED_FIELDS = {
    "password": ("username", "password"),
    "bearer": ("token",),
    "oauth2": ("access_token",),
}


class SourceChanged(AuthError):
    """Detach durably fenced off this transfer ID without deleting the new grant."""


@contextlib.contextmanager
def _quiet_callbacks():
    # Authentication callbacks may accidentally print upstream errors or secrets.
    # Business command output remains owned by the plugin's execute callback.
    with open(os.devnull, "w") as sink:
        with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            yield


class AccountAuthAdapter:
    """Use only in a dedicated process launched by an authenticated native broker.

    OAuth tokens can be transported, but refresh ownership remains the host's
    responsibility. This SDK does not authorize devices or migrate local storage.
    """

    def __init__(
        self,
        *,
        connector_slug: str,
        credential_type: CredentialType,
        export: Callable[[], Credential | None],
        account_id: Callable[[Credential], str],
        execute: Callable[[Credential, Sequence[str]], int],
        allowed_commands: Sequence[str],
        validate: Callable[[Credential], None] | None = None,
        authorize: Callable[[], Credential] | None = None,
        refresh: Callable[[Credential], Credential] | None = None,
        revoke: Callable[[Credential], None] | None = None,
        detach: Callable[[str, Credential], None] | None = None,
    ) -> None:
        if credential_type not in _REQUIRED_FIELDS or not connector_slug:
            raise AuthError("Invalid adapter definition")
        self.connector_slug = connector_slug
        self.credential_type = credential_type
        self._export = export
        self._account_id = account_id
        self._execute = execute
        self._validate = validate
        self._allowed_commands = frozenset(allowed_commands)
        if credential_type != "oauth2" and any((authorize, refresh, revoke, detach)):
            raise AuthError("OAuth callbacks require an OAuth adapter")
        self._authorize = authorize
        self._refresh = refresh
        self._revoke = revoke
        self._detach = detach

    def _validate_credential(self, value: Any) -> Credential:
        try:
            if not isinstance(value, dict):
                raise ValueError
            for key in _REQUIRED_FIELDS[self.credential_type]:
                if not isinstance(value.get(key), str) or not value[key].strip():
                    raise ValueError
            if self._validate is not None:
                with _quiet_callbacks():
                    self._validate(value)
            return value
        except (Exception, SystemExit):
            raise AuthError("Invalid credential payload") from None

    def read_credential(self, stream: BinaryIO) -> Credential:
        payload = read_frame(stream)
        if (
            set(payload)
            != {"protocolVersion", "connectorSlug", "credentialType", "credential"}
            or type(payload.get("protocolVersion")) is not int
            or payload["protocolVersion"] != 1
            or payload["connectorSlug"] != self.connector_slug
            or payload["credentialType"] != self.credential_type
        ):
            raise AuthError("Invalid credential envelope")
        return self._validate_credential(payload["credential"])

    def export_credential(self, stream: BinaryIO, exporter=None) -> dict[str, Any]:
        try:
            with _quiet_callbacks():
                credential = self._validate_credential((exporter or self._export)())
                account_id = self._account_id(credential)
            if not isinstance(account_id, str) or not account_id.strip():
                raise ValueError
        except (Exception, SystemExit):
            raise AuthError("Local authentication is unavailable") from None
        write_frame(
            stream,
            {
                "protocolVersion": 1,
                "connectorSlug": self.connector_slug,
                "credentialType": self.credential_type,
                "credential": credential,
            },
        )
        return {
            "status": "ok",
            "protocolVersion": 1,
            "accountId": account_id,
            "credentialType": self.credential_type,
        }

    def main(self, argv: Sequence[str]) -> int:
        try:
            if (
                len(argv) == 2
                and argv[0] == "detach"
                and self._detach is not None
                and len(argv[1]) == 64
                and all(c in "0123456789abcdef" for c in argv[1])
            ):
                with open_pipe("rb") as stream:
                    credential = self.read_credential(stream)
                status = "detached"
                try:
                    with _quiet_callbacks():
                        self._detach(argv[1], credential)
                except SourceChanged:
                    status = "source_changed"
                print(json.dumps({"status": status, "protocolVersion": 1}))
                return 0
            if list(argv) == ["authorize"] and self._authorize is not None:
                with open_pipe("wb") as stream:
                    metadata = self.export_credential(stream, self._authorize)
                print(json.dumps(metadata, ensure_ascii=False))
                return 0
            if list(argv) == ["refresh"] and self._refresh is not None:
                with open_pipe("rwb") as stream:
                    credential = self.read_credential(stream)
                    with _quiet_callbacks():
                        previous_id = self._account_id(credential)
                        update = self._refresh(dict(credential))
                        if (
                            not isinstance(update, dict)
                            or not update.get("access_token")
                            or "expires_at" not in update
                        ):
                            raise AuthError(
                                "OAuth refresh did not return a fresh access token"
                            )
                        refreshed = self._validate_credential({**credential, **update})
                        if self._account_id(refreshed) != previous_id:
                            raise AuthError("OAuth account changed during refresh")
                    metadata = self.export_credential(stream, lambda: refreshed)
                print(json.dumps(metadata, ensure_ascii=False))
                return 0
            if list(argv) == ["revoke"] and self._revoke is not None:
                with open_pipe("rb") as stream:
                    credential = self.read_credential(stream)
                with _quiet_callbacks():
                    self._revoke(credential)
                print(json.dumps({"status": "ok", "protocolVersion": 1}))
                return 0
            if list(argv) == ["export"]:
                with open_pipe("wb") as stream:
                    metadata = self.export_credential(stream)
                print(json.dumps(metadata, ensure_ascii=False))
                return 0
            if (
                len(argv) >= 2
                and argv[0] == "run"
                and argv[1] in self._allowed_commands
            ):
                with open_pipe("rb") as stream:
                    credential = self.read_credential(stream)
                with native_execution_scope():
                    return self._execute(credential, argv[1:])
            raise AuthError("Unsupported adapter operation")
        except (Exception, SystemExit):
            print(json.dumps({"status": "error", "code": "plugin_auth_adapter_failed"}))
            return 1
