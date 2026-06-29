from __future__ import annotations

import socket
from urllib.parse import unquote, urlparse

USER_SCOPED_SEQUENCE_SCRIPT = (
    "redis.call('SETNX', KEYS[1], ARGV[1]); " "return redis.call('INCR', KEYS[1])"
)


class RedisIdFactory:
    """Sequence counter backed by Redis INCR.

    When user_id is provided, each user gets an independent Redis key.
    """

    def __init__(
        self,
        server: str | tuple[str, int],
        key: str = "task_global_seq",
        initial_sequence: int = 150_000,
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
        if initial_sequence < 0:
            raise ValueError("initial_sequence must not be negative")
        self._key = key
        self._initial_sequence = initial_sequence
        self._connect_timeout = connect_timeout
        self._timeout = timeout

    def next_seq(self, user_id: int | None = None) -> int:
        """Return next sequence number via Redis INCR."""
        key = self._key_for_user(user_id)
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
        if user_id is not None:
            commands.append(
                self._encode_command(
                    [
                        "EVAL",
                        USER_SCOPED_SEQUENCE_SCRIPT,
                        "1",
                        key,
                        str(self._initial_sequence),
                    ]
                )
            )
        else:
            commands.append(self._encode_command(["INCR", key]))

        responses = self._send_commands(commands)
        setup_response_count = len(responses) - 1
        for response in responses[:setup_response_count]:
            self._parse_status_response(response)
        return self._parse_integer_response(responses[-1])

    def _key_for_user(self, user_id: int | None) -> str:
        if user_id is None:
            return self._key
        if not isinstance(user_id, int) or isinstance(user_id, bool):
            raise ValueError("user_id must be an integer")
        return f"{self._key}_{user_id}"

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
