//! Cumulative decoded bytes, font maps, code points and text shared by one PDF read.
use std::{cell::Cell, io::Read};

pub(super) struct DecodeBudget {
    remaining: Cell<usize>,
    failed: Cell<bool>,
    control: crate::ParseControl,
}

impl DecodeBudget {
    #[cfg(test)]
    pub(super) fn new(limit: usize) -> Self {
        Self::controlled(limit, crate::ParseControl::default())
    }

    pub(super) fn controlled(limit: usize, control: crate::ParseControl) -> Self {
        Self {
            remaining: Cell::new(limit),
            failed: Cell::new(false),
            control,
        }
    }

    pub(super) fn consume(&self, bytes: usize) -> Result<(), String> {
        if let Err(error) = self.control.check() {
            self.failed.set(true);
            return Err(error);
        }
        if self.failed.get() {
            return Err("PDF decoded-byte budget exceeded".into());
        }
        let Some(remaining) = self.remaining.get().checked_sub(bytes) else {
            self.failed.set(true);
            return Err("PDF decoded-byte budget exceeded".into());
        };
        self.remaining.set(remaining);
        Ok(())
    }

    pub(super) fn failed(&self) -> bool {
        self.failed.get()
    }

    pub(super) fn read(&self, mut reader: impl Read) -> Result<Vec<u8>, String> {
        self.consume(0)?;
        let mut output = Vec::new();
        let mut buffer = [0; 8192];
        loop {
            self.consume(0)?;
            let size = buffer.len().min(self.remaining.get().saturating_add(1));
            let count = reader
                .read(&mut buffer[..size])
                .map_err(|error| error.to_string())?;
            if count == 0 {
                return Ok(output);
            }
            self.consume(count)?;
            output.extend_from_slice(&buffer[..count]);
        }
    }
}
