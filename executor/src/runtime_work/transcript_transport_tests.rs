use super::*;
use flate2::read::GzDecoder;

fn restore(mut packet: Value, directory: &Path) -> Value {
    let mut bytes = Vec::new();
    loop {
        assert!(serde_json::to_vec(&packet).unwrap().len() < 512 * 1024);
        let transfer = &packet["transfer"];
        assert_eq!(transfer["offset"], bytes.len());
        bytes.extend(
            STANDARD
                .decode(transfer["payload"].as_str().unwrap())
                .unwrap(),
        );
        let Some(offset) = transfer["nextOffset"].as_u64() else {
            break;
        };
        packet = read_chunk(
            directory,
            &json!({"snapshotId": transfer["snapshotId"], "offset": offset}),
        )
        .unwrap();
    }
    let mut packed: Value = serde_json::from_reader(GzDecoder::new(bytes.as_slice())).unwrap();
    let references = packed["references"].as_array().unwrap().clone();
    let strings = packed["strings"].as_array().unwrap().clone();
    for reference in references {
        let mut current = &mut packed["transcript"];
        for key in reference["path"].as_array().unwrap() {
            current = match key {
                Value::String(key) => &mut current[key],
                _ => &mut current[key.as_u64().unwrap() as usize],
            };
        }
        assert!(current.is_null());
        *current = strings[reference["index"].as_u64().unwrap() as usize].clone();
    }
    packed["transcript"].take()
}

fn large_transcript() -> Value {
    // Deterministic high-entropy text does not disappear under gzip, unlike a
    // repeated-character fixture. Include multibyte text across chunk boundaries.
    let text: String = (0..28_000)
        .map(|i| format!("{:x}中文🙂\n", Sha256::digest(i.to_string().as_bytes())))
        .collect();
    json!({
        "success": true, "messages": [{"content": text, "blocks": [{"tool_output": {"content": text}}]}],
        "turns": [{"id": "turn-1", "items": [{"type": "assistant_text", "content": text}]}],
        "beforeCursor": "opaque-provider-cursor", "hasMoreBefore": true,
        "fullContent": false, "running": true,
    })
}

#[test]
fn old_requests_keep_the_old_contract_and_unknown_versions_fail() {
    assert!(!requested(&json!({})).unwrap());
    assert!(!requested(&json!({"transcriptProtocolVersion":1})).unwrap());
    assert!(requested(&json!({"transcriptProtocolVersion":2})).unwrap());
    assert!(requested(&json!({"transcriptProtocolVersion":3})).is_err());
    assert!(requested(&json!({"transcriptProtocolVersion":"2"})).is_err());
}

#[test]
fn large_transcripts_publish_and_restore_beyond_windows_max_path() {
    let root = tempfile::tempdir().unwrap();
    let mut directory = root.path().to_path_buf();
    while directory.to_string_lossy().len() <= 260 {
        directory.push("long-transcript-directory");
    }
    let source = large_transcript();
    let packet = encode(&directory, source.clone()).unwrap();
    assert!(packet["transfer"]["nextOffset"].is_number());
    assert_eq!(restore(packet, &directory), source);
}

#[test]
fn large_utf8_and_structured_outputs_round_trip_in_bounded_chunks() {
    let root = tempfile::tempdir().unwrap();
    let source = large_transcript();
    let first = encode(root.path(), source.clone()).unwrap();
    assert!(first["transfer"]["nextOffset"].is_number());
    // The reader has no in-memory state: a fresh process can finish this snapshot.
    assert_eq!(restore(first, root.path()), source);
}

#[test]
fn publishing_an_existing_snapshot_preserves_the_file_and_active_readers() {
    let root = tempfile::tempdir().unwrap();
    let source = large_transcript();
    let first = encode(root.path(), source.clone()).unwrap();
    let id = first["transfer"]["snapshotId"].as_str().unwrap();
    let path = root.path().join(format!("{id}.gz"));
    File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(SystemTime::now() - Duration::from_secs(60))
        .unwrap();
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    let mut options = File::options();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // A live reader may deny replacement while allowing other readers.
        options.share_mode(1);
    }
    let _reader = options.open(&path).unwrap();

    let repeated = encode(root.path(), source.clone()).unwrap();

    assert_eq!(repeated, first);
    assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
    assert_eq!(restore(repeated, root.path()), source);
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
}

