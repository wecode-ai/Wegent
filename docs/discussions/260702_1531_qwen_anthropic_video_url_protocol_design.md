# Qwen Anthropic 兼容视频 URL 协议适配方案

## 背景

线上 `taskId=17042430380759` 使用模型 `ali-qwen3.6-plus-uncensored(公网)` 分析视频附件时失败。日志显示：

- 用户问题为“分析这个视频画面”，携带视频附件。
- 后端已通过视频 `fid` 成功解析出短期 `video_url`。
- 模型配置走 `model=claude`，Chat Shell 使用 Anthropic-compatible 调用链。
- 上游返回 `400 InvalidParameter: Request body format invalid`。

后续对照阿里云百炼文档后确认：Qwen 的 Anthropic 兼容 Messages 接口可以支持视频 URL，但视频块格式不是当前 Chat Shell 生成的 OpenAI-style `video_url`，而是 Anthropic-compatible 扩展格式：

```json
{
  "type": "video",
  "source": {
    "type": "url",
    "url": "https://example.com/video.mp4"
  }
}
```

因此本问题不是“Qwen Anthropic-compatible 一定不支持视频”，而是 Wegent 当前视频块转换没有按目标 provider 选择协议格式。

## 最终语义

不新增 `video_input_format` 之类的新配置字段。继续使用现有两类配置表达能力：

- `spec.modelConfig.env.model`：决定模型协议。
  - `openai` 表示 OpenAI-compatible。
  - `claude` 表示 Anthropic-compatible。
- `spec.modelCapabilities.supportsVideo`：决定是否向模型传视频 URL。

`supportsVideo=true` 同时表达两层含义：

1. 该模型具备视频理解能力。
2. 当前 provider endpoint 支持该协议下的视频输入格式。

如果某个 Claude-compatible 网关没有实现视频扩展，直接把该 Model 配置为：

```json
{
  "modelCapabilities": {
    "supportsVideo": false
  }
}
```

这样 Chat Shell 不构造视频 URL 输入，只保留视频附件 metadata 文本，避免上游 400。

## 协议映射

Chat Shell 内部统一使用中间格式，不在 backend 里提前生成 provider 专用格式：

```json
{
  "type": "input_video",
  "video_url": "https://example.com/video.mp4",
  "mime_type": "video/mp4"
}
```

进入模型前再按协议转换：

| 协议 | 条件 | 最终视频块 |
|---|---|---|
| OpenAI-compatible | `model=openai` 且 `supportsVideo=true` | `{"type":"video_url","video_url":{"url":"..."}}` |
| Anthropic-compatible | `model=claude` 且 `supportsVideo=true` | `{"type":"video","source":{"type":"url","url":"..."}}` |
| 任意协议 | `supportsVideo=false` 或未配置 | 不传视频 URL 块，只保留视频 metadata 文本 |

## 当前代码问题

当前 backend 生成 `input_video` 的位置是：

- `backend/app/services/chat/preprocessing/contexts.py`

当前 Chat Shell 转换位置是：

- `chat_shell/chat_shell/messages/converter.py`

现有逻辑会把所有 `input_video` 固定转换为：

```json
{
  "type": "video_url",
  "video_url": {
    "url": "..."
  }
}
```

这适合 OpenAI-compatible 路径，但不适合 Anthropic-compatible Qwen 视频输入。

历史恢复路径也需要注意：

- `chat_shell/chat_shell/history/loader.py`

当前历史视频附件会直接恢复成 `video_url` 块。如果后续模型切到 Anthropic-compatible，这条历史路径也会带来协议不一致。

## 实现方案

### 1. 保持 backend 输出中间格式

backend 不直接关心 OpenAI / Anthropic 目标协议。视频附件预处理仍输出：

```json
{
  "type": "input_video",
  "video_url": video_url,
  "mime_type": mime_type
}
```

backend 只负责：

- 按 `supportsVideo` 判断是否解析 `fid -> video_url`。
- 保留视频 metadata 文本。
- 在解析失败时按现有视频附件策略报错或中断。

### 2. 在 Chat Shell 增加 provider-aware 视频块适配

`MessageConverter.build_messages()` 增加目标模型上下文参数，例如：

```python
target_provider: str = ""
supports_video: bool = False
```

或直接传入 `model_config`，由 converter 内部解析：

```python
model_type = model_config.get("model")
supports_video = (
    (model_config.get("modelCapabilities") or {}).get("supportsVideo") is True
)
```

更推荐在 `ChatAgent.build_messages()` 中解析 provider 和 capabilities，再传给 converter，避免 converter 直接理解完整 Model CRD。

### 3. 修改 `input_video` 转换逻辑

转换逻辑应收敛为：

```python
elif block_type == "input_video":
    video_url = block.get("video_url", "")
    if not video_url or not supports_video:
        continue

    if target_provider == "anthropic":
        video_entries.append(
            {
                "type": "video",
                "source": {
                    "type": "url",
                    "url": video_url,
                },
            }
        )
    else:
        video_entries.append(
            {
                "type": "video_url",
                "video_url": {"url": video_url},
            }
        )
```

