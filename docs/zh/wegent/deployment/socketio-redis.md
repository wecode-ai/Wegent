---
sidebar_position: 5
---

# Socket.IO Redis 连接恢复

多个 Backend 实例通过 Redis Pub/Sub 转发设备命令、RPC 回包和实时消息。设备的
WebSocket 心跳与 Redis 订阅连接是独立链路；显示在线不能证明跨实例通信正常。

## 连接设置

Backend 的 Socket.IO Redis manager 默认启用 TCP keepalive，并使用以下环境变量。
所有值以秒为单位，必须是有限的正数。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `SOCKETIO_REDIS_SOCKET_TIMEOUT` | `30` | 限制一次 Redis 读取或写入的等待时间 |
| `SOCKETIO_REDIS_CONNECT_TIMEOUT` | `5` | 限制建立 Redis 连接的等待时间 |
| `SOCKETIO_REDIS_HEALTH_CHECK_INTERVAL` | `15` | Redis 客户端执行命令或读取前的健康检查间隔 |

这些设置只作用于 Backend 的 Socket.IO Redis manager，不改变缓存或 Celery 的连接设置。
修改环境变量后需要重启 Backend 实例。

## 超时与重新订阅

当 TCP 连接仍显示为 ESTABLISHED，但 Redis 不再发送数据时，有限读取超时会使
客户端进入已有的重连和重新订阅流程。收到一条消息的部分数据后停止收包，也会触发
这一流程，避免 listener 一直等待剩余字节。

健康检查在客户端执行命令或读取前进行，不是在后台定时运行。因此完全空闲的订阅
也可能达到读取超时，并自动重新订阅。持续连接失败时沿用 Socket.IO 的重试退避。
重新订阅恢复后可以接收新消息；Redis Pub/Sub 不重放断连期间错过的消息，已超时的
设备操作需要重新发起。

## 验证恢复

从设备 WebSocket 所属实例以外的 Backend 调用只读 `runtime.capacity.get`，确认
收到 RPC 回包。也应检查订阅恢复后的设备命令和实时推送。

`device:online` 的心跳与 TTL 正常、Pod Running 或同实例调用成功，都不能单独作为
跨实例消息接收已恢复的依据。
