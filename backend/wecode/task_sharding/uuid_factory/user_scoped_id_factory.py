from __future__ import annotations

UID_BITS = 16
RESERVED_BITS = 4
SEQ_BITS = 33

UID_SHIFT = RESERVED_BITS + SEQ_BITS  # 37
RESERVED_SHIFT = SEQ_BITS  # 33

UID_MASK = (1 << UID_BITS) - 1  # 0xFFFF
SEQ_MASK = (1 << SEQ_BITS) - 1  # 0x1FFFFFFFF
MAX_SEQ = SEQ_MASK  # 8_589_934_591
MAX_JS_SAFE_INTEGER = (1 << 53) - 1  # 9_007_199_254_740_991


class UserScopedIdFactory:
    """Encodes a globally unique ID using user uid + reserved + seq.

    Bit layout (53 bits total, fits JS Number.MAX_SAFE_INTEGER):

        bit 52 .. 37   bit 36 .. 33   bit 32 .. 0
        [ 16 uid    ]  [ 4 rsvd   ]   [  33 seq  ]

    uid      = user_id, constrained to 16 bits
    reserved = 0 (reserved for future use)
    seq      = globally incrementing counter from an external source
    """

    def __init__(self, seq_source) -> None:
        """
        seq_source: any object with a next_seq() -> int method
                    (e.g. RedisIdFactory)
        """
        self._seq_source = seq_source

    def next_id(self, user_id: int) -> int:
        if not isinstance(user_id, int) or isinstance(user_id, bool):
            raise ValueError("user_id must be an integer")
        if user_id < 0 or user_id > UID_MASK:
            raise ValueError(f"user_id must be 0–{UID_MASK}, got {user_id}")
        seq = self._seq_source.next_seq(user_id)
        if seq <= 0 or seq > MAX_SEQ:
            raise ValueError(f"seq out of range: {seq}")
        return encode_user_scoped_id(user_id, seq)

    def close(self) -> None:
        close = getattr(self._seq_source, "close", None)
        if close is not None:
            close()


def encode_user_scoped_id(uid: int, seq: int, reserved: int = 0) -> int:
    """Encode uid + reserved + seq into a single 53-bit integer."""
    if uid < 0 or uid > UID_MASK:
        raise ValueError(f"uid must be 0–{UID_MASK}, got {uid}")
    if seq < 0 or seq > MAX_SEQ:
        raise ValueError(f"seq must be 0–{MAX_SEQ}, got {seq}")
    encoded = (uid << UID_SHIFT) | (reserved << RESERVED_SHIFT) | seq
    if encoded > MAX_JS_SAFE_INTEGER:
        raise ValueError(f"encoded id exceeds MAX_SAFE_INTEGER: {encoded}")
    return encoded


def decode_user_scoped_id(encoded_id: int) -> tuple[int, int, int]:
    """Decode encoded_id into (uid, reserved, seq)."""
    if not isinstance(encoded_id, int) or isinstance(encoded_id, bool):
        raise ValueError("encoded_id must be an integer")
    seq = encoded_id & SEQ_MASK
    reserved = (encoded_id >> RESERVED_SHIFT) & 0xF
    uid = (encoded_id >> UID_SHIFT) & UID_MASK
    return uid, reserved, seq


def uid_from_id(encoded_id: int) -> int:
    """Extract the uid field from an encoded id."""
    return (encoded_id >> UID_SHIFT) & UID_MASK
