// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Real TCP regressions for the distinct public and loopback HTTP boundaries.

use std::{convert::Infallible, net::SocketAddr, time::Duration};

use http::Response;
use http_body_util::Full;
use hyper::{body::Bytes, service::service_fn};
use tokio::{
    io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};

use super::origin_runtime_config;
use crate::{Gateway, OriginService, RouteTable, RoutesConfig, serve};

const IDLE_INTERVAL: Duration = Duration::from_secs(16);
const REQUEST: &[u8] = b"GET /probe HTTP/1.1\r\nHost: localhost\r\n\r\n";

async fn start_origin() -> (SocketAddr, JoinHandle<std::io::Result<()>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(brz_http_server::hyper::serve(
        listener,
        |_| {
            service_fn(|_| async {
                Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(b"ok"))))
            })
        },
        std::future::pending(),
        origin_runtime_config(Duration::from_secs(1)),
    ));
    (address, task)
}

async fn start_public(origin: SocketAddr) -> (SocketAddr, JoinHandle<std::io::Result<()>>) {
    let routes = RouteTable::compile(
        toml::from_str::<RoutesConfig>("[[routes]]\nmethods = [\"GET\"]\npath = \"/probe\"")
            .unwrap(),
    )
    .unwrap();
    let gateway = Gateway::new(
        routes,
        OriginService::new(&format!("http://{origin}").parse().unwrap()).unwrap(),
        &"http://127.0.0.1:1".parse().unwrap(),
    )
    .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(serve(
        listener,
        gateway,
        std::future::pending(),
        Duration::from_secs(1),
    ));
    (address, task)
}

async fn request(client: &mut BufReader<TcpStream>) {
    client.get_mut().write_all(REQUEST).await.unwrap();
    let mut line = String::new();
    client.read_line(&mut line).await.unwrap();
    assert_eq!(
        line, "HTTP/1.1 200 OK\r\n",
        "same TCP connection must remain usable"
    );
    loop {
        line.clear();
        assert_ne!(client.read_line(&mut line).await.unwrap(), 0);
        if line == "\r\n" {
            break;
        }
    }
    let mut body = [0; 2];
    client.read_exact(&mut body).await.unwrap();
    assert_eq!(&body, b"ok");
}

async fn advance_idle_interval(duration: Duration) {
    // Complete fixed responses on the current-thread runtime first, so the
    // listener has returned to reading the next request head. Resume time
    // before real socket I/O to prevent automatic clock advancement.
    tokio::time::pause();
    tokio::time::advance(duration).await;
    tokio::time::resume();
    tokio::task::yield_now().await;
}

#[tokio::test]
async fn origin_keep_alive_survives_notification_poll_interval() {
    for idle_interval in [IDLE_INTERVAL, Duration::from_secs(90)] {
        let (address, server) = start_origin().await;
        let mut client = BufReader::new(TcpStream::connect(address).await.unwrap());
        request(&mut client).await;

        advance_idle_interval(idle_interval).await;

        request(&mut client).await;
        server.abort();
    }
}

#[tokio::test]
async fn public_gateway_closes_incomplete_request_head_after_fifteen_seconds() {
    let (origin, origin_server) = start_origin().await;
    let (address, gateway) = start_public(origin).await;
    let mut client = BufReader::new(TcpStream::connect(address).await.unwrap());
    request(&mut client).await;
    client
        .get_mut()
        .write_all(b"GET /probe HTTP/1.1\r\nHost: localhost\r\n")
        .await
        .unwrap();

    advance_idle_interval(IDLE_INTERVAL).await;

    let mut byte = [0];
    let result = tokio::time::timeout(Duration::from_secs(1), client.read(&mut byte))
        .await
        .expect("public gateway must close the incomplete request head");
    match result {
        Ok(0) => {}
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
        result => panic!("public request-head timeout must close at 15s, observed {result:?}"),
    }
    gateway.abort();
    origin_server.abort();
}
