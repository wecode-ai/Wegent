// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Native diagnostics shared by the public and internal application entrypoints.

use brz_http_server::{Response, ResponseStream, StatusCode};
use brz_metrics::{PrometheusReader, prometheus::CONTENT_TYPE};
use tokio::io::AsyncReadExt;
use tokio_util::io::ReaderStream;

#[brz_http_server::get("/metrics", api_log = false, access = public)]
async fn metrics() -> Response {
    response()
}

/// Creates a streaming response without consuming counters or buffering the body.
pub fn response() -> Response {
    let robot = std::io::Cursor::new(crate::background_jobs::robot::prometheus().into_bytes());
    let body = ReaderStream::new(PrometheusReader::new().chain(robot));
    Response::stream(StatusCode::OK, ResponseStream::new(body)).content_type(CONTENT_TYPE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_metrics::{CounterMetric, GaugeMetric, MetricType, ResourceMetric, TimingMetric};
    use std::time::Duration;

    mod probe {
        brz_http_server::registry!(group = metrics_probe, dependencies());
    }

    #[brz_http_server::get("/metrics", group = probe::metrics_probe, api_log = false, access = public)]
    async fn scrape() -> Response {
        response()
    }

    #[tokio::test]
    async fn http_scrapes_stream_counters_and_gauges_without_consuming_them() {
        let name = "prometheus-http-test";
        let request = TimingMetric::new(MetricType::Redis(ResourceMetric::Req), name);
        request.record(Duration::from_millis(200), false);
        let current = GaugeMetric::new(MetricType::Redis(ResourceMetric::Conn), name);
        current.set(3);
        let opened = CounterMetric::new(MetricType::Redis(ResourceMetric::Conn), name);
        opened.add(7);

        let handler = brz_http_server::handlers!(; group = probe::metrics_probe).unwrap();
        let server = brz_http_server::Server::bind("127.0.0.1:0".parse().unwrap(), handler)
            .await
            .unwrap();
        let address = server.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(server.serve_until(async {
            let _ = stopped.await;
        }));
        let client = brz_http::Client::new();
        let before = request.snapshot();
        for _ in 0..2 {
            let response = client
                .get(format!("http://{address}/metrics"))
                .unwrap()
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers().get("content-type").unwrap(),
                CONTENT_TYPE
            );
            assert_eq!(
                response.headers().get("transfer-encoding").unwrap(),
                "chunked"
            );
            let body = String::from_utf8(response.bytes().await.unwrap().to_vec()).unwrap();
            assert!(
                body.contains("brz_req_total{type=\"REDIS\",name=\"prometheus-http-test\"} 1\n")
            );
            assert!(body.contains("brz_conn{type=\"REDIS\",name=\"prometheus-http-test\"} 3\n"));
            assert!(
                body.contains("brz_conn_total{type=\"REDIS\",name=\"prometheus-http-test\"} 7\n")
            );
            assert!(!body.contains("status_class="));
        }
        assert_eq!(request.snapshot(), before);
        assert_eq!(current.get(), 3);
        assert_eq!(opened.get(), 7);
        stop.send(()).unwrap();
        task.await.unwrap().unwrap();
    }
}
