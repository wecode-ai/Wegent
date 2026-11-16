use super::*;

#[test]
fn package_hashing_keeps_chunk_buffers_off_the_worker_stack() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("package.zip");
    let bytes: Vec<u8> = (0..2 * 1024 * 1024 + 17)
        .map(|index| (index % 251) as u8)
        .collect();
    let expected = format!("{:x}", Sha256::digest(&bytes));
    fs::write(&path, bytes).unwrap();
    // Hashing runs beneath the RPC dispatcher; it cannot reserve another MiB
    // on the worker stack. Include complete chunks and a final partial chunk.
    let actual = std::thread::Builder::new()
        .name("plugin-package-hash".into())
        .stack_size(128 * 1024)
        .spawn(move || sha256_file(&path).unwrap())
        .unwrap()
        .join()
        .unwrap();
    assert_eq!(actual, expected);
}
