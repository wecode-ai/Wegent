import pytest

from wecode.task_sharding.uuid_factory import (
    IdCreateException,
    UuidFactory,
)
from wecode.task_sharding.uuid_factory import __all__ as uuid_factory_exports

pytestmark = pytest.mark.unit


class FakeSocket:
    def __init__(self, response: bytes):
        self.response = response
        self.sent = []
        self.timeout = None
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.closed = True

    def settimeout(self, timeout):
        self.timeout = timeout

    def sendall(self, data):
        self.sent.append(data)

    def recv(self, size):
        response = self.response
        self.response = b""
        return response


class FakeRandom:
    def randint(self, start, end):
        assert start == -(2**31)
        assert end == 2**31 - 1
        return 12345678


def make_factory(sock: FakeSocket, monkeypatch) -> UuidFactory:
    def fake_create_connection(server, timeout):
        assert server == ("uuid.example", 6066)
        assert timeout == 1.0
        return sock

    monkeypatch.setattr(
        "wecode.task_sharding.uuid_factory.uuid_factory.socket.create_connection",
        fake_create_connection,
    )
    factory = UuidFactory.__new__(UuidFactory)
    factory._server = ("uuid.example", 6066)
    factory._key_prefix = b"0_uuid"
    factory._connect_timeout = 1.0
    factory._timeout = 1.0
    factory._random_generator = FakeRandom()
    return factory


def test_uuid_factory_only_exports_uuid_api():
    assert "UuidFactory" in uuid_factory_exports
    assert "IdCreateException" in uuid_factory_exports


def test_uuid_factory_gets_uuid_from_memcache_text_protocol(monkeypatch):
    sock = FakeSocket(b"VALUE uuid 0 16\r\n5310397443737584\r\nEND\r\n")
    factory = make_factory(sock, monkeypatch)

    uuid_id = factory.next_id()

    assert uuid_id == 5310397443737584
    assert sock.sent == [b"get 0_uuid12345678\r\n"]
    assert sock.closed is True


def test_uuid_factory_requires_memcache_value(monkeypatch):
    sock = FakeSocket(b"END\r\n")
    factory = make_factory(sock, monkeypatch)

    with pytest.raises(IdCreateException, match="memcache uuid key not found"):
        factory.next_id()


def test_uuid_factory_rejects_invalid_memcache_uuid(monkeypatch):
    sock = FakeSocket(b"VALUE uuid 0 1\r\n0\r\nEND\r\n")
    factory = make_factory(sock, monkeypatch)

    with pytest.raises(IdCreateException, match="invalid uuid"):
        factory.next_id()
