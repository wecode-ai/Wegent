from __future__ import annotations

import random
import socket


class IdCreateException(Exception):
    pass


class UuidFactory:
    def __init__(
        self,
        server: str | tuple[str, int],
        key_prefix: str | bytes = "0_uuid",
        connect_timeout: float = 1.0,
        timeout: float = 1.0,
        random_generator: random.Random | None = None,
    ):
        if isinstance(server, str):
            if ":" in server:
                host, port = server.rsplit(":", 1)
                self._server = (host, int(port))
            else:
                self._server = (server, 11211)
        else:
            self._server = server

        if isinstance(key_prefix, str):
            if not key_prefix.strip():
                raise ValueError("key_prefix must not be empty")
            self._key_prefix = key_prefix.encode()
        else:
            if not key_prefix:
                raise ValueError("key_prefix must not be empty")
            self._key_prefix = key_prefix

        self._connect_timeout = connect_timeout
        self._timeout = timeout
        self._random_generator = random_generator or random.Random()

    def _build_key(self) -> bytes:
        random_int = self._random_generator.randint(-(2**31), 2**31 - 1)
        return self._key_prefix + str(random_int).encode()

    def next_id(self) -> int:
        try:
            key = self._build_key()
            value = self._get_value(key)
            uuid_id = int(value)
            if uuid_id <= 0:
                raise IdCreateException(f"memcache returned invalid uuid: {uuid_id}")
            return uuid_id
        except Exception as exc:
            if isinstance(exc, IdCreateException):
                raise
            raise IdCreateException(f"failed to create uuid: {exc}") from exc

    def _get_value(self, key: bytes) -> str:
        command = b"get " + key + b"\r\n"
        response = self._send_get_command(command)
        lines = response.split(b"\r\n")
        if not lines or lines[0] == b"END":
            raise IdCreateException(f"memcache uuid key not found: {key!r}")
        if not lines[0].startswith(b"VALUE "):
            raise IdCreateException(f"unexpected memcache uuid response: {response!r}")
        if len(lines) < 3 or lines[2] != b"END":
            raise IdCreateException(f"incomplete memcache uuid response: {response!r}")
        value = lines[1].decode().strip()
        if not value:
            raise IdCreateException(f"memcache uuid key not found: {key!r}")
        return value

    def _send_get_command(self, command: bytes) -> bytes:
        chunks: list[bytes] = []
        with socket.create_connection(
            self._server,
            timeout=self._connect_timeout,
        ) as sock:
            sock.settimeout(self._timeout)
            sock.sendall(command)
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                chunks.append(chunk)
                response = b"".join(chunks)
                if response.endswith(b"\r\nEND\r\n") or response == b"END\r\n":
                    return response
        return b"".join(chunks)

    def close(self) -> None:
        return None
