---
sidebar_position: 1
---

# 微博私信 Messager 通道设计

## 背景

Wegent 已经有 provider 无关的 IM 通道体系。`Messager` CRD 存储 IM channel 配置，`ChannelManager` 负责 provider 生命周期，`BaseChannelHandler` 负责把私聊消息路由到命令、IM private session、Agent 会话和任务续接逻辑。现有实现已经覆盖 DingTalk、Telegram、Discord 等 provider。

参考项目 `wecode-ai/openclaw-weibo` 使用微博 Open IM WebSocket 模式接入私信：服务端先用 `app_id` 和 `app_secret` 获取 token，然后连接 WebSocket；入站私信以 `type: "message"` 事件推送，出站私信用 `type: "send_message"` 帧发送。

本设计把微博私信作为 Wegent 的一个新 `Messager` provider 接入，而不是新建独立 bridge 服务。这样可以复用现有私聊 session、命令路由、默认智能体、模型选择、任务续接和后台管理能力。

## 目标

1. 管理员可以在后台创建、编辑、启停微博 `Messager` 通道。
2. 后端可以维护微博 Open IM WebSocket 连接，并在断线后自动重连。
3. 用户给微博私信机器人发送文本后，消息进入 Wegent 现有 IM 私聊处理链。
4. Wegent 的文本回复可以通过微博私信发回原发送者。
5. Agent 执行过程中的回复可以通过微博私信流式输出：同一 `messageId`、递增 `chunkId`、中间帧 `done = false`、结束帧 `done = true`。
6. 微博通道支持现有用户映射模式：`select_user`、`staff_id`、`email`。
7. 敏感配置继续使用现有 `Messager` 配置加密和响应脱敏机制。
8. 所有测试都 mock 微博网络，不依赖真实微博服务。

## 非目标

1. v1 不支持微博群聊。
2. v1 不支持图片、文件、视频等附件收发。
3. v1 不新增独立微博 bridge 服务或新的会话体系。
4. v1 不改变现有 DingTalk、Telegram、Discord provider 行为。
5. v1 不做订阅通知 fanout 到微博；只处理用户主动私聊和该私聊的回复。
6. v1 不给后台暴露流式分片策略配置；使用代码内默认节流和分片参数。

## 总体架构

微博作为新的 `channel_type = "weibo"` 接入现有 `Messager` 扩展点：

```text
Admin UI
  -> /api/admin/im-channels
  -> Messager Kind(spec.channelType = "weibo")
  -> ChannelManager
  -> WeiboChannelProvider
  -> WeiboWebSocketClient
  -> WeiboChannelHandler
  -> BaseChannelHandler.handle_message()
  -> IM private session / commands / Agent execution
  -> WeiboStreamingResponseEmitter
  -> Weibo send_message chunks
```

新增后端模块位于 `backend/app/services/channels/weibo/`：

| 文件 | 职责 |
| --- | --- |
| `client.py` | token 获取和缓存、WebSocket 连接、ping/pong、断线重连、连接状态 |
| `sender.py` | 生成微博出站消息 ID，并通过当前 WebSocket 发送文本私信 |
| `handler.py` | 解析微博消息事件，构造 `MessageContext`，发送文本回复 |
| `service.py` | 实现 `BaseChannelProvider`，接入 `ChannelManager` 生命周期 |
| `user_resolver.py` | 按微博用户 ID、用户名或固定用户配置解析 Wegent 用户 |
| `emitter.py` | 实现 `ResultEmitter`，把 Agent 输出转换为微博流式私信 chunk |
| `callback.py` | 保存和重建微博 callback info，让 device/cloud 执行事件也能流式回传 |

通用层需要扩展：

- `backend/app/services/channels/callback.py` 的 `ChannelType` 增加 `WEIBO = "weibo"`。
- `backend/app/services/channels/manager.py` 注册微博 provider factory。
- `backend/app/schemas/im_channel.py` 的 channel type literal 和微博配置 schema 增加 `weibo`。
- `backend/app/api/endpoints/admin/im_channels.py` 的有效类型增加 `weibo`。
- `frontend/src/apis/admin.ts` 的 `IMChannelType` 增加 `weibo`。
- `frontend/src/features/admin/components/IMChannelList.tsx` 支持微博配置表单。
- `frontend/src/i18n/locales/{zh-CN,en}/admin.json` 增加微博相关文案。

