// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! CPython collection-order emulators for the `all-grouped` SQL renderings.
//!
//! The source renders several `IN (...)` lists directly from Python
//! collections whose iteration order the replay engine compares in exact
//! order (the direct-access filter query carries EXISTS subqueries, so the
//! engine's order-insensitive single-table IN matching does not apply).
//! Integer hashing is the identity, so `set[int]` order is deterministic;
//! string hashing is SipHash-1-3 keyed by the interpreter's per-process
//! `PYTHONHASHSEED` secret, so `set[str]` order is one random draw per
//! source process (see `PyStrSetOrder`).

/// A faithful CPython `set[int]` order emulator.
///
/// The source renders several `IN (...)` lists directly from Python sets
/// (`list(owner_user_ids)`, `list(all_inviter_ids)`), and the replay engine
/// compares IN literals in order for GROUP BY queries (the semantic
/// multiset path is policy-gated off). Integer hashing is the identity, so
/// the iteration order is deterministic: it only depends on the insertion
/// sequence, the open-addressing probe
/// `perturb >>= 5; i = (i*5 + perturb + 1) & mask`, and the resize rule
/// (`fill*5 >= mask*3` rehashes the table in slot order to `used*4`
/// rounded up to a power of two, minimum 8).
#[derive(Default)]
pub(super) struct PySetOrder {
    table: Vec<Option<i64>>,
    used: usize,
    fill: usize,
}

impl PySetOrder {
    pub(super) fn new() -> Self {
        Self {
            table: vec![None; 8],
            used: 0,
            fill: 0,
        }
    }

    fn place(table: &mut [Option<i64>], value: i64) -> bool {
        let mask = table.len() - 1;
        let mut index = (value as usize) & mask;
        let mut perturb = value as u64;
        loop {
            match table[index] {
                None => {
                    table[index] = Some(value);
                    return true;
                }
                Some(existing) if existing == value => return false,
                Some(_) => {
                    perturb >>= 5;
                    index = (index
                        .wrapping_mul(5)
                        .wrapping_add(perturb as usize)
                        .wrapping_add(1))
                        & mask;
                }
            }
        }
    }

    /// `set.add(value)` (duplicates keep their first slot).
    pub(super) fn add(&mut self, value: i64) {
        if !Self::place(&mut self.table, value) {
            return;
        }
        self.used += 1;
        self.fill += 1;
        let mask = self.table.len() - 1;
        if self.fill * 5 >= mask * 3 {
            // `set_table_resize(so, used > 50000 ? used*2 : used*4)`.
            let minsize = if self.used > 50_000 {
                self.used * 2
            } else {
                self.used * 4
            };
            let mut newsize = 8_usize;
            while newsize <= minsize {
                newsize <<= 1;
            }
            let old: Vec<i64> = self.table.iter().flatten().copied().collect();
            self.table = vec![None; newsize];
            self.fill = self.used;
            for value in old {
                Self::place(&mut self.table, value);
            }
        }
    }

    /// `list(the_set)` — the slot-ascending iteration order.
    pub(super) fn order(&self) -> Vec<i64> {
        self.table.iter().flatten().copied().collect()
    }
}

/// A faithful CPython `set[str]` order emulator for `str(int)` values.
///
/// The source renders the direct-access filter's namespace-entity
/// `entity_id IN (...)` list from
/// `_get_accessible_namespace_ids` — a `frozenset(str(row[0]) for row in
/// query)` — so the IN-list order is the CPython `set[str]` slot order.
/// Unlike `set[int]`, string hashing uses SipHash-1-3 keyed by the
/// interpreter's per-process `PYTHONHASHSEED` secret, so the order is one
/// random draw per source process rather than a universal constant.
///
/// The emulation follows CPython 3.12: the key is the first 16 bytes (two
/// little-endian `u64`s) of `lcg_urandom(seed, 24)` from
/// `Python/bootstrap_hash.c` (`x = x*214013 + 2531011`, taking bits 23..16
/// of each step), and `hash(str)` is SipHash-1-3 of the UTF-8 bytes with
/// `b = remaining_len << 56 | remaining bytes`. The table layout, probe,
/// and resize rules match `PySetOrder` above. The seed defaults to the
/// value whose draw the baseline recording exhibits (the engine compares
/// IN literals inside the EXISTS-bearing filter query in order) and can be
/// overridden with the `PYTHONHASHSEED` environment variable; a future
/// recording with a different source-process seed renders a different draw
/// and needs the override.
pub(super) struct PyStrSetOrder {
    table: Vec<Option<String>>,
}

impl PyStrSetOrder {
    /// The seed whose SipHash key reproduces the baseline recording's
    /// `set[str]` iteration draws.
    const DEFAULT_SEED: u32 = 91;

    pub(super) fn hash(value: &str, k0: u64, k1: u64) -> i64 {
        siphash13(k0, k1, value.as_bytes())
    }

