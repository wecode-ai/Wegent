---
sidebar_position: 24
---

# Wework 执行环境

范围：Wework 独立管理供 Codex、Claude Code、Skills、MCP 与智能应用调用的脚本执行环境，不修改系统 PATH，也不让环境安装阻塞对话启动。

```mermaid
flowchart LR
    DESCRIPTOR[随 Wework 分发的 Runtime 描述文件] --> MANAGER[Execution Runtime Manager]
    MANAGER --> DOWNLOAD[后台下载]
    DOWNLOAD --> VERIFY[大小与 SHA-256 校验]
    VERIFY --> CACHE[(按内容指纹缓存)]
    CACHE --> CURRENT[稳定 current/bin 路径]
    CURRENT --> EXECUTOR[本地 Executor]
    CURRENT --> HARNESS[Codex / Claude Code]
    CURRENT --> DSH[DeepSeek Harness]
    SETTINGS[设置 → 执行环境] --> MANAGER
    NODE[Node.js：默认安装] --> MANAGER
    PYTHON[Python：用户手动安装] --> MANAGER
```

```mermaid
sequenceDiagram
    participant W as Wework
    participant M as Execution Runtime Manager
    participant S as 设置 → 执行环境
    participant E as Executor / Harness
    participant A as Runtime 资产服务

    W->>M: 启动后台检查
    M->>M: 读取 Node 描述文件和本地状态
    alt Node 尚未安装
        M->>A: 后台下载内容寻址资产
        A-->>M: Runtime 归档
        M->>M: 校验大小、SHA-256 与身份信息
        M->>M: 从暂存目录原子激活 current
    else Node 已安装且指纹一致
        M->>M: 直接复用
    end
    W->>E: 立即启动对话和 Executor
    E->>E: PATH 始终包含稳定 current/bin
    S->>M: 查询 Node / Python 状态
    opt 用户在系统中手动安装 Python
        S->>M: 重新检测
        M-->>S: 系统 Python 状态
    end
```

| 连线                              | 代码归属                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Runtime 描述文件与发布资产生成    | `wework/scripts/prepare-execution-runtime.mjs`、`.github/workflows/wework-app.yml`                                         |
| 下载、校验、缓存、激活与状态命令  | `wework/src-tauri/src/execution_environments.rs`                                                                           |
| Executor 与本地 Harness PATH 注入 | `wework/src-tauri/src/local_executor.rs`、`wework/src-tauri/src/local_terminal.rs`                                         |
| DeepSeek Harness 共享 Node        | `wework/src-tauri/src/harness_apps.rs`、`wework/scripts/prepare-harness-runtime.mjs`                                       |
| 设置入口与管理界面                | `wework/src/plugin-runtime/core-settings-data.tsx`、`wework/src/components/settings/ExecutionEnvironmentsSettingsPage.tsx` |

不变量：托管的 Node 环境属于 Wework 私有应用数据，不修改系统 PATH、系统 Node.js 或系统 Python；对话和 Executor 启动不得等待 Runtime 下载；所有托管 Node 子进程使用稳定的 `current/bin` 路径，Runtime 下载成功并完整校验后才能从暂存目录原子激活；失败、截断或校验不一致的下载不得污染当前可用版本；Wework 升级时内容指纹未变化的 Runtime 必须复用，不得重复下载；Node.js 默认后台安装，Python 默认不下载，只检测用户在系统中手动安装的 Python；DeepSeek Harness Runtime 不得再携带独立 Node，必须与 Codex、Claude Code 和 Skills 共享 Wework Node；更新激活失败时必须保留此前可用版本；实际调用尚未就绪的环境时必须返回可诊断错误，但不能阻塞普通对话或其他工具。
