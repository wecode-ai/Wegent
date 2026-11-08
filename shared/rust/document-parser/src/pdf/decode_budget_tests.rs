use super::*;
use std::io::Write;

#[test]
fn cancelled_decode_does_not_attempt_compatibility_recovery() {
    let budget = DecodeBudget::controlled(8192, crate::ParseControl::new(None, || true));
    let error = decode_flate(b"malformed data", &budget).unwrap_err();
    assert!(error.contains("cancelled"));
    assert!(budget.failed());
}

#[test]
fn repeated_page_reads_and_materialized_objects_consume_budget() {
    let object = Object::Name("font".into());
    let budget = DecodeBudget::new(std::mem::size_of::<Object>() + 4);
    allocation::charge(&object, &budget).unwrap();
    assert!(allocation::charge(&object, &budget).is_err());
    let doc = Document::load(&super::super::simple_pdf_bytes(), 8192).unwrap();
    assert_eq!(doc.pages().unwrap().len(), 1);
    assert!((0..1000).any(|_| doc.pages().is_err()));
}

#[test]
fn direct_object_depth_limit_fails_explicitly_on_a_small_worker_stack() {
    std::thread::Builder::new()
        .stack_size(256 * 1024)
        .spawn(|| {
            let limit = super::super::MAX_DIRECT_OBJECT_DEPTH;
            for (open, close) in [("[", "]"), ("<< /A ", ">>")] {
                let valid = format!("{}null{}", open.repeat(limit - 1), close.repeat(limit - 1));
                let mut cursor = Cursor::new(valid.as_bytes());
                let object = cursor.parse_object().unwrap();
                assert_eq!(cursor.depth, 0);
                drop(object.clone());
                drop(object);
                for depth in [limit, 20_000] {
                    let input = format!("{}null{}", open.repeat(depth), close.repeat(depth));
                    let mut cursor = Cursor::new(input.as_bytes());
                    assert!(cursor.parse_object().unwrap_err().contains("nesting limit"));
                    assert_eq!(cursor.depth, 0);
                }
            }
        })
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn deep_page_trees_are_complete_and_cycles_fail_without_hiding_pages() {
    let depth = 20_000;
    let mut objects = HashMap::new();
    for index in 1..=depth {
        objects.insert(
            index,
            Object::Dictionary(Dictionary::from([(
                "/Kids".into(),
                Object::Array(vec![Object::Reference(index + 1)]),
            )])),
        );
    }
    objects.insert(depth + 1, Object::Dictionary(Dictionary::new()));
    let mut doc = Document {
        objects,
        trailer: Dictionary::from([(
            "/Root".into(),
            Object::Dictionary(Dictionary::from([("/Pages".into(), Object::Reference(1))])),
        )]),
        budget: DecodeBudget::new(usize::MAX),
    };
    assert_eq!(doc.pages().unwrap().len(), 1);
    doc.objects.insert(
        depth,
        Object::Dictionary(Dictionary::from([(
            "/Kids".into(),
            Object::Array(vec![Object::Reference(1)]),
        )])),
    );
    assert!(doc.pages().unwrap_err().contains("cyclic"));
    doc.objects.insert(
        1,
        Object::Dictionary(Dictionary::from([(
            "/Kids".into(),
            Object::Array(vec![
                Object::Reference(depth + 1),
                Object::Reference(depth + 1),
            ]),
        )])),
    );
    assert_eq!(doc.pages().unwrap().len(), 2);
}

#[test]
fn object_stream_metadata_cannot_allocate_or_index_outside_real_headers() {
    for (count, first, data) in [
        (i64::MAX, 0, b"".as_slice()),
        (1, i64::MAX, b"0 0 null".as_slice()),
        (1, 5, b"0 -1 null".as_slice()),
    ] {
        let mut objects = HashMap::from([(
            1,
            Object::Stream(Stream {
                dict: Dictionary::from([
                    ("/N".into(), Object::Integer(count)),
                    ("/First".into(), Object::Integer(first)),
                ]),
                data: data.to_vec(),
            }),
        )]);
        let entries = HashMap::from([(
            2,
            xref::Entry::InStream {
                stream: 1,
                index: 0,
            },
        )]);
        assert!(
            Document::load_object_streams(&mut objects, &entries, &DecodeBudget::new(1024))
                .is_err()
        );
    }
}

#[test]
fn flate_limits_apply_to_zlib_and_raw_compatibility_decoding() {
    let plain = vec![b'a'; 1024 * 1024];
    let mut zlib = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    zlib.write_all(&plain).unwrap();
    let mut raw = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
    raw.write_all(&plain).unwrap();
    for encoded in [zlib.finish().unwrap(), raw.finish().unwrap()] {
        assert_eq!(
            decode_flate(&encoded, &DecodeBudget::new(plain.len())).unwrap(),
            plain
        );
        let budget = DecodeBudget::new(plain.len() - 1);
        assert!(decode_flate(&encoded, &budget).is_err());
        assert!(budget.failed());
        assert!(budget.consume(0).is_err());
    }
}

#[test]
fn filters_and_repeated_streams_share_one_budget() {
    let chain = vec!["/AHx".into(), "/AHx".into()];
    let budget = DecodeBudget::new(7);
    assert_eq!(
        apply_filters(chain.clone(), b"3431", &budget).unwrap(),
        b"A"
    );
    assert!(decoded_stream_data(&Dictionary::new(), b"x", &budget).is_err());
    assert!(apply_filters(chain, b"3431", &DecodeBudget::new(6)).is_err());
    assert_eq!(
        decode_ascii85(b"z~>", &DecodeBudget::new(4)).unwrap(),
        [0; 4]
    );
    assert!(decode_ascii85(b"z~>", &DecodeBudget::new(3)).is_err());
}

#[test]
fn predictor_dimensions_cannot_allocate_from_untrusted_metadata() {
    let parms: Dictionary = [
        ("/Predictor".into(), Object::Integer(12)),
        ("/Columns".into(), Object::Integer(i64::MAX)),
        ("/Colors".into(), Object::Integer(i64::MAX)),
    ]
    .into_iter()
    .collect();
    assert!(apply_predictor(Some(&parms), vec![0, 1]).is_err());
    let parms: Dictionary = [
        ("/Predictor".into(), Object::Integer(12)),
        ("/Columns".into(), Object::Integer(i64::MAX)),
    ]
    .into_iter()
    .collect();
    assert!(apply_predictor(Some(&parms), vec![0, 1]).is_err());
}
