// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! CPython `set[int]` iteration-order emulation for the subtask bot ids.
//!
//! Source `queries.get_task_detail` collects the ids with
//! `all_bot_ids = set()` + `all_bot_ids.update(subtask.bot_ids)` and
//! `task_detail_helpers.get_bots_for_subtasks` passes `list(all_bot_ids)`
//! to `kindReader.get_by_ids`, so the cache-read sequence (and the MySQL
//! `IN (...)` parameter order on a miss) follows CPython's set iteration
//! order instead of the subtask insertion order.

/// A faithful CPython `set[int]` order emulator.
///
/// Integer hashing is the identity, so the iteration order is
/// deterministic: it only depends on the insertion sequence, the
/// open-addressing probe `perturb >>= 5; i = (i*5 + perturb + 1) & mask`,
/// and the resize rule (`fill*5 >= mask*3` rehashes the table in slot
/// order to `used*4` rounded up to a power of two, minimum 8).
#[derive(Default)]
pub(crate) struct PySetOrder {
    table: Vec<Option<i64>>,
    used: usize,
    fill: usize,
}

impl PySetOrder {
    pub(crate) fn new() -> Self {
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
    pub(crate) fn add(&mut self, value: i64) {
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
    pub(crate) fn order(&self) -> Vec<i64> {
        self.table.iter().flatten().copied().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bot_id_set_order_matches_the_recorded_read_sequence() {
        // Case 33bcf50b (task 567348000083401): the subtask rows in
        // message order carry bot ids [110593, 110593, ..., 110592, ...],
        // so the set is built by inserting 110593 first. CPython's
        // iteration order renders [110592, 110593] — exactly the recorded
        // cache GET sequence (data:Bot:110592 at sequence 754, then
        // data:Bot:110593 at 755), which the insertion order would have
        // reversed.
        let mut set = PySetOrder::new();
        set.add(110_593);
        set.add(110_592);
        assert_eq!(set.order(), vec![110_592, 110_593]);
    }

    #[test]
    fn bot_id_set_order_single_and_duplicate_ids() {
        // Passing cases (e.g. 3bc985da) carry one bot id (259750); the
        // duplicate inserts from every subtask row keep a single slot.
        let mut set = PySetOrder::new();
        for _ in 0..6 {
            set.add(259_750);
        }
        assert_eq!(set.order(), vec![259_750]);
    }

    #[test]
    fn resized_tables_keep_slot_order() {
        // Nine ids force one resize (8 -> 32 slots); iteration stays
        // slot-ascending like CPython.
        let mut set = PySetOrder::new();
        for id in 1..=9 {
            set.add(id);
        }
        assert_eq!(set.order(), vec![1, 2, 3, 4, 5, 6, 7, 8, 9]);
    }
}