#[test]
fn concurrent_identical_snapshots_publish_once_and_restore_completely() {
    let root = tempfile::tempdir().unwrap();
    let source = large_transcript();
    let barrier = std::sync::Barrier::new(4);
    std::thread::scope(|scope| {
        let handles = (0..4)
            .map(|_| {
                scope.spawn(|| {
                    barrier.wait();
                    let packet = encode(root.path(), source.clone()).unwrap();
                    assert_eq!(restore(packet.clone(), root.path()), source);
                    packet
                })
            })
            .collect::<Vec<_>>();
        let packets = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert!(packets.iter().all(|packet| packet == &packets[0]));
    });
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
}

#[test]
fn interning_preserves_duplicate_bodies_and_user_controlled_keys() {
    let text = "abc🙂".repeat(1024);
    let original =
        json!({"messages":[{"content":text}], "turns":[{"content":text}], "__proto__":text});
    let packed = pack(original.clone());
    assert_eq!(packed["strings"].as_array().unwrap().len(), 1);
    let root = tempfile::tempdir().unwrap();
    assert_eq!(
        restore(encode(root.path(), original.clone()).unwrap(), root.path()),
        original
    );
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
}

#[test]
fn task_and_session_scope_reject_cross_conversation_continuations() {
    let root = tempfile::tempdir().unwrap();
    let owner = snapshot_directory(root.path(), &json!({"taskId":"a", "threadId":"s1"}));
    let packet = encode(&owner, large_transcript()).unwrap();
    let request = json!({"snapshotId":packet["transfer"]["snapshotId"], "offset":CHUNK_BYTES});
    for address in [
        json!({"taskId":"b","threadId":"s1"}),
        json!({"taskId":"a","threadId":"s2"}),
    ] {
        assert!(read_chunk(&snapshot_directory(root.path(), &address), &request).is_err());
    }
    for id in ["../../private", "", "g".repeat(64).as_str()] {
        assert!(read_chunk(&owner, &json!({"snapshotId":id,"offset":CHUNK_BYTES})).is_err());
    }
    assert!(read_chunk(
        &owner,
        &json!({"snapshotId":request["snapshotId"],"offset":1})
    )
    .is_err());
}

#[test]
fn expired_snapshots_fail_explicitly_and_are_cleaned_on_write() {
    let root = tempfile::tempdir().unwrap();
    let packet = encode(root.path(), large_transcript()).unwrap();
    let id = packet["transfer"]["snapshotId"].as_str().unwrap();
    let path = root.path().join(format!("{id}.gz"));
    File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(SystemTime::now() - SNAPSHOT_LIFETIME - Duration::from_secs(1))
        .unwrap();
    assert!(read_chunk(root.path(), &json!({"snapshotId":id,"offset":CHUNK_BYTES})).is_err());
    remove_expired_snapshots(root.path()).unwrap();
    assert!(!path.exists());
}

#[test]
fn cleanup_only_removes_expired_snapshots_in_the_transfer_cache() {
    let root = tempfile::tempdir().unwrap();
    let directory = snapshot_directory(root.path(), &json!({"taskId":"old", "threadId":"s"}));
    fs::create_dir_all(&directory).unwrap();
    let expired_path = directory.join("old.gz");
    let active_path = directory.join("active.gz");
    let unrelated_path = root.path().join("unrelated.gz");
    for path in [&expired_path, &active_path, &unrelated_path] {
        fs::write(path, "test snapshot").unwrap();
    }
    for path in [&expired_path, &unrelated_path] {
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(SystemTime::now() - SNAPSHOT_LIFETIME - Duration::from_secs(1))
            .unwrap();
    }
    remove_expired_transfers(root.path()).unwrap();
    assert!(!expired_path.exists());
    assert!(active_path.exists());
    assert!(unrelated_path.exists());
}

#[test]
fn escaped_large_transcripts_do_not_feed_the_compressor_fragment_by_fragment() {
    struct CountedWriter<W> {
        inner: W,
        writes: usize,
    }
    impl<W: Write> Write for CountedWriter<W> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.writes += 1;
            self.inner.write(bytes)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.inner.flush()
        }
    }
    let packed = pack(large_transcript());
    let started = std::time::Instant::now();
    let writer = write_json(
        CountedWriter {
            inner: GzEncoder::new(Vec::new(), Compression::default()),
            writes: 0,
        },
        &packed,
    )
    .unwrap();
    let writes = writer.writes;
    let bytes = writer.inner.finish().unwrap();
    eprintln!(
        "transcript compression writes={writes} elapsed_ms={} compressed_bytes={}",
        started.elapsed().as_millis(),
        bytes.len()
    );
    let decoded: Value = serde_json::from_reader(GzDecoder::new(bytes.as_slice())).unwrap();
    assert_eq!(decoded, packed);
    assert!(
        writes < 1024,
        "The compressor received {writes} individual JSON fragments"
    );
}
