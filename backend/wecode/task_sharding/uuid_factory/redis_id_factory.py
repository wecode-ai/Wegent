from __future__ import annotations

import socket
from urllib.parse import unquote, urlparse


class RedisIdFactory:
    """Global sequence counter backed by Redis INCR.

    Every call to next_seq() atomically increments a single Redis key and
    returns the new value.  The counter is shared across all users so seq
    values are globally unique and monotonically increasing.
    """

    def __init__(
        self,
        server: str | tuple[str, int],
        key: str = "task_global_seq",
        connect_timeout: float = 1.0,
        timeout: float = 1.0,
    ):
        self._username: str | None = None
        self._password: str | None = None
        self._database: int | None = None

        if isinstance(server, str):
            if server.startswith("redis://"):
                parsed = urlparse(server)
                if not parsed.hostname:
                    raise ValueError("Redis URL must include a host")
                self._server = (parsed.hostname, parsed.port or 6379)
                self._username = unquote(parsed.username) if parsed.username else None
                self._password = (
                    unquote(parsed.password) if parsed.password is not None else None
                )
                if parsed.path and parsed.path != "/":
                    self._database = int(parsed.path.lstrip("/"))
            else:
                raise ValueError("server must be a redis:// URL")
        else:
            self._server = server

        if not key or not key.strip():
            raise ValueError("key must not be empty")
        self._key = key
        self._connect_timeout = connect_timeout
        self._timeout = timeout

    def next_seq(self) -> int:
        """Return next globally unique sequence number via Redis INCR."""
        commands = []
        if self._password is not None:
            auth_args = (
                ["AUTH", self._username, self._password]
                if self._username is not None
                else ["AUTH", self._password]
            )
            commands.append(self._encode_command(auth_args))
        if self._database is not None:
            commands.append(self._encode_command(["SELECT", str(self._database)]))
        commands.append(self._encode_command(["INCR", self._key]))

        responses = self._send_commands(commands)
        for response in responses[:-1]:
            self._parse_status_response(response)
        return self._parse_integer_response(responses[-1])

    def _send_commands(self, commands: list[bytes]) -> list[bytes]:
        responses: list[bytes] = []
        with socket.create_connection(
            self._server, timeout=self._connect_timeout
        ) as sock:
            sock.settimeout(self._timeout)
            for command in commands:
                sock.sendall(command)
                responses.append(self._read_response(sock))
        return responses

    def _read_response(self, sock) -> bytes:
        chunks: list[bytes] = []
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            chunks.append(chunk)
            response = b"".join(chunks)
            if b"\r\n" in response:
                return response
        return b"".join(chunks)

    def _encode_command(self, args: list[str]) -> bytes:
        encoded_args = [arg.encode() for arg in args]
        parts = [f"*{len(encoded_args)}\r\n".encode()]
        for arg in encoded_args:
            parts.append(f"${len(arg)}\r\n".encode())
            parts.append(arg)
            parts.append(b"\r\n")
        return b"".join(parts)

    def _parse_integer_response(self, response: bytes) -> int:
        line = response.split(b"\r\n", 1)[0]
        if line.startswith(b":"):
            value = int(line[1:])
            if value <= 0:
                raise ValueError(f"Redis INCR returned non-positive value: {value}")
            return value
        if line.startswith(b"-"):
            raise ValueError(f"Redis error: {line[1:].decode()}")
        raise ValueError(f"Unexpected Redis response: {response!r}")

    def _parse_status_response(self, response: bytes) -> None:
        line = response.split(b"\r\n", 1)[0]
        if line.startswith(b"+"):
            return
        if line.startswith(b"-"):
            raise ValueError(f"Redis error: {line[1:].decode()}")
        raise ValueError(f"Unexpected Redis response: {response!r}")

    def close(self) -> None:
        return None