其中 `target_provider == "anthropic"` 来自 `model=claude` 的 provider detection。

### 4. 统一处理历史回放

历史回放不能固定恢复为 OpenAI `video_url` 后直接传给模型。

推荐做法：

1. history loader 恢复视频时也使用内部中间格式 `input_video`。
2. 进入模型前统一执行 provider-aware 转换。

这样当前轮、页面刷新后、多轮追问都走同一套协议适配，不会出现首轮可用、历史失败，或者 OpenAI 历史块传给 Anthropic provider 的问题。

如果短期改动范围需要收敛，可以先在 history loader 里按当前 `supports_video` 继续恢复视频 URL，但必须在模型调用前再做一次统一适配，确保 Anthropic provider 最终拿到 `video.source.url`。

### 5. 更新 vision 判断和 token 估算

`MessageConverter.is_vision_message()` 当前只识别 `image_url` / `video_url`。需要增加 Anthropic 视频块：

```python
part.get("type") in ("image_url", "video_url", "image", "video")
```

`chat_shell/chat_shell/compression/token_counter.py` 当前对 `video_url` 做保守估算。需要同样识别：

```json
{"type": "video", "source": {"type": "url", "url": "..."}}
```

估算策略可以沿用现有视频 URL 保守 token 估算。

### 6. 验证 LangChain Anthropic 序列化

需要验证 `langchain_anthropic.ChatAnthropic` 最终是否原样保留：

```json
{
  "type": "video",
  "source": {
    "type": "url",
    "url": "..."
  }
}
```

如果 LangChain 会过滤未知 content block，则需要进一步做一层适配：

- patch / subclass ChatAnthropic 的消息序列化；
- 或为 Anthropic-compatible Qwen endpoint 实现专用 model wrapper。

这一步必须用 payload capture 测试确认，不能只看 Wegent 内部消息结构。

## 测试计划

### 单元测试

新增或更新 `chat_shell/tests/test_messages.py`：

- `input_video + model=openai + supportsVideo=true` 转成 `video_url`。
- `input_video + model=claude + supportsVideo=true` 转成 `video.source.url`。
- `supportsVideo=false` 时不生成视频 URL 块，仍保留 metadata text。
- `is_vision_message()` 能识别 `video` 和 `video_url`。

新增或更新 `chat_shell/tests/test_history_loader.py`：

- 历史视频附件恢复为内部 `input_video`，或最终能按目标 provider 转换。
- `supportsVideo=false` 的历史视频只保留 metadata，不传视频 URL。

新增或更新 `chat_shell/tests/test_compression.py`：

- token counter 对 Anthropic `video.source.url` 使用视频 token 估算。

### 集成测试

需要捕获 Anthropic-compatible 调用最终 payload：

- 构造 `model=claude`、`supportsVideo=true` 的模型配置。
- 发送包含视频附件的问题。
- mock `ChatAnthropic` client 或上游 HTTP client。
- 断言最终 payload 中存在：

```json
{
  "type": "video",
  "source": {
    "type": "url",
    "url": "..."
  }
}
```

并断言不存在 OpenAI-style：

```json
{
  "type": "video_url",
  "video_url": {
    "url": "..."
  }
}
```

### 回归测试

- OpenAI-compatible 视频模型行为不变。
- 图片附件行为不变。
- 普通文档附件和 `read_attachment` 行为不变。
- `supportsVideo=false` 的模型不会静默传视频 URL。
- 页面刷新后继续追问历史视频，协议格式仍正确。

## 上线策略

1. 先实现 provider-aware 转换和测试，不改现有模型配置。
2. 对支持 Anthropic 视频扩展的 Qwen 模型配置 `model=claude + supportsVideo=true`。
3. 对不支持视频扩展的 Claude-compatible 网关配置 `supportsVideo=false`。
4. 通过线上日志观察：
   - Chat Shell request summary 中模型 provider。
   - 上游是否仍返回 `Request body format invalid`。
   - history replay 是否仍出现 OpenAI `video_url` 传给 Anthropic provider。

## 非目标

- 不新增 `video_input_format` 配置字段。
- 不在 backend 按 provider 生成最终协议格式。
- 不把 `model=claude` 自动等同于所有网关都支持视频；是否支持由 `supportsVideo` 声明。
- 不改变视频上传、`fid -> video_url` 获取、Weibo 文件服务链路。

## 待确认项

- `copilot.weibo.com` 的 Claude-compatible endpoint 是否支持阿里云百炼 Anthropic-compatible 视频扩展格式。
- `ChatAnthropic` 当前版本是否保留 `type=video/source=url` 内容块。
- 真实 Qwen Anthropic-compatible 视频调用是否还要求额外 header 或模型参数。
