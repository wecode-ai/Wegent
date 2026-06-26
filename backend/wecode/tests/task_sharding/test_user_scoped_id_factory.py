import pytest

from wecode.task_sharding.uuid_factory.redis_id_factory import RedisIdFactory
from wecode.task_sharding.uuid_factory.user_scoped_id_factory import (
    MAX_JS_SAFE_INTEGER,
    MAX_SEQ,
    UID_MASK,
    UserScopedIdFactory,
    decode_user_scoped_id,
    encode_user_scoped_id,
    uid_from_id,
)

pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------
# encode / decode
# ---------------------------------------------------------------------------


def test_encode_decode_roundtrip():
    for uid, seq in [
        (0, 1),
        (3, 1),
        (6000, 1),
        (60000, 100_000_000),
        (UID_MASK, MAX_SEQ),
    ]:
        encoded = encode_user_scoped_id(uid, seq)
        decoded_uid, decoded_reserved, decoded_seq = decode_user_scoped_id(encoded)
        assert decoded_uid == uid
        assert decoded_reserved == 0
        assert decoded_seq == seq


def test_max_value_fits_js_max_safe_integer():
    encoded = encode_user_scoped_id(UID_MASK, MAX_SEQ)
    assert encoded <= MAX_JS_SAFE_INTEGER


def test_uid_3_seq_1():
    encoded = encode_user_scoped_id(3, 1)
    assert encoded == 412_316_860_417
    assert uid_from_id(encoded) == 3


def test_uid_6000_seq_1():
    encoded = encode_user_scoped_id(6000, 1)
    assert encoded == 824_633_720_832_001
    assert uid_from_id(encoded) == 6000


def test_uid_60000_seq_100_million():
    encoded = encode_user_scoped_id(60000, 100_000_000)
    assert encoded == 8_246_337_308_320_000
    assert encoded <= MAX_JS_SAFE_INTEGER


def test_encode_rejects_uid_out_of_range():
    with pytest.raises(ValueError, match="uid"):
        encode_user_scoped_id(UID_MASK + 1, 1)


def test_encode_rejects_seq_out_of_range():
    with pytest.raises(ValueError, match="seq"):
        encode_user_scoped_id(1, MAX_SEQ + 1)


# ---------------------------------------------------------------------------
# UserScopedIdFactory
# ---------------------------------------------------------------------------


class FakeSeqSource:
    def __init__(self, values: list[int]):
        self._values = list(values)
        self.user_ids: list[int] = []
        self.closed = False

    def next_seq(self, user_id: int) -> int:
        self.user_ids.append(user_id)
        return self._values.pop(0)

    def close(self) -> None:
        self.closed = True


def test_user_scoped_factory_encodes_uid_and_seq():
    factory = UserScopedIdFactory(FakeSeqSource([1, 2]))
    id1 = factory.next_id(user_id=3)
    id2 = factory.next_id(user_id=3)
    uid1, _, seq1 = decode_user_scoped_id(id1)
    uid2, _, seq2 = decode_user_scoped_id(id2)
    assert uid1 == 3
    assert uid2 == 3
    assert seq1 == 1
    assert seq2 == 2


def test_user_scoped_factory_passes_full_uid_to_sequence_source():
    factory = UserScopedIdFactory(FakeSeqSource([1]))
    encoded = factory.next_id(user_id=1024)
    uid, _, _ = decode_user_scoped_id(encoded)
    assert uid == 1024
    assert factory._seq_source.user_ids == [1024]


def test_user_scoped_factory_rejects_uid_out_of_range():
    factory = UserScopedIdFactory(FakeSeqSource([1]))
    with pytest.raises(ValueError, match="user_id"):
        factory.next_id(user_id=UID_MASK + 1)


def test_user_scoped_factory_close_delegates():
    source = FakeSeqSource([1])
    factory = UserScopedIdFactory(source)
    factory.close()
    assert source.closed is True


# ---------------------------------------------------------------------------
# RedisIdFactory (unit — fake socket)
# ---------------------------------------------------------------------------


class FakeSocket:
    def __init__(self, response: bytes | list[bytes]):
        self.responses = response if isinstance(response, list) else [response]
        self.sent: list[bytes] = []
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
        if not self.responses:
            return b""
        return self.responses.pop(0)


def make_redis_factory(sock: FakeSocket, monkeypatch) -> RedisIdFactory:
    def fake_create_connection(server, timeout):
        assert server == ("redis.example", 6379)
        return sock

    monkeypatch.setattr(
        "wecode.task_sharding.uuid_factory.redis_id_factory.socket.create_connection",
        fake_create_connection,
    )
    return RedisIdFactory("redis://redis.example:6379", key="task_global_seq")


def test_redis_factory_parses_incr_response(monkeypatch):
    sock = FakeSocket(b":42\r\n")
    factory = make_redis_factory(sock, monkeypatch)
    assert factory.next_seq() == 42
    assert sock.sent == [b"*2\r\n$4\r\nINCR\r\n$15\r\ntask_global_seq\r\n"]


def test_redis_factory_uses_user_scoped_key_initialized_from_150000(monkeypatch):
    sock = FakeSocket(b":150001\r\n")
    factory = make_redis_factory(sock, monkeypatch)

    assert factory.next_seq(1024) == 150001
    assert len(sock.sent) == 1
    assert b"$4\r\nEVAL\r\n" in sock.sent[0]
    assert b"task_global_seq_1024" in sock.sent[0]
    assert b"150000" in sock.sent[0]


def test_redis_factory_accepts_existing_user_scoped_key(monkeypatch):
    sock = FakeSocket(b":150002\r\n")
    factory = make_redis_factory(sock, monkeypatch)

    assert factory.next_seq(1024) == 150002
    assert len(sock.sent) == 1


def test_redis_factory_supports_password_url_and_database(monkeypatch):
    sock = FakeSocket([b"+OK\r\n", b"+OK\r\n", b":42\r\n"])

    def fake_create_connection(server, timeout):
        assert server == ("redis.example", 6380)
        return sock

    monkeypatch.setattr(
        "wecode.task_sharding.uuid_factory.redis_id_factory.socket.create_connection",
        fake_create_connection,
    )

    factory = RedisIdFactory(
        "redis://:s3cr3t@redis.example:6380/2",
        key="task_global_seq",
    )

    assert factory.next_seq() == 42
    assert sock.sent == [
        b"*2\r\n$4\r\nAUTH\r\n$6\r\ns3cr3t\r\n",
        b"*2\r\n$6\r\nSELECT\r\n$1\r\n2\r\n",
        b"*2\r\n$4\r\nINCR\r\n$15\r\ntask_global_seq\r\n",
    ]


def test_redis_factory_rejects_error_response(monkeypatch):
    sock = FakeSocket(b"-ERR unknown command\r\n")
    factory = make_redis_factory(sock, monkeypatch)
    with pytest.raises(ValueError, match="Redis error"):
        factory.next_seq()


def test_redis_factory_rejects_unexpected_response(monkeypatch):
    sock = FakeSocket(b"+OK\r\n")
    factory = make_redis_factory(sock, monkeypatch)
    with pytest.raises(ValueError, match="Unexpected"):
        factory.next_seq()
