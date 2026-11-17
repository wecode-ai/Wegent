// SPDX-License-Identifier: Apache-2.0
//! Use the existing TLS crypto implementation for large plugin payloads, including Debug builds.

pub(crate) struct PackageDigest(ring::digest::Context);

impl PackageDigest {
    pub(crate) fn new() -> Self {
        Self(ring::digest::Context::new(&ring::digest::SHA256))
    }

    pub(crate) fn update(&mut self, bytes: impl AsRef<[u8]>) {
        self.0.update(bytes.as_ref());
    }

    pub(crate) fn finish(self) -> String {
        let digest = self.0.finish();
        let mut value = String::with_capacity(71);
        value.push_str("sha256:");
        for byte in digest.as_ref() {
            use std::fmt::Write;
            write!(value, "{byte:02x}").expect("Writing a digest to a String cannot fail");
        }
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn streaming_hashes_preserve_existing_sha256_values_and_chunk_boundaries() {
        for size in [0, 1, 63, 64, 65, 8192, 8193, 1024 * 1024] {
            let bytes: Vec<u8> = (0..size).map(|index| (index % 251) as u8).collect();
            let expected = format!("sha256:{:x}", Sha256::digest(&bytes));
            for chunk_size in [1, 8192, 65536] {
                let mut actual = PackageDigest::new();
                for chunk in bytes.chunks(chunk_size) {
                    actual.update(chunk);
                }
                assert_eq!(actual.finish(), expected);
            }
        }
    }
}