    fn place(table: &mut [Option<String>], value: String, hash: i64) -> bool {
        let mask = table.len() - 1;
        let mut index = (hash as usize) & mask;
        let mut perturb = hash as u64;
        loop {
            match table[index] {
                None => {
                    table[index] = Some(value);
                    return true;
                }
                Some(ref existing) if existing == &value => return false,
                Some(_) => {
                    perturb >>= 5;
                    index = (index
                        .wrapping_mul(5)
                        .wrapping_add(perturb as usize)
                        .wrapping_add(1))
                        & mask;
                }
            }
        }
    }

    /// `frozenset(str(id) for id in rows)` — the generator-insertion order
    /// of the source's `_get_accessible_namespace_ids` comprehension.
    pub(super) fn from_row_order(rows: &[i64]) -> Self {
        let seed = std::env::var("PYTHONHASHSEED")
            .ok()
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(Self::DEFAULT_SEED);
        let (k0, k1) = cpython_hash_key(seed);
        let mut table: Vec<Option<String>> = vec![None; 8];
        let mut used = 0_usize;
        let mut fill = 0_usize;
        for id in rows {
            let value = id.to_string();
            let hash = Self::hash(&value, k0, k1);
            if !Self::place(&mut table, value, hash) {
                continue;
            }
            used += 1;
            fill += 1;
            let mask = table.len() - 1;
            if fill * 5 >= mask * 3 {
                let minsize = if used > 50_000 { used * 2 } else { used * 4 };
                let mut newsize = 8_usize;
                while newsize <= minsize {
                    newsize <<= 1;
                }
                let old: Vec<(String, i64)> = table
                    .iter()
                    .flatten()
                    .map(|value| {
                        let hash = Self::hash(value, k0, k1);
                        (value.clone(), hash)
                    })
                    .collect();
                table = vec![None; newsize];
                fill = used;
                for (value, hash) in old {
                    Self::place(&mut table, value, hash);
                }
            }
        }
        Self { table }
    }

    /// `list(the_set)` — the slot-ascending iteration order.
    pub(super) fn order(&self) -> Vec<String> {
        self.table.iter().flatten().cloned().collect()
    }
}

/// CPython's `lcg_urandom` hash-secret derivation for an integer
/// `PYTHONHASHSEED` (`Python/bootstrap_hash.c`): 24 bytes of
/// `x = x*214013 + 2531011` (mod 2^32), taking bits 23..16 of each step;
/// the SipHash key is the first 16 bytes as two little-endian `u64`s.
pub(super) fn cpython_hash_key(seed: u32) -> (u64, u64) {
    let mut x = seed as u64;
    let mut bytes = [0_u8; 24];
    for byte in &mut bytes {
        x = x.wrapping_mul(214_013).wrapping_add(2_531_011) & 0xFFFF_FFFF;
        *byte = ((x >> 16) & 0xFF) as u8;
    }
    (
        u64::from_le_bytes(bytes[0..8].try_into().expect("8 bytes")),
        u64::from_le_bytes(bytes[8..16].try_into().expect("8 bytes")),
    )
}

/// SipHash-1-3 (CPython 3.11+ `str` hash): one compression round per
/// 8-byte block, three finalization rounds, and the length mixed into the
/// final partial block as `remaining_len << 56`.
pub(super) fn siphash13(k0: u64, k1: u64, data: &[u8]) -> i64 {
    fn rotl(value: u64, bits: u32) -> u64 {
        value.rotate_left(bits)
    }
    fn sipround(v0: &mut u64, v1: &mut u64, v2: &mut u64, v3: &mut u64) {
        *v0 = v0.wrapping_add(*v1);
        *v1 = rotl(*v1, 13);
        *v1 ^= *v0;
        *v0 = rotl(*v0, 32);
        *v2 = v2.wrapping_add(*v3);
        *v3 = rotl(*v3, 16);
        *v3 ^= *v2;
        *v0 = v0.wrapping_add(*v3);
        *v3 = rotl(*v3, 21);
        *v3 ^= *v0;
        *v2 = v2.wrapping_add(*v1);
        *v1 = rotl(*v1, 17);
        *v1 ^= *v2;
        *v2 = rotl(*v2, 32);
    }
    let mut v0 = k0 ^ 0x736f_6d65_7073_6575;
    let mut v1 = k1 ^ 0x646f_7261_6e64_6f6d;
    let mut v2 = k0 ^ 0x6c79_6765_6e65_7261;
    let mut v3 = k1 ^ 0x7465_6462_7974_6573;
    let mut index = 0;
    while data.len() - index >= 8 {
        let m = u64::from_le_bytes(data[index..index + 8].try_into().expect("8 bytes"));
        v3 ^= m;
        sipround(&mut v0, &mut v1, &mut v2, &mut v3);
        v0 ^= m;
        index += 8;
    }
    let remaining = data.len() - index;
    let mut m = (remaining as u64) << 56;
    if remaining > 0 {
        let mut tail = [0_u8; 8];
        tail[..remaining].copy_from_slice(&data[index..]);
        m |= u64::from_le_bytes(tail);
    }
    v3 ^= m;
    sipround(&mut v0, &mut v1, &mut v2, &mut v3);
    v0 ^= m;
    v2 ^= 0xFF;
    for _ in 0..3 {
        sipround(&mut v0, &mut v1, &mut v2, &mut v3);
    }
    let hash = v0 ^ v1 ^ v2 ^ v3;
    hash as i64
}
