// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! A real, local Python HTTP upstream for knowledge rollback gateway tests.

use std::io::{BufRead, BufReader};
use std::net::SocketAddr;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use http::Uri;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub const KNOWLEDGE_PATHS: &[&str] = &[
    "/api/knowledge/documents/11/content",
    "/api/knowledge/documents?knowledge_base_id=7&offset=2&limit=3",
    "/api/knowledge-bases/7/document-protection",
    "/api/knowledge-bases/7/folders",
    "/api/knowledge-bases/7/documents/11/detail",
    "/api/knowledge-bases/7/artifacts",
    "/api/wiki/connections",
    "/api/share/KnowledgeBase/7/my-permission",
    "/api/mcp/knowledge-external/documents/11/file",
];

const HTTP_UPSTREAM: &str = r#"
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def handle_request(self):
        size = int(self.headers.get('Content-Length', 0))
        self.rfile.read(size)
        body = ('python ' + self.command + ' ' + self.path).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Test-Owner', 'python')
        self.send_header('X-Test-Process-Id', str(os.getpid()))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)
    do_GET = do_HEAD = do_POST = do_DELETE = handle_request
    def log_message(self, *args):
        pass
server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
print(server.server_port, flush=True)
server.serve_forever()
"#;

pub struct PythonUpstream {
    child: Child,
    pub uri: Uri,
}

impl PythonUpstream {
    pub fn start(backend: &Path) -> Self {
        Self::start_with_script(backend, HTTP_UPSTREAM, Duration::from_secs(15))
    }

    fn start_with_script(backend: &Path, script: &str, timeout: Duration) -> Self {
        let mut command = Command::new("uv");
        #[cfg(unix)]
        command.process_group(0);
        let child = command
            .args(["run", "--no-sync", "--offline", "python", "-u", "-c"])
            .arg(script)
            .current_dir(backend)
            .env("UV_CACHE_DIR", std::env::temp_dir().join("wegent-uv-cache"))
            .stdout(Stdio::piped())
            .spawn()
            .expect("start local Python upstream through uv run");
        let mut upstream = Self {
            child,
            uri: "http://127.0.0.1:0".parse().unwrap(),
        };
        let stdout = upstream.child.stdout.take().unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut port = String::new();
            let result = BufReader::new(stdout).read_line(&mut port).map(|_| port);
            let _ = send.send(result);
        });
        let port = receive
            .recv_timeout(timeout)
            .expect("Python upstream startup timed out")
            .expect("read Python upstream port");
        let port: u16 = port.trim().parse().expect("Python upstream port");
        upstream.uri = format!("http://127.0.0.1:{port}").parse().unwrap();
        upstream
    }
}

impl Drop for PythonUpstream {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            // uv supervises Python; terminating only uv orphans the HTTP server.
            let group = format!("-{}", self.child.id());
            let signal = |name: &str| {
                // procps 4.0.4 misparses negative PIDs without an option terminator.
                let _ = Command::new("/bin/kill")
                    .args([name, "--", group.as_str()])
                    .stderr(Stdio::null())
                    .status();
            };
            signal("-TERM");
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while matches!(self.child.try_wait(), Ok(None)) && std::time::Instant::now() < deadline
            {
                std::thread::sleep(Duration::from_millis(20));
            }
            signal("-KILL");
        }
        #[cfg(windows)]
        let _ = Command::new("taskkill")
            .args(["/PID", &self.child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub async fn request(address: SocketAddr, method: &str, path: &str) -> String {
    let mut stream = TcpStream::connect(address).await.unwrap();
    stream
        .write_all(
            format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    String::from_utf8(bytes).unwrap()
}

#[cfg(all(test, unix))]
mod cleanup_tests {
    use super::*;
    use std::time::Instant;

    // Keep a child in the test runner's group to detect over-broad cleanup.
    struct UnrelatedProcess(Child);

    impl UnrelatedProcess {
        fn start() -> Self {
            Self(
                Command::new("/bin/sleep")
                    .arg("60")
                    .spawn()
                    .expect("start unrelated sentinel"),
            )
        }

        fn assert_running(&mut self) {
            assert!(
                self.0
                    .try_wait()
                    .expect("inspect unrelated sentinel")
                    .is_none(),
                "upstream cleanup terminated an unrelated process"
            );
        }
    }

    impl Drop for UnrelatedProcess {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    struct ObservedPython(u32);

    impl ObservedPython {
        fn is_running(&self) -> bool {
            Command::new("/bin/kill")
                .args(["-0", "--", &self.0.to_string()])
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        }

        fn wait_until_stopped(&self) -> bool {
            let deadline = Instant::now() + Duration::from_secs(3);
            while self.is_running() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
            !self.is_running()
        }
    }

    impl Drop for ObservedPython {
        fn drop(&mut self) {
            if self.is_running() {
                // A failing regression test must also clean up its own fixture.
                let _ = Command::new("/bin/kill")
                    .args(["-KILL", "--", &self.0.to_string()])
                    .status();
            }
        }
    }

    #[tokio::test]
    async fn normal_drop_stops_actual_python_process_and_listener() {
        let mut unrelated = UnrelatedProcess::start();
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let backend = root.join("../backend");
        let upstream = PythonUpstream::start(&backend);
        let address: SocketAddr = upstream.uri.authority().unwrap().as_str().parse().unwrap();
        let response = request(address, "GET", "/cleanup-probe").await;
        let pid = response
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("x-test-process-id")
                    .then(|| value.trim().parse::<u32>().unwrap())
            })
            .expect("actual Python process ID");
        let python = ObservedPython(pid);
        assert!(python.is_running());
        drop(upstream);
        unrelated.assert_running();
        assert!(
            python.wait_until_stopped(),
            "Python process {pid} survived guard drop"
        );
        assert!(std::net::TcpStream::connect_timeout(&address, Duration::from_secs(1)).is_err());
    }

    #[test]
    fn startup_timeout_stops_actual_python_process_and_listener() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        struct ProbeFile(std::path::PathBuf);
        impl Drop for ProbeFile {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let mut unrelated = UnrelatedProcess::start();
        let probe = ProbeFile(std::env::temp_dir().join(format!(
            "wegent-python-startup-{}-{}.json",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        )));
        let script = format!(
            r#"
import json, os, socket, time
listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen()
with open({}, 'w') as probe:
    json.dump({{'pid': os.getpid(), 'port': listener.getsockname()[1]}}, probe)
time.sleep(60)
"#,
            serde_json::to_string(&probe.0.to_str().unwrap()).unwrap()
        );
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let result = std::panic::catch_unwind(|| {
            PythonUpstream::start_with_script(
                &root.join("../backend"),
                &script,
                Duration::from_secs(5),
            )
        });
        let metadata: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(&probe.0).expect("Python started before readiness timeout"),
        )
        .unwrap();
        let pid = u32::try_from(metadata["pid"].as_u64().unwrap()).unwrap();
        let python = ObservedPython(pid);
        unrelated.assert_running();
        let panic = result.err().expect("readiness must time out");
        let message = panic
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| panic.downcast_ref::<&str>().copied())
            .unwrap();
        assert!(message.contains("Python upstream startup timed out"));
        assert!(
            python.wait_until_stopped(),
            "Python process {pid} survived startup timeout"
        );
        let address: SocketAddr = format!("127.0.0.1:{}", metadata["port"]).parse().unwrap();
        assert!(std::net::TcpStream::connect_timeout(&address, Duration::from_secs(1)).is_err());
    }
}
