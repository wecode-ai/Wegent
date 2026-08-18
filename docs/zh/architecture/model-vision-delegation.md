---
sidebar_position: 30
---

# 文本模型视觉委托

范围：Wework 通过本地或云端 Codex 执行 DeepSeek V4 Pro/Flash Responses profile 时，选择视觉 profile、构造 sidecar 上游，并在主请求前把图片替换成文字描述。

```mermaid
flowchart LR
    PRIMARY[DeepSeek V4 Pro / Flash profile] --> EXPLICIT{显式视觉 profile?}
    EXPLICIT -->|本地 profile 引用| LOCAL[本地图片模型配置]
    EXPLICIT -->|云端 Model CRD 引用| CLOUD[visionSidecarModel]
    EXPLICIT -->|否，且已登录| DEFAULT[目录中的 GPT-5.6 Luna profile]
    EXPLICIT -->|否，且未登录| TEXT[保持纯文本能力]
    LOCAL --> CONFIG[Wework vision_sidecar 配置]
    CLOUD --> CONFIG
    DEFAULT --> CONFIG
    CONFIG --> CATALOG[支持图片的主模型 catalog]
    CATALOG --> EXECUTOR[Executor 本地模型代理]
    IMAGE[input_image] --> EXECUTOR
    EXECUTOR --> VISION[视觉 profile]
    VISION --> DESCRIPTION[受限文字描述]
    DESCRIPTION --> DEEPSEEK[DeepSeek 主请求]
```

```mermaid
sequenceDiagram
    participant U as 用户
    participant W as Wework
    participant G as Backend 模型网关
    participant E as Executor proxy
    participant V as 视觉 profile
    participant D as DeepSeek

    U->>W: 选择 DeepSeek profile 并附加图片
    alt 显式 sidecar 已配置
        W->>W: 保留显式本地/云端引用
    else 已登录且为 DeepSeek V4 Pro/Flash
        W->>W: 解析并绑定可用 GPT-5.6 Luna profile
    else 无可用 sidecar
        W->>W: 保持文本模型 catalog
    end
    W->>E: Responses 请求 + 隔离的 sidecar 配置
    E->>V: 非流式图片描述请求
    V-->>E: 文字描述
    E->>E: 原位移除 input_image 并插入描述
    E->>D: 仅文本主请求
    D-->>E: 主模型响应
    E-->>W: Responses 事件
    W-->>U: 模型回复
```

| 边                                 | 代码归属                                                   |
| ---------------------------------- | ---------------------------------------------------------- |
| 本地显式视觉 profile 的保存与校验  | `wework/src/features/model-settings/localModelSettings.ts` |
| 登录模型目录中的 DeepSeek 默认选择 | `wework/src/api/hybrid/hybridServices.ts`                  |
| 本地/云端显式引用的执行选项序列化  | `wework/src/features/workbench/runtimeModelSelection.ts`   |
| 本地/云端 sidecar 上游配置         | `wework/src/api/local/localServices.ts`                    |
| catalog 图片能力                   | `executor/src/server/codex_model_catalog.rs`               |
| 图片描述、缓存、限制和原位替换     | `executor/src/server/local_model_proxy/vision.rs`          |
| 代理注册与主请求转发               | `executor/src/server/local_model_proxy/mod.rs`             |
| 本地和云端桌面回归                 | `wework/e2e/desktop/modules/conversation-navigation.mjs`   |

不变量：显式视觉 profile 始终覆盖默认值；登录态默认只应用于确认的 `deepseek-v4-pro` 和 `deepseek-v4-flash` Responses 模型；默认 profile 必须从当前登录用户的云端目录按 `modelId=gpt-5.6-luna` 和声明的图片输入能力解析，优先使用公共 profile，并保留实际名称、类型、命名空间和资源所有者；未登录或目录中没有合格 Luna profile 时不得伪造云端身份或路由；只有配置有效 sidecar 的主模型才使用支持图片的 catalog，DeepSeek 专属变体继承主模型的推理、工具、上下文和输出元数据，其他模型才回退到通用 `wework-vision-sidecar`；原始图片只发送给视觉 profile，DeepSeek 主请求只能收到文字；sidecar 超时、无效图片或上游失败必须移除原图并插入明确失败描述；日志不得包含图片、密钥或提示词正文。

详细配置和限制见 [Wework 设置](../wework/settings.md)。
