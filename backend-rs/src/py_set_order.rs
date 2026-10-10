// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! CPython `set[int]` iteration-order emulation.
//!
//! Several migrated APIs render a Python `set[int]` straight into a
//! dependency sequence — one cache read per element, a MySQL
//! `IN (...)`/`NOT IN (...)` list, or a recorded statement's token order — so
//! the set's iteration order is observable in the dependency stream and has
//! to be reproduced exactly for Replay to match it.
//!
//! Integer hashing is the identity, so the layout is deterministic. A probe
//! starts at `hash & mask`, scans the next [`LINEAR_PROBES`] slots linearly
//! when they all fit in the table, and otherwise jumps with
//! `perturb >>= 5; index = (index*5 + perturb + 1) & mask`. The table resizes
//! when `fill*5 >= mask*3`, to `used*4` entries (`used*2` above 50 000)
//! rounded up to a power of two, minimum 8, rehashing the old entries in slot
//! order.

/// `LINEAR_PROBES` from CPython's `Objects/setobject.c`.
const LINEAR_PROBES: usize = 9;

/// `PySet_MINSIZE` from CPython's `Objects/setobject.c`.
const MIN_SIZE: usize = 8;

/// `PERTURB_SHIFT` from CPython's `Objects/setobject.c`.
const PERTURB_SHIFT: u32 = 5;

/// A CPython `set[int]` order emulator.
#[derive(Default)]
pub(crate) struct SetOrder {
    table: Vec<Option<i64>>,
    used: usize,
    fill: usize,
}

impl SetOrder {
    pub(crate) fn new() -> Self {
        Self {
            table: vec![None; MIN_SIZE],
            used: 0,
            fill: 0,
        }
    }

    /// The perturb jump taken after a full linear group.
    fn jump(index: usize, perturb: &mut u64, mask: usize) -> usize {
        *perturb >>= PERTURB_SHIFT;
        index
            .wrapping_mul(5)
            .wrapping_add(*perturb as usize)
            .wrapping_add(1)
            & mask
    }

    /// The slot `value` occupies in `table`, or `None` when it is already
    /// present.
    fn find(table: &[Option<i64>], value: i64) -> Option<usize> {
        let mask = table.len() - 1;
        let mut index = (value as usize) & mask;
        let mut perturb = value as u64;
        loop {
            match table[index] {
                None => return Some(index),
                Some(existing) if existing == value => return None,
                Some(_) => {}
            }
            if index + LINEAR_PROBES <= mask {
                for offset in 1..=LINEAR_PROBES {
                    match table[index + offset] {
                        None => return Some(index + offset),
                        Some(existing) if existing == value => return None,
                        Some(_) => {}
                    }
                }
            }
            index = Self::jump(index, &mut perturb, mask);
        }
    }

    /// `set.add(value)`; duplicates keep their first slot.
    pub(crate) fn add(&mut self, value: i64) {
        let Some(index) = Self::find(&self.table, value) else {
            return;
        };
        self.table[index] = Some(value);
        self.used += 1;
        self.fill += 1;
        let mask = self.table.len() - 1;
        if self.fill * 5 < mask * 3 {
            return;
        }
        // `set_table_resize(so, used > 50000 ? used*2 : used*4)`.
        let min_size = if self.used > 50_000 {
            self.used * 2
        } else {
            self.used * 4
        };
        let mut new_size = MIN_SIZE;
        while new_size <= min_size {
            new_size <<= 1;
        }
        let old: Vec<i64> = self.table.iter().flatten().copied().collect();
        self.table = vec![None; new_size];
        self.fill = self.used;
        for value in old {
            if let Some(index) = Self::find(&self.table, value) {
                self.table[index] = Some(value);
            }
        }
    }

