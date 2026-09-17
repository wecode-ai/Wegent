// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! CPython `set[int]` iteration-order emulation for the installed-Skill filter.
//!
//! `skill_binding_service.list_user_default_skill_ids` returns a `set[int]`,
//! and `ResourceLibraryService.list_public` renders it straight into
//! `Kind.id.notin_(...)`. The discovery statements select the computed
//! `$.spec.capability.marketplace.recommendationScore` projection, so Replay's
//! parsed-predicate equivalence (which compares `IN`/`NOT IN` lists without
//! regard to value order) cannot read them and the recorded statement is
//! matched token for token. The set's iteration order is therefore observable
//! in the dependency stream and must be reproduced exactly.
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
pub(super) struct SetOrder {
    table: Vec<Option<i64>>,
    used: usize,
    fill: usize,
}

impl SetOrder {
    pub(super) fn new() -> Self {
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
    pub(super) fn add(&mut self, value: i64) {
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
    pub(super) fn order(&self) -> Vec<i64> {
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

    #[test]
    fn duplicates_keep_the_first_slot_and_order_stays_slot_ascending() {
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