## 配置模型

微博 channel 继续存储为 `Kind(kind="Messager", user_id=0)`：

```json
{
  "apiVersion": "agent.wecode.io/v1",
  "kind": "Messager",
  "metadata": {
    "name": "weibo-main",
    "namespace": "default"
  },
  "spec": {
    "channelType": "weibo",
    "isEnabled": true,
    "config": {
      "app_id": "123456",
      "app_secret": "<encrypted>",
      "ws_endpoint": "ws://open-im.api.weibo.com/ws/stream",
      "token_endpoint": "https://open-im.api.weibo.com/open/auth/ws_token",
      "user_mapping_mode": "select_user",
      "user_mapping_config": {
        "target_user_id": 1
      }
    },
    "defaultTeamId": 10,
    "defaultModelName": ""
  }
}
```

### 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `app_id` | 是 | 微博 Open IM 应用 ID |
| `app_secret` | 是 | 微博 Open IM 应用密钥，写入时加密，读取 API 响应脱敏 |
| `ws_endpoint` | 否 | WebSocket endpoint，默认 `ws://open-im.api.weibo.com/ws/stream` |
| `token_endpoint` | 否 | token endpoint，默认 `https://open-im.api.weibo.com/open/auth/ws_token` |
| `user_mapping_mode` | 否 | 默认 `select_user` |
| `user_mapping_config` | 否 | `select_user` 模式下保存 `target_user_id` |

现有敏感字段检测会匹配 `app_secret` 中的 `secret`，因此不需要为加密机制另起字段。更新 channel 时，`app_secret = "***"` 表示保留原密钥。

## 入站数据流

1. 后端启动或 channel 被启用时，`ChannelManager.start_channel()` 创建 `WeiboChannelProvider`。
2. Provider 校验 `app_id` 和 `app_secret`。
3. `WeiboWebSocketClient` 向 `token_endpoint` 发送：

   ```json
   {
     "app_id": "<app_id>",
     "app_secret": "<app_secret>"
   }
   ```

4. token 返回后缓存到内存，缓存 key 需要包含 channel ID 和配置指纹。
5. 客户端连接：

   ```text
   <ws_endpoint>?app_id=<app_id>&token=<token>&version=<backend-version>
   ```

6. 收到 WebSocket 文本帧后解析 JSON。仅处理：

   ```json
   {
     "type": "message",
     "payload": {
       "messageId": "mid",
       "fromUserId": "uid",
       "text": "hello",
       "timestamp": 1780000000000
     }
   }
   ```

7. Provider 使用 Redis 做消息去重，key 形如 `weibo:msg_dedup:{channel_id}:{message_id}`，TTL 5 分钟。
8. `WeiboChannelHandler.parse_message()` 构造：

   ```text
   content = payload.text
   sender_id = payload.fromUserId
   sender_name = payload.fromUserId
   conversation_id = payload.fromUserId
   conversation_type = "private"
   is_mention = false
   extra_data.weibo_user_id = payload.fromUserId
   extra_data.weibo_message_id = payload.messageId
   ```

9. `BaseChannelHandler.handle_message()` 继续处理用户解析、IM private session、命令和 Agent 消息。

## 出站数据流

微博出站分两类：命令或错误提示的一次性文本回复，以及 Agent 执行回复的流式输出。

### 一次性文本回复

`WeiboChannelHandler.send_text_reply()` 用于 `/help`、`/status`、配置错误等短回复。它调用 `WeiboSender.send_text()`，通过当前 WebSocket 发送一帧完成消息：

```json
{
  "type": "send_message",
  "payload": {
    "toUserId": "<conversation_id>",
    "text": "<reply text>",
    "messageId": "msg_<timestamp>_<random>",
    "chunkId": 0,
    "done": true
  }
}
```

### Agent 流式输出

`WeiboChannelHandler.create_streaming_emitter()` 返回 `WeiboStreamingResponseEmitter`。当 `BaseChannelHandler` 触发 Agent 响应时，现有执行链会调用 emitter 的 `emit_start()`、`emit_chunk()`、`emit_done()` 和 `emit_error()`。

