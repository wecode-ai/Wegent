---
sidebar_position: 25
---

# DeepSeek Harness 能力应用

范围：Wework 导入本地 DeepSeek Harness 插件包，在不修改 Harness 源码的前提下，将其绑定到一个 Wework 模型并作为独立工作区标签运行。

```mermaid
flowchart LR
    ZIP[插件 ZIP] --> VALIDATE[manifest / SHA-256 / 路径 / 大小校验]
    VALIDATE --> STORE[(不可变版本目录)]
    STORE --> INSTANCE[(独立 DSH_HOME)]
    RUNTIME[Wework 管理的 DSH Runtime] --> INSTANCE
    MODEL[Wework 模型] --> PROXY[本地 Anthropic Messages 代理]
    PROXY --> INSTANCE
    INSTANCE --> PROCESS[独立进程组与端口]
    PROCESS --> TAB[Wework 原生 WebView 标签]
    STOP[停止 / 卸载 / 应用退出] --> PROCESS
```

```mermaid
sequenceDiagram
    participant U as 用户
    participant UI as HarnessAppsPage
    participant T as Tauri HarnessAppRuntime
    participant P as Wework 模型代理
    participant D as DeepSeek Harness
    participant W as 原生 WebView

    U->>UI: 选择 ZIP 和固定模型
    UI->>T: preview / install
    T->>T: 校验 manifest、哈希和版本依赖
    T->>T: 保存 package/name/version
    U->>UI: 打开能力
    UI->>P: 注册固定模型路由
    P-->>UI: base URL + token
    UI->>T: start(installation, model route)
    T->>T: 创建独立 DSH_HOME 与实例补丁
    T->>D: plugin add + profile --port
    D-->>T: HTTP ready
    T-->>UI: loopback URL
    UI->>W: 新建能力标签
    U->>UI: 停止或卸载
    UI->>T: stop
    T->>D: 终止实例进程组
    UI->>P: 注销模型路由
```

| 边 | 代码归属 |
| --- | --- |
| ZIP、manifest、版本和落盘校验 | `wework/src-tauri/src/harness_apps.rs` |
| Runtime 解析、实例目录、进程组和端口 | `wework/src-tauri/src/harness_apps.rs` |
| Wework 模型到 Anthropic Messages 代理 | `wework/src/features/local-harness/localHarnessModels.ts` |
| 安装、管理和生命周期 UI | `wework/src/pages/HarnessAppsPage.tsx` |
| 工作区标签与原生 WebView | `wework/src/App.tsx`、`wework/src/features/workspace-tabs/workspaceTabs.ts` |

不变量：DeepSeek Harness 源码保持只读；安装包必须先校验再写入不可变的 `name/version` 目录；插件声明的 DSH 版本范围必须包含实际 Runtime 版本；每个能力实例拥有独立 `DSH_HOME`、端口和进程组；模型选择在安装记录中固定，模型凭据只存在于运行期代理和子进程环境中；一个实例的启动、停止或失败不得影响其他实例；没有活动状态 API 时实例按显式生命周期常驻；停止、卸载和 Wework 退出都必须回收完整进程组；只有 HTTP 就绪后才能创建标签页。
