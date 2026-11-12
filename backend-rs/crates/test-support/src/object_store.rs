//! Real local object-store wire fixtures and HTTP metrics inspection.
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

pub fn scrape() -> String {
    let mut output = String::new();
    std::io::Read::read_to_string(&mut brz_metrics::PrometheusReader::new(), &mut output).unwrap();
    output
}

pub async fn serve_objects(
    listener: TcpListener,
    mut remaining: usize,
    counted_path_prefix: &str,
) -> Vec<(String, Vec<u8>)> {
    let mut requests = Vec::new();
    while remaining > 0 {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = BufReader::new(socket);
        let mut request_line = String::new();
        socket.read_line(&mut request_line).await.unwrap();
        let mut length = 0;
        loop {
            let mut header = String::new();
            assert!(socket.read_line(&mut header).await.unwrap() > 0);
            if header == "\r\n" {
                break;
            }
            if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:") {
                length = value.trim().parse().unwrap();
            }
        }
        let mut body = vec![0; length];
        socket.read_exact(&mut body).await.unwrap();
        let response_body = if request_line.starts_with("GET ") {
            "object"
        } else {
            ""
        };
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
            response_body.len()
        );
        socket
            .get_mut()
            .write_all(response.as_bytes())
            .await
            .unwrap();
        if request_line
            .split_whitespace()
            .nth(1)
            .unwrap()
            .starts_with(counted_path_prefix)
        {
            remaining -= 1;
        }
        requests.push((request_line, body));
    }
    requests
}