流式输出使用微博 `send_message` 帧：

```json
{
  "type": "send_message",
  "payload": {
    "toUserId": "<conversation_id>",
    "text": "<delta text>",
    "messageId": "weibo_<channel_id>_<task_id>_<subtask_id>",
    "chunkId": 3,
    "done": false
  }
}
```

规则：

1. 同一次 assistant 回复使用同一个 `messageId`。
2. `chunkId` 从 0 开始递增。
3. 中间内容帧 `done = false`。
4. 最后一帧 `done = true`。如果最后没有新文本，也发送一个空文本 done marker，明确结束该消息。
5. `emit_start()` 只初始化 stream state，不发送空占位消息，避免微博侧出现无内容私信。
6. `emit_chunk()` 发送增量内容。若单个增量超过微博单帧文本限制，按固定长度拆成多个帧。
7. `emit_done(result)` 会对最终结果做差量校验：如果 `result.value` 以已发送内容为前缀，只发送剩余尾部；如果最终结果与已发送内容非单调一致，发送一条最终修正帧并记录 warning。
8. `emit_error()` 发送错误文本并用 `done = true` 结束当前流。

为兼容 device/cloud callback 事件跨进程到达的场景，`WeiboCallbackService` 负责保存 `WeiboCallbackInfo`，并在需要时通过 `ChannelManager.get_channel(channel_id)` 找到正在运行的 Weibo provider 重建 emitter。`chunkId` 使用 Redis 计数器分配，key 形如 `weibo:stream_chunk:{message_id}`，TTL 1 小时，保证同一消息跨进程也保持单调递增。

`WeiboSender` 提供两个方法：

| 方法 | 用途 |
| --- | --- |
| `send_text(to_user_id, text)` | 一次性文本回复，内部生成随机 message ID，`chunkId = 0`，`done = true` |
| `send_stream_chunk(to_user_id, text, message_id, chunk_id, done)` | Agent 流式输出，使用调用方传入的 message ID 和 chunk ID |

若 WebSocket 未连接，两个方法都返回失败并记录错误，不启用 HTTP fallback。

## 用户映射

`WeiboUserResolver` 支持三种模式：

| 模式 | 行为 |
| --- | --- |
| `select_user` | 所有微博私信映射到配置的 `target_user_id` |
| `staff_id` | 用 `fromUserId` 匹配 Wegent `user_name` |
| `email` | 若事件未来提供邮箱或可推导用户名，则匹配邮箱；v1 无邮箱时返回未找到 |

`select_user` 是后台表单默认和推荐模式，适合一个微博账号私信统一进入一个 Wegent 用户的场景。

## 连接和错误处理

### 启动失败

- 缺少 `app_id` 或 `app_secret`：provider 不启动，`last_error` 写入明确错误。
- `token_endpoint` 或 `ws_endpoint` 不是绝对 URL：provider 不启动，返回配置错误。

### Token 获取

- HTTP 408、425、429、500、502、503、504 视为可重试。
- 重试使用指数退避，最多 2 次，单次最大 8 秒。
- token 缓存提前 60 秒过期。
- WebSocket close code 为 `4002` 或 close reason 包含 `invalid token` 时清除 token 缓存。

### WebSocket 心跳和重连

- 连接成功后每 30 秒发送 `{"type": "ping"}`。
- 收到文本 `pong` 或 `{"type":"pong"}` 刷新 pong 时间。
- 超过 ping interval 加 10 秒未收到 pong，关闭连接并进入重连。
- 重连使用指数退避，初始 1 秒，最大 60 秒。只要 channel 仍启用，就持续重连。

### 入站异常

- 非 JSON 帧忽略。
- 非 `type: "message"` 事件忽略。
- 缺少 `payload.fromUserId` 或 `payload.messageId` 时记录 warning 并忽略。
- 空文本进入共享 handler，由现有逻辑回复“消息内容为空，请重新发送”。

### 出站异常

- WebSocket 未连接时，`send_text_reply()` 返回 `False` 并记录错误。
- 流式 chunk 发送失败时，emitter 记录失败并继续接收后续执行事件；如果最终 done marker 发送失败，callback service 在日志中保留 task、subtask、message ID 和 channel ID。
- Redis chunk 计数器不可用时，emitter 不降级为本地计数器，直接记录错误并停止微博流式输出，避免跨进程 chunk 顺序冲突。
- v1 不提供 HTTP fallback，避免形成双传输主路径。