    /// `list(the_set)` — the slot-ascending iteration order.
    pub(crate) fn order(&self) -> Vec<i64> {
        self.table.iter().flatten().copied().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Case ba098165: the SkillBinding probe returns the user's bindings in
    /// `created_at DESC` order, the source adds each `skillRef.skillId` to a
    /// `set[int]`, and the recorded discovery statement's `NOT IN` list is
    /// that set's iteration order.
    #[test]
    fn installed_skill_ids_render_the_recorded_set_order() {
        let mut ids = SetOrder::new();
        for id in [
            283_712, 200_318, 269_285, 127_443, 237_510, 214_204, 187_623, 188_646, 187_624,
            110_603, 133_755, 133_269, 127_449, 273_990, 266_010, 127_444, 256_262,
        ] {
            ids.add(id);
        }
        assert_eq!(
            ids.order(),
            vec![
                283_712, 269_285, 237_510, 187_623, 188_646, 187_624, 273_990, 110_603, 256_262,
                127_443, 127_444, 133_269, 127_449, 266_010, 133_755, 214_204, 200_318,
            ]
        );
    }

    /// Case 33bcf50b (task 567348000083401): the subtask rows in message
    /// order carry bot ids [110593, 110593, ..., 110592, ...], so the set is
    /// built by inserting 110593 first. CPython's iteration order renders
    /// [110592, 110593] — exactly the recorded cache GET sequence
    /// (`kind:v2:data:Bot:110592` then `kind:v2:data:Bot:110593`), which the
    /// insertion order would have reversed.
    #[test]
    fn bot_id_set_order_matches_the_recorded_read_sequence() {
        let mut set = SetOrder::new();
        set.add(110_593);
        set.add(110_592);
        assert_eq!(set.order(), vec![110_592, 110_593]);
    }

    /// Case 9fa3d863 (task 426335633820473): both subtask rows carry the
    /// group team's fourteen bot ids in ascending order, so the set is built
    /// in that order and resizes 8 -> 32 at the fifth insert. The ids
    /// 256308 and 264052 collide (`% 32 == 20`); CPython's linear run
    /// places 264052 at the next free slot, so the iteration order renders
    /// it tenth — the recorded read order
    /// (`kind:v2:data:Bot:…, 256341, 264052, 256311, …`). A perturb-only
    /// probe moves it to slot 0 instead, which reorders the cache reads and
    /// their MySQL fallback parameters against the recorded lane.
    #[test]
    fn bot_id_set_order_follows_the_recorded_collision_order() {
        let mut set = SetOrder::new();
        let ids = [
            256_308, 256_311, 256_314, 256_317, 256_320, 256_323, 256_326, 256_329, 256_332,
            256_335, 256_338, 256_341, 256_344, 264_052,
        ];
        for _ in 0..2 {
            for id in ids {
                set.add(id);
            }
        }
        assert_eq!(
            set.order(),
            vec![
                256_320, 256_323, 256_326, 256_329, 256_332, 256_335, 256_338, 256_308, 256_341,
                264_052, 256_311, 256_344, 256_314, 256_317,
            ]
        );
    }

    #[test]
    fn duplicates_keep_the_first_slot_and_order_stays_slot_ascending() {
        // The recorded single-bot case: six duplicate inserts of one id keep
        // a single slot.
        let mut single = SetOrder::new();
        for _ in 0..6 {
            single.add(259_750);
        }
        assert_eq!(single.order(), vec![259_750]);

        let mut ids = SetOrder::new();
        for _ in 0..6 {
            ids.add(259_750);
        }
        ids.add(259_749);
        assert_eq!(ids.order(), vec![259_749, 259_750]);
    }

    #[test]
    fn resized_tables_rehash_in_slot_order() {
        // Nine ids cross the 8-slot resize (`fill*5 >= mask*3`) to 32 slots.
        let mut ids = SetOrder::new();
        for id in 1..=9 {
            ids.add(id);
        }
        assert_eq!(ids.order(), (1..=9).collect::<Vec<i64>>());
    }
}
