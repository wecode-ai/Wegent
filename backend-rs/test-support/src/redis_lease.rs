//! Disposable RESP fixture for token-owned lifecycle lease contracts.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};

pub struct RedisLease {
    pub address: String,
    server: tokio::task::JoinHandle<()>,
}

impl RedisLease {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let values = Arc::new(Mutex::new(HashMap::<String, (String, Instant)>::new()));
        let server = tokio::spawn(async move {
            let mut peers = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    peer = listener.accept() => {
                        let (read, mut write) = peer.unwrap().0.into_split();
                        let values = values.clone();
                        peers.spawn(async move {
                            let mut read = BufReader::new(read);
                            loop {
                                let mut line = String::new();
                                if read.read_line(&mut line).await.unwrap_or(0) == 0 { break }
                                let count: usize = line.trim().strip_prefix('*').unwrap().parse().unwrap();
                                let mut args = Vec::new();
                                for _ in 0..count {
                                    line.clear(); read.read_line(&mut line).await.unwrap();
                                    let len: usize = line.trim().strip_prefix('$').unwrap().parse().unwrap();
                                    let mut bytes = vec![0; len + 2]; read.read_exact(&mut bytes).await.unwrap();
                                    args.push(String::from_utf8(bytes[..len].to_vec()).unwrap());
                                }
                                let response = {
                                    let mut values = values.lock().unwrap();
                                    values.retain(|_, (_, until)| *until > Instant::now());
                                    match args[0].as_str() {
                                        "PING" => "+PONG\r\n".into(),
                                        "CLIENT" | "SELECT" | "AUTH" => "+OK\r\n".into(),
                                        "SET" => {
                                            if values.contains_key(&args[1]) && args.iter().any(|arg| arg == "NX") { "$-1\r\n".into() }
                                            else {
                                                let ttl = args.windows(2).find(|pair| pair[0] == "PX").map_or(30_000, |pair| pair[1].parse().unwrap());
                                                values.insert(args[1].clone(), (args[2].clone(), Instant::now() + Duration::from_millis(ttl)));
                                                "+OK\r\n".into()
                                            }
                                        }
                                        "GET" => values.get(&args[1]).map_or("$-1\r\n".into(), |(token, _)| format!("${}\r\n{}\r\n", token.len(), token)),
                                        "EVAL" => {
                                            let owns = values.get(&args[3]).is_some_and(|(token, _)| *token == args[4] || *token == args[5]);
                                            if owns && args[1].contains("PEXPIRE") {
                                                values.get_mut(&args[3]).unwrap().1 = Instant::now() + Duration::from_millis(args[6].parse().unwrap());
                                            } else if owns && args[1].contains("'DEL'") { values.remove(&args[3]); }
                                            format!(":{}\r\n", i32::from(owns))
                                        }
                                        command => panic!("unexpected lease fixture command: {command}"),
                                    }
                                };
                                if write.write_all(response.as_bytes()).await.is_err() { break }
                            }
                        });
                    }
                    Some(peer) = peers.join_next() => { peer.unwrap(); }
                }
            }
        });
        Self { address, server }
    }
}

impl Drop for RedisLease {
    fn drop(&mut self) {
        self.server.abort();
    }
}
