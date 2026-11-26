// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{convert::Infallible, io::Read, iter, path::Path};

use axum::body::Bytes;
use futures_util::{stream, StreamExt};

use super::*;

const BOUNDARY: &str = "wegent-upload-boundary";
const CHUNK_BYTES: usize = 64 * 1024;
const CHUNKS_PER_MIB: usize = 1024 * 1024 / CHUNK_BYTES;

fn upload_request(
    path: &Path,
    fields: impl Iterator<Item = Bytes> + Send + 'static,
) -> Request<Body> {
    let body = fields.chain(iter::once(Bytes::from(format!("\r\n--{BOUNDARY}--\r\n"))));
    Request::builder()
        .method(Method::POST)
        .uri(format!("/files?path={}", path.display()))
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={BOUNDARY}"),
        )
        .body(Body::from_stream(stream::iter(body).then(|chunk| async {
            // Deliver each chunk separately to exercise incremental body validation.
            tokio::task::yield_now().await;
            Ok::<_, Infallible>(chunk)
        })))
        .unwrap()
}

fn file_header() -> Bytes {
    Bytes::from(format!(
        "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"upload.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n"
    ))
}

#[tokio::test]
async fn accepts_a_100_mib_file_with_multipart_framing() {
    let _lock = env_lock().lock().await;
    let home = tempfile::tempdir().unwrap();
    let _home = EnvGuard::set("HOME", &home.path().display().to_string());
    let target = home.path().join("attachments/upload.bin");
    let chunk = Bytes::from(vec![b'x'; CHUNK_BYTES]);
    let file_chunks = (0..100 * CHUNKS_PER_MIB).map(move |_| chunk.clone());
    let request = upload_request(&target, iter::once(file_header()).chain(file_chunks));

    let response = create_router(AppState::new(RecordingRunner::default()))
        .oneshot(request)
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let mut file = fs::File::open(&target).unwrap();
    assert_eq!(file.metadata().unwrap().len(), 100 * 1024 * 1024);
    let mut actual = vec![0; CHUNK_BYTES];
    for _ in 0..100 * CHUNKS_PER_MIB {
        file.read_exact(&mut actual).unwrap();
        assert!(actual.iter().all(|byte| *byte == b'x'));
    }
}

#[tokio::test]
async fn rejects_an_oversized_multipart_form_without_replacing_the_existing_file() {
    let _lock = env_lock().lock().await;
    let home = tempfile::tempdir().unwrap();
    let _home = EnvGuard::set("HOME", &home.path().display().to_string());
    let target = home.path().join("upload.bin");
    fs::write(&target, b"original").unwrap();
    let chunk = Bytes::from(vec![b'x'; CHUNK_BYTES]);
    let extra_chunks = (0..101 * CHUNKS_PER_MIB).map(move |_| chunk.clone());
    let fields = [
        file_header(),
        Bytes::from_static(b"replacement"),
        Bytes::from(format!(
            "\r\n--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"metadata\"\r\n\r\n"
        )),
    ];
    let request = upload_request(&target, fields.into_iter().chain(extra_chunks));
    assert!(!request.headers().contains_key(header::CONTENT_LENGTH));

    let response = create_router(AppState::new(RecordingRunner::default()))
        .oneshot(request)
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({"detail": "Request payload is too large"})
    );
    assert_eq!(fs::read(&target).unwrap(), b"original");
}