## 前端管理体验

后台 IM Channel 创建弹窗新增 `Weibo` 选项。选择微博后显示：

- 名称
- Channel Type = Weibo
- App ID
- App Secret
- WebSocket Endpoint（可选，默认值作为输入提示）
- Token Endpoint（可选，默认值作为输入提示）
- 默认智能体
- 默认模型
- 用户映射模式
- 目标用户
- 是否启用

编辑微博 channel 时：

- `app_id` 可见并可修改。
- `app_secret` 输入框为空，输入提示说明留空保持不变。
- endpoint 字段显示已有值或默认值。

所有新增交互控件必须保留或新增 `data-testid`，以便后续 E2E 测试。

## 测试计划

### 后端

新增或扩展测试：

- `backend/tests/services/channels/weibo_channel/test_token.py`
  - token 请求 body 正确。
  - token 缓存命中。
  - 配置指纹变化后清除旧缓存。
  - 可重试 HTTP 状态触发重试。
- `backend/tests/services/channels/weibo_channel/test_handler.py`
  - 微博消息事件解析为 `MessageContext`。
  - 空事件或无效事件被忽略。
  - `send_text_reply()` 使用 `conversation_id` 作为 `toUserId`。
- `backend/tests/services/channels/weibo_channel/test_emitter.py`
  - `emit_chunk()` 发送同一 `messageId` 的递增 `chunkId`。
  - `emit_done()` 在已有内容后发送空 done marker。
  - `emit_done(result)` 只发送最终结果中尚未输出的尾部内容。
  - 超长 delta 被拆成多帧，且最后一帧按调用语义设置 `done`。
  - Redis chunk 计数器失败时不发送乱序 fallback chunk。
- `backend/tests/services/channels/weibo_channel/test_callback.py`
  - callback info 可以保存和恢复。
  - callback service 能通过 channel manager 重建 streaming emitter。
  - device/cloud progress 事件可以转成微博流式 chunk。
- `backend/tests/services/channels/weibo_channel/test_user_resolver.py`
  - `select_user` 成功映射。
  - `staff_id` 按 `fromUserId` 匹配用户名。
  - `email` 在无邮箱输入时返回 `None`。
- `backend/tests/services/channels/weibo_channel/test_service.py`
  - 缺配置不启动。
  - 正常启动创建客户端并注册 handler。
  - stop 关闭 WebSocket task。
- admin API 测试：
  - `weibo` 是有效 channel type。
  - 响应中 `app_secret` 脱敏。

### 前端

扩展 `frontend/src/__tests__/features/admin/components/IMChannelList.test.tsx`：

- 创建弹窗显示 Weibo 选项。
- 选择 Weibo 后展示 `app_id`、`app_secret`、`ws_endpoint`、`token_endpoint` 字段。
- 提交时 payload 包含：

  ```json
  {
    "channel_type": "weibo",
    "config": {
      "app_id": "weibo-app",
      "app_secret": "weibo-secret",
      "ws_endpoint": "ws://example.test/ws",
      "token_endpoint": "https://example.test/token",
      "user_mapping_mode": "select_user",
      "user_mapping_config": {
        "target_user_id": 20
      }
    }
  }
  ```

## 验证命令

实施完成后至少运行：

```bash
cd backend && uv run pytest tests/services/channels/weibo_channel -v
cd backend && uv run pytest tests/api/endpoints/test_admin_im_channels.py -v
pnpm --dir frontend test -- IMChannelList.test.tsx
```

如果现有 admin IM channel API 测试文件名不同，实施计划应先定位实际文件并使用项目内已有测试位置。

## 后续扩展

1. 图片和文件入站：复用 `MessageContext.images` 与 `MessageContext.files`。
2. 文件出站：参考微博 `/open/dm/send_file` HTTP API。
3. 可配置流式策略：允许管理员调整 chunk 长度、节流间隔和是否发送思考状态。
4. 通知 fanout：允许订阅通知选择微博 channel。
5. 更精细的用户绑定：增加微博用户 ID 到 Wegent 用户的显式绑定 UI。
