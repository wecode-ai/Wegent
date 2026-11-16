# tf-rust-socketio

> **这是 [rust-socketio](https://github.com/1c3t3a/rust-socketio) 的分支，为 [A2C-SMCP](https://github.com/A2C-SMCP) 协议添加了额外功能。**

## 致谢

本项目基于 [Bastian Kersting](https://github.com/1c3t3a) 和 rust-socketio 社区的优秀工作。我们感谢他们对 Rust 生态系统的贡献。

我们计划在时间允许时通过 PR 将这些增强功能贡献回上游项目。目前，此分支主要用于 A2C-SMCP 项目的内部使用。

## 相对上游的增强功能

此分支包含以下增强功能：

### 1. 服务端到客户端 ACK 支持 (emitWithAck)

官方 `rust_socketio` 不支持响应服务端的 `emitWithAck` 调用。此分支添加了：

- `Payload` 枚举现在包含可选的 `ack_id: Option<i32>` 字段
- 同步和异步客户端都新增了 `ack()` 和 `ack_with_id()` 方法
- 新增 `Packet::ack_from_payload()` 方法用于构造 ACK 响应包

```rust
// 示例：响应服务端的 emitWithAck
socket.on("foo", |payload, socket| {
    async move {
        if let Payload::Text(values, ack_id) = payload {
            if let Some(id) = ack_id {
                socket.ack_with_id(id, json!({"status": "ok"})).await;
            }
        }
    }.boxed()
});
```

### 2. 重连 Header 更新

添加了在重连期间更新 HTTP headers 的功能（适用于 token 刷新场景）：

- `ReconnectSettings` 现在有 `opening_header()` 方法
- `ClientBuilder.opening_headers` 可见性改为 `pub(crate)`

```rust
// 示例：重连时更新认证 header
settings.opening_header("Authorization", "Bearer new_token");
```

### 3. 关闭原因增强

`Event::Close` 的 payload 现在包含断开连接原因：

- 新增 `CloseReason` 枚举，包含以下变体：
  - `IOServerDisconnect` - 服务端发起断开
  - `IOClientDisconnect` - 客户端发起断开
  - `TransportClose` - 传输层关闭

这与官方 Socket.IO 客户端的断开原因保持一致。

### 4. 其他修复

- 在 `engineio/client.rs` 中添加了生命周期标注 `Iter<'_>`（编译器警告修复）
- 为并发 ACK 场景添加了额外的测试覆盖

---

## 原始 README

[![Latest Version](https://img.shields.io/crates/v/tf_rust_socketio)](https://crates.io/crates/tf_rust_socketio)
[![docs.rs](https://docs.rs/tf_rust_socketio/badge.svg)](https://docs.rs/tf_rust_socketio)
[![Build and code style](https://github.com/1c3t3a/rust-socketio/actions/workflows/build.yml/badge.svg)](https://github.com/1c3t3a/rust-socketio/actions/workflows/build.yml)
[![Test](https://github.com/1c3t3a/rust-socketio/actions/workflows/test.yml/badge.svg)](https://github.com/1c3t3a/rust-socketio/actions/workflows/test.yml)
[![codecov](https://codecov.io/gh/1c3t3a/rust-socketio/branch/main/graph/badge.svg?token=GUF406K0KL)](https://codecov.io/gh/1c3t3a/rust-socketio)

# Rust-socketio-client

一个用 Rust 编程语言编写的 socket.io 客户端实现。此实现目前支持 socket.io 协议的第 5 版，因此也支持 engine.io 协议的第 4 版。如果您在使用此客户端时遇到连接问题，请确保服务器至少使用 engine.io 协议的第 4 版。
关于 [`async`](#async) 版本的信息可以在下方找到。

## 使用示例

在您的 `Cargo.toml` 文件中添加以下内容：

```toml
tf_rust_socketio = "*"
```

然后您就可以运行以下示例代码：

``` rust
use tf_rust_socketio::{ClientBuilder, Payload, RawClient};
use serde_json::json;
use std::time::Duration;

// 定义一个在收到 payload 时调用的回调函数
// 此回调函数获取 payload 以及一个用于与服务器通信的 socket 实例
let callback = |payload: Payload, socket: RawClient| {
       match payload {
           Payload::String(str) => println!("Received: {}", str),
           Payload::Binary(bin_data) => println!("Received bytes: {:#?}", bin_data),
       }
       socket.emit("test", json!({"got ack": true})).expect("Server unreachable")
};

// 获取一个连接到 admin 命名空间的 socket
let socket = ClientBuilder::new("http://localhost:4200")
     .namespace("/admin")
     .on("test", callback)
     .on("error", |err, _| eprintln!("Error: {:#?}", err))
     .connect()
     .expect("Connection failed");

// 向 "foo" 事件发送消息
let json_payload = json!({"token": 123});
socket.emit("foo", json_payload).expect("Server unreachable");

// 定义一个在 ack 被确认时执行的回调
let ack_callback = |message: Payload, _| {
    println!("Yehaa! My ack got acked?");
    println!("Ack data: {:#?}", message);
};

let json_payload = json!({"myAckData": 123});
// 带 ack 发送
socket
    .emit_with_ack("test", json_payload, Duration::from_secs(2), ack_callback)
    .expect("Server unreachable");

socket.disconnect().expect("Disconnect failed")

```

使用此 crate 的主要入口点是 `ClientBuilder`，它提供了一种简单配置 socket 的方式。当在 builder 上调用 `connect` 方法时，它返回一个已连接的客户端，然后可以用于向特定事件发送消息。一个客户端只能连接到一个命名空间。如果您需要监听不同命名空间中的消息，您需要分配多个 socket。

## 文档

此 crate 的文档可以在 [docs.rs](https://docs.rs/tf_rust_socketio) 上找到。

## 当前功能

此实现现在支持 [这里](https://github.com/socketio/socket.io-protocol) 提到的 socket.io 协议的所有功能。
它通常尽可能使用 websockets。这意味着大多数情况下只有开始的请求使用 http，一旦服务器表示它能够升级到 websockets，就会执行升级。但如果升级不成功或服务器没有提及升级可能性，则使用 http 长轮询（如协议规范中指定的那样）。
以下是可能用例的概述：
- 连接到服务器
- 为以下事件类型注册回调：
    - open
    - close
    - error
    - message
    - 自定义事件如 "foo"、"on_payment" 等
- 向服务器发送 JSON 数据（通过提供安全处理的 `serde_json`）
- 向服务器发送 JSON 数据并接收 `ack`
- 发送和处理二进制数据
- **响应服务端的 `emitWithAck` 调用并发送客户端 ack 消息**

### 服务端到客户端 ACK 支持

此 crate 现在支持响应服务端的 `emitWithAck` 调用。当服务端发送带有确认请求的事件时，客户端可以使用 `ack` 方法进行响应：

#### 同步示例：
```rust
use tf_rust_socketio::{ClientBuilder, Payload, RawClient};
use serde_json::json;

let ack_callback = |message: Payload, socket: RawClient| {
    match message {
        Payload::Text(values, ack_id) => {
            println!("{:#?}", values);
            // 使用特定的 ack_id 响应以支持并发 ACK
            if let Some(id) = ack_id {
                socket.ack_with_id(id, json!({"status": "received"})).unwrap();
            }
        },
        Payload::Binary(bytes, ack_id) => {
            println!("Received bytes: {:#?}", bytes);
            if let Some(id) = ack_id {
                socket.ack_with_id(id, vec![1, 2, 3]).unwrap();
            }
        },
        Payload::String(str, ack_id) => {
            println!("{}", str);
            if let Some(id) = ack_id {
                socket.ack_with_id(id, "response").unwrap();
            }
        },
    }
};

let mut socket = ClientBuilder::new("http://localhost:4200/")
    .on("messageWithAck", ack_callback)
    .connect()
    .expect("connection failed");
```

#### 异步示例：
```rust
use futures_util::FutureExt;
use tf_rust_socketio::{asynchronous::{Client, ClientBuilder}, Payload};
use serde_json::json;

let callback = |payload: Payload, socket: Client| {
    async move {
        match payload {
            Payload::Text(values, ack_id) => {
                println!("{:#?}", values);
                // 使用特定的 ack_id 响应以支持并发 ACK
                if let Some(id) = ack_id {
                    let _ = socket.ack_with_id(id, json!({"status": "received"})).await;
                }
            },
            Payload::Binary(bytes, ack_id) => {
                println!("Received bytes: {:#?}", bytes);
                if let Some(id) = ack_id {
                    let _ = socket.ack_with_id(id, vec![4, 5, 6]).await;
                }
            },
            Payload::String(str, ack_id) => {
                println!("{}", str);
                if let Some(id) = ack_id {
                    let _ = socket.ack_with_id(id, "response").await;
                }
            },
        }
    }.boxed()
};

let socket = ClientBuilder::new("http://localhost:4200")
    .namespace("/")
    .on("serverEvent", callback)
    .connect()
    .await
    .expect("Connection failed");
```

**注意**：客户端仅保留最近的 ack ID。如果快速连续收到多个需要 ack 的消息，只有最后一个可以被确认。

## <a name="async"> 异步版本
此库提供了使用 `tokio` 作为执行运行时在异步上下文中执行的能力。
请注意，当前的异步实现仍处于实验阶段，接口随时可能更改。
异步 `Client` 和 `ClientBuilder` 支持与同步版本类似的接口，位于 `asynchronous` 模块中。要启用支持，您需要启用 `async` feature flag：
```toml
tf_rust_socketio = { version = "*", features = ["async"] }
```

以下代码展示了上述示例的异步版本：
``` rust
use futures_util::FutureExt;
use tf_rust_socketio::{
    asynchronous::{Client, ClientBuilder},
    Payload,
};
use serde_json::json;
use std::time::Duration;

#[tokio::main]
async fn main() {
    // 定义一个在收到 payload 时调用的回调函数
    // 此回调函数获取 payload 以及一个用于与服务器通信的 socket 实例
    let callback = |payload: Payload, socket: Client| {
        async move {
            match payload {
                Payload::String(str) => println!("Received: {}", str),
                Payload::Binary(bin_data) => println!("Received bytes: {:#?}", bin_data),
            }
            socket
                .emit("test", json!({"got ack": true}))
                .await
                .expect("Server unreachable");
        }
        .boxed()
    };

    // 获取一个连接到 admin 命名空间的 socket
    let socket = ClientBuilder::new("http://localhost:4200/")
        .namespace("/admin")
        .on("test", callback)
        .on("error", |err, _| {
            async move { eprintln!("Error: {:#?}", err) }.boxed()
        })
        .connect()
        .await
        .expect("Connection failed");

    // 向 "foo" 事件发送消息
    let json_payload = json!({"token": 123});
    socket
        .emit("foo", json_payload)
        .await
        .expect("Server unreachable");

    // 定义一个在 ack 被确认时执行的回调
    let ack_callback = |message: Payload, _: Client| {
        async move {
            println!("Yehaa! My ack got acked?");
            println!("Ack data: {:#?}", message);
        }
        .boxed()
    };

    let json_payload = json!({"myAckData": 123});
    // 带 ack 发送
    socket
        .emit_with_ack("test", json_payload, Duration::from_secs(2), ack_callback)
        .await
        .expect("Server unreachable");

    socket.disconnect().await.expect("Disconnect failed");
}
```

## 仓库内容

此仓库包含 socket.io 协议以及底层 engine.io 协议的 Rust 实现。

engine.io 协议的详细信息可以在这里找到：

* <https://github.com/socketio/engine.io-protocol>

socket.io 协议的规范在这里：

* <https://github.com/socketio/socket.io-protocol>

查看组件图，以下部分已实现（来源：https://socket.io/images/dependencies.jpg）：

<img src="docs/res/dependencies.jpg" width="50%"/>

## 许可证

MIT
