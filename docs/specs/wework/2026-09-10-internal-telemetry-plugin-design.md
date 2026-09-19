---
sidebar_position: 1
title: Wework 内网统计 DSH 插件设计
description: 在插件目录内实现智能工作台统计，仅用一行外部注册代码控制启动加载。
---

# Wework 内网统计 DSH 插件设计

## 文档状态

本文是 2026 年 9 月 10 日确认的“插件代码 + 一行启动注册”修订方案，只描述
设计，不包含实现。

本次开发的硬边界是：

```text
允许新增或修改插件代码：wework/dsh/internal-telemetry/**
唯一允许修改的插件外代码：
  wework/electron/src/runtime/core-dsh-runtime.ts
  仅在 CORE_HOST_BUNDLES 中新增一行条件注册
禁止新增或修改代码：除上述插件目录和这一行之外的全部路径
```

因此，本次不修改 Wework renderer、Telemetry Agent、Core DSH manager 的其他
逻辑、Backend、WeCode Gateway、构建脚本、发布脚本、CI 或现有 desktop E2E。

## 已确认的选择

采用“方案 1：插件 host 直接调用 PostHog”：

```text
Wework Telemetry Agent
  → 已有 telemetry-sink/v1 注册接口
  → internal-telemetry browser client
  → 已有 weworkPluginRuntime backend RPC
  → internal-telemetry host
  → PostHog /batch/
```

所有新增生产代码、测试、catalog 和示例配置都放在
`wework/dsh/internal-telemetry/`。插件外唯一代码改动是 Core DSH host bundle
清单中的条件注册行。

## 现有能力

本方案只消费现有接口，不修改其实现：

- internal distribution 下，`wework/src/telemetry/dispatcher.ts` 会把已注册的智能
  工作台事件交给 internal Sink；
- Sink 尚未注册时，dispatcher 最多缓冲最近 100 条事件；
- `wework/dsh/app-wework/client.js` 已提供
  `ctx.wework.telemetry.sinks.register()`；
- browser plugin 已能通过 `service.backend.scope()` 调用
  `weworkPluginRuntime`；
- 当前 envelope 已包含事件名、公共属性、`occurredAt`、`eventId`，并可包含
  `context.user` 和 `context.smartApp`；
- `context.smartApp` 中已有 key、name、version、source，所以插件可以区分用户打开
  的具体智能工作台；
- DSH host 继承 Electron 启动时的 `process.env`；
- 当前运行链路使用 Node 24，可以在插件内部使用 `node:util.parseEnv` 读取专用
  `.env` 文件。

## 目标

1. 在 `wework/dsh/` 下建设独立的内网统计插件。
2. 只消费现有 `telemetry-sink/v1` 中已经注册的智能工作台事件。
3. 通过插件自带 catalog 和逐字段投影阻止敏感信息进入 PostHog。
4. 由插件 host 从运行环境和专用 `.env` 读取 PostHog 配置。
5. 由插件 host 对当前 envelope 中的 user id 做 HMAC，生成 PostHog
   `distinct_id`。
6. 通过有界内存队列、批处理和有限重试隔离网络故障。
7. 不增加 UI、设置页、菜单、命令或业务页面埋点。
8. 所有自动化测试都位于插件目录内。
9. 内网部署显式开启时，Wework 启动自动把插件加入 Core DSH host bundle。

## 非目标

- 不修改或新增任何 Wework 页面事件。
- 不修改 Telemetry envelope。
- 不修改公共事件 catalog 或其生成器。
- 不增加 Electron capability。
- 不建设 Backend 或 WeCode Gateway。
- 不修改 Core DSH package 资源清单、自动预装、immutable 或 hidden 逻辑。
- 不修改内网 macOS、Windows 发布脚本。
- 不修改 CI 和现有 desktop E2E。
- 不实现跨设备持久化队列、服务端去重或服务端限流。
- 不调用 PostHog 管理 API，不创建或修改 PostHog Definition。

## 严格代码边界带来的能力变化

| 原设计能力                  | 本次方案                                                  |
| --------------------------- | --------------------------------------------------------- |
| Electron 注入短期用户 token | 删除，不再经过 Electron 传输                              |
| WeCode Gateway 二次校验     | 删除，由插件投影器承担唯一字段校验                        |
| 服务端身份派生              | 改为插件 host 对 envelope user id 做 HMAC                 |
| Redis 去重和限流            | 删除，仅依赖 event UUID 和 PostHog 接收行为               |
| 服务端集中停用              | 改为运行配置 `enabled=false` 或移除 project key           |
| Core DSH 启动激活           | 用 `CORE_HOST_BUNDLES` 中唯一一行条件注册保证             |
| 插件包进入发行物/profile    | 仍由部署流程在首次启动前安装，本次不修改 package 资源清单 |
| 插件 hidden/immutable       | 本次无法保证，只保证插件自身不注册 UI                     |
| 发布脚本固定 internal       | 由构建或部署流程设置，本次代码不保证                      |
| CI desktop E2E              | 不修改 CI，改为插件测试和手工安装验证                     |

这些变化是“插件目录之外只允许一行启动注册”的直接结果，不再把自动打包、自动安装
或不可卸载写成插件自身可以保证的验收条件。

## 安全风险接受

方案 1 把 PostHog project key 和身份 HMAC key 放入 Core DSH host 的运行环境或
DSH 数据目录。与原先的 Electron/Gateway 方案相比，这意味着：

- 同一 Core DSH 进程中的其他 host 插件理论上也能读取这些环境变量；
- 具备本机 DSH 数据目录读取权限的进程可以读取专用 env 文件；
- 插件直连 PostHog，缺少 Gateway 的二次字段校验、集中限流和集中停用；
- project key 轮换依赖更新客户端运行配置并重启 Core DSH。

本方案通过最小化 project 权限、独立 PostHog project、严格文件权限、字段
allowlist、日志脱敏和定期轮换降低风险，但不能达到服务端密钥隔离的强度。选择
“插件代码 + 一行启动注册”的严格边界即表示接受这一差异。

## 部署前置条件

插件只有在以下条件同时满足时才会发送数据：

1. Wework 运行于 `internal` telemetry distribution；
2. 内网部署在 Wework 首次启动前，把插件包安装进目标 `wework-core` profile；
3. Wework Electron 进程环境包含 `WEWORK_INTERNAL_TELEMETRY=1`，使唯一外部
   注册行把插件加入 host bundle；
4. profile 同时提供 `@wegent/dsh-app-wework`、
   `@wegent/dsh-plugin-runtime` 和 `@wegent/dsh-electron-host`；
5. PostHog host、project key 和 HMAC key 已通过进程环境或专用配置文件提供；
6. 运行机器可以通过 HTTPS 访问 PostHog ingestion 地址。

其中第 3 项由唯一允许的外部代码行消费；插件包的安装和 profile dependency
仍由部署流程完成。若设置了启动开关但 profile 中没有插件包，Core DSH 会引用
不存在的 bundle，因此部署流水线必须在启动前做“包已安装”门禁。

## 目录结构

```text
wework/dsh/internal-telemetry/
├── package.json
├── cordis.patch.yml
├── internal-telemetry.env.example
├── client.js
├── client.test.mjs
├── index.js
├── index.test.mjs
├── config.js
├── config.test.mjs
├── catalog.js
├── catalog.test.mjs
├── catalog/
│   └── smart-app-events.json
├── projection.js
├── projection.test.mjs
├── identity.js
├── identity.test.mjs
├── posthog-client.js
├── posthog-client.test.mjs
├── batch-queue.js
└── batch-queue.test.mjs
```

## 包与装载

### Wework 启动注册：唯一插件外代码行

已定位到 Wework 生成 `wework-core` profile host bundle 的清单：

```text
wework/electron/src/runtime/core-dsh-runtime.ts
const CORE_HOST_BUNDLES = [...]
```

在 `@wegent/dsh-transcript-sync` 后新增且只新增这一行：

```ts
...(process.env.WEWORK_INTERNAL_TELEMETRY === '1' ? ['@wegent/dsh-internal-telemetry'] : []),
```

这一行的职责只有：

- 默认或 public 启动时不改变现有 host bundle；
- 内网部署传入 `WEWORK_INTERNAL_TELEMETRY=1` 时，把统计插件加入启动 bundle；
- 每次重新生成 Core DSH profile 时恢复该 bundle 的启动激活状态。

这一行不负责：

- 把 `wework/dsh/internal-telemetry/` 拷贝进
  `wework-core-plugins` 组件；
- 把插件声明为 managed dependency；
- 修改打包脚本、资源目录映射或 lockfile；
- 保证插件 hidden、immutable 或不可卸载。

现有核心插件若要随安装包自动分发，还需要修改
`CORE_PLUGIN_PACKAGES`、`CORE_PLUGIN_DIRECTORIES` 和
`CORE_PLUGIN_TARGETS`。这些均超出“一行外部改动”边界，因此本方案明确采用
“部署流程预安装插件包，启动注册行只负责激活”的组合。

`WEWORK_INTERNAL_TELEMETRY` 是启动装载开关，与插件自身读取的
`WEWORK_INTERNAL_TELEMETRY_ENABLED` 分离。前者必须进入 Wework Electron
进程环境；后者可以来自插件专用 `.env`，用于决定插件加载后是否注册 Sink 和
发送网络请求。

### `package.json`

插件使用 DSH `0.1.1-rc.2` 现有 package 结构：

- `type: module`；
- host 入口为 `index.js`；
- browser 入口为 `client.js`；
- `dsh.bundle.patch` 指向 `cordis.patch.yml`；
- browser 注入 `@deepseek-ai/dsh-client-runtime` 和
  `@wegent/dsh-app-wework`；
- host 使用 Cordis、`weworkPluginRuntime`、现有 `weworkDesktop` 和 Node 原生
  API；
- `files` 只包含运行代码、catalog、patch 和示例配置；
- 不包含真实 `.env`、key、token 或运行日志。

插件不引入 `.env` 解析依赖，使用 Node 24 的 `node:util.parseEnv`。

### `cordis.patch.yml`

插件 bundle 只声明现有 host 依赖：

```yaml
- insert:
    - id: wework-internal-telemetry
      name: "@wegent/dsh-internal-telemetry"
      inject:
        - weworkDesktop
        - weworkPluginRuntime
```

browser client 由 package manifest 注入。插件不要求新增 Electron service。

## 配置设计

### 配置来源

插件 host 使用固定优先级：

1. DSH host 已有的 `process.env`；
2. `$DSH_HOME/config/internal-telemetry.env`；
3. 插件内的非敏感默认值。

环境变量名称：

```dotenv
WEWORK_INTERNAL_TELEMETRY_ENABLED=true
WEWORK_INTERNAL_TELEMETRY_POSTHOG_HOST=https://posthog.intra.example
WEWORK_INTERNAL_TELEMETRY_POSTHOG_PROJECT_KEY=phc_example
WEWORK_INTERNAL_TELEMETRY_IDENTITY_HMAC_KEY=replace-at-deploy-time
WEWORK_INTERNAL_TELEMETRY_RELEASE_CHANNEL=stable
WEWORK_INTERNAL_TELEMETRY_BATCH_SIZE=20
WEWORK_INTERNAL_TELEMETRY_FLUSH_INTERVAL_MS=5000
WEWORK_INTERNAL_TELEMETRY_MAX_QUEUE_SIZE=500
WEWORK_INTERNAL_TELEMETRY_REQUEST_TIMEOUT_MS=5000
```

真实配置文件位于 DSH 数据目录，不位于源码插件目录，也不打入插件包。
`internal-telemetry.env.example` 只保存无效示例值。

### 配置校验

启用发送时必须满足：

- PostHog host 是 HTTPS；
- 单元测试仅额外允许 loopback HTTP；
- URL 不包含用户名、密码、query 或 fragment；
- project key 非空；
- HMAC key 至少 32 字节；
- batch size 范围 1 至 20；
- flush interval 范围 1000 至 60000 毫秒；
- queue size 范围 20 至 500；
- timeout 范围 1000 至 30000 毫秒。

文件不存在或配置无效时，插件保持 loaded 但 disabled，不注册 Sink，不发送网络
请求。日志只记录错误分类，不打印配置对象或秘密值。

## Browser client

`client.js` 负责：

1. 创建 `wework-internal-telemetry` backend client；
2. 调用 host 的 `ready`；
3. 只有 host 返回 `{ enabled: true }` 时注册 `telemetry-sink/v1`；
4. `accept(envelope)` 异步调用 host `accept`；
5. Cordis owner 销毁时注销 Sink。

browser client 不读取 `.env`、PostHog key 或 HMAC key，不执行网络请求，不保存
队列，也不注册 UI。

host 未准备好或配置无效时，client 不注册 Sink，现有 dispatcher 继续使用启动
缓冲；统计失败不会传播到业务操作。

## Host plugin

`index.js` 组合配置、catalog、投影、身份、PostHog client 和队列，通过现有
`ctx.weworkPluginRuntime.register()` 暴露：

- `ready`：返回 enabled、协议和 catalog 版本；
- `accept`：验证 envelope，生成安全事件并入队；
- `status`：返回不含单条事件内容的聚合状态。

`accept` 入队后立即返回，不等待 PostHog。

销毁时：

1. 拒绝新事件；
2. 停止所有 timer；
3. 在最多 1 秒内尝试一次 flush；
4. 清空内存事件；
5. 注销 backend。

## 插件内 catalog

`catalog/smart-app-events.json` 固定接受当前 9 个事件：

- `smart_app_marketplace_opened`
- `smart_app_owned_opened`
- `smart_app_opened`
- `smart_app_install_succeeded`
- `smart_app_install_failed`
- `smart_app_update_succeeded`
- `smart_app_update_failed`
- `smart_app_zip_import_succeeded`
- `smart_app_zip_import_failed`

catalog 为每个事件声明：

- event schema version，首版均为 1；
- 允许的公共属性；
- enum 值；
- 是否允许 `context.smartApp`；
- 输出到 PostHog 的内部属性。

现有 envelope 没有 `eventSchemaVersion`，所以插件根据事件名读取 catalog 中的
版本，并写入 `event_schema_version`。插件不修改公共 catalog，因此存在 catalog
漂移风险；新增或改变公共事件时，需要单独升级本插件的 catalog 和版本。

## 投影与隐私

投影器逐字段构造 PostHog event，禁止：

```text
{ ...envelope }
{ ...envelope.context }
{ ...envelope.context.user }
JSON.stringify(envelope.context)
```

允许的 PostHog properties：

```text
distinct_id
$geoip_disable
domain
failure_stage
event_schema_version
app_version
platform
release_channel
smart_app_key
smart_app_name
smart_app_version
smart_app_source
```

其中：

- `domain` 和 `failure_stage` 来自 catalog 允许的公共属性；
- `event_schema_version` 从插件 catalog 读取；
- `app_version` 通过现有 `ctx.weworkDesktop.app.getVersion()` 获取；
- `platform` 从 `process.platform` 映射为 mac、win、linux；
- `release_channel` 从插件配置读取；
- 四个 smart app 字段只在 `context.smartApp` 存在且 catalog 允许时写入；
- `distinct_id` 由插件 host 生成。

永不写入：

- email、userName 或原始 user id；
- access token、PostHog key 或 HMAC key；
- session ID、device ID、installation ID；
- 路径、文件名、manifest；
- prompt、对话、文件内容；
- 原始错误、调用栈或响应正文。

## 身份设计

插件从 envelope 的 `context.user.id` 读取数字 user id，只用于本地 HMAC：

```text
digest = HMAC-SHA256(identity_hmac_key, "wework-user:" + user_id)
distinct_id = "wework:" + digest
```

原始 user id 不进入队列或 PostHog payload。email 和 userName 完全忽略。

缺少 user context 或 HMAC key 时拒绝事件，原因记为聚合计数
`identity_unavailable`。不使用随机 anonymous id，避免同一用户在每次启动时被拆成
不同用户。

## PostHog 发送

插件 host 固定调用：

```text
POST <posthog_host>/batch/
Content-Type: application/json
```

body：

```json
{
  "api_key": "runtime project key",
  "batch": [
    {
      "event": "smart_app_opened",
      "uuid": "event id from envelope",
      "timestamp": "2026-09-10T08:00:00.000Z",
      "properties": {
        "distinct_id": "wework:hmac-digest",
        "$geoip_disable": true,
        "domain": "smart_app",
        "event_schema_version": 1,
        "app_version": "1.0.0",
        "platform": "mac",
        "release_channel": "stable",
        "smart_app_key": "example",
        "smart_app_name": "Example",
        "smart_app_version": "1.0.0",
        "smart_app_source": "managed"
      }
    }
  ]
}
```

project key 只在构造网络 body 时临时读取，不进入队列或状态。日志不记录 URL
query、body、响应正文或 error object 的任意字段。

## 有界队列与重试

| 参数           | 默认值            |
| -------------- | ----------------- |
| 单批最大事件数 | 20                |
| 最大等待时间   | 5 秒              |
| 最大内存队列   | 500               |
| 单次请求超时   | 5 秒              |
| 最大重试次数   | 3                 |
| 重试间隔       | 1 秒、5 秒、30 秒 |
| 本地持久化     | 禁止              |

行为：

- 达到 batch size 立即发送；
- 第一条事件等待 flush interval 后发送；
- 队列满时丢弃最旧事件；
- 同一时间只允许一个请求在途；
- fetch 错误、超时、408、429 和 5xx 重试；
- 其他 4xx 不重试；
- 重试保持事件顺序和原始 UUID；
- 进程退出不无限等待。

没有 Gateway 和 Redis，因此无法提供跨客户端或跨进程的强去重和统一限流。event
UUID 传给 PostHog，作为接收侧可能使用的重复识别信息。

## 健康状态

`status` 只返回：

- enabled 和配置错误分类；
- 插件版本、catalog 版本；
- 队列长度；
- received、projected、rejected、dropped 计数；
- sent batches/events；
- retries 和 permanent failures；
- 最近成功、失败时间；
- 最近失败分类。

不返回单条事件、distinct id、工作台名称、URL、key 或请求 body。

## 故障隔离

| 故障                     | 行为                              |
| ------------------------ | --------------------------------- |
| 非 internal distribution | 插件不收到事件                    |
| 插件未安装               | 没有内部统计，不影响 Wework       |
| 启动开关开启但插件未安装 | 部署门禁失败，禁止发布或启动      |
| 配置文件不存在           | host disabled，client 不注册 Sink |
| 配置非法                 | host disabled，只记录错误分类     |
| host 未准备好            | client 不注册 Sink                |
| envelope 非法            | 丢弃并增加拒绝计数                |
| user context 缺失        | 丢弃并记录 identity_unavailable   |
| 队列满                   | 丢弃最旧事件                      |
| PostHog 超时或 429/5xx   | 有界重试                          |
| PostHog 其他 4xx         | 永久丢弃该批                      |
| Core DSH 重载            | 最多等待 1 秒 flush 后清理        |

所有错误都不能反向改变智能工作台安装、更新、ZIP 导入或打开结果。

## 测试策略

所有新增测试文件都放在插件目录，使用 Node `node:test`：

- config：环境优先级、`.env` 解析、URL 和秘密校验、日志脱敏；
- catalog：当前 9 个事件、属性 allowlist、smart app identity 适用范围；
- projection：合法事件、工作台区分、禁止字段和非法枚举；
- identity：HMAC 稳定性、不同用户隔离、原始身份不泄露；
- PostHog client：请求结构、超时、状态分类、秘密不进入日志；
- queue：20 条/5 秒 flush、500 条上限、单飞、重试和 dispose；
- client：ready 后注册、失败时不注册、生命周期注销；
- host：组合、立即返回、disabled 行为、聚合 status 和有界清理。

插件测试不修改现有 Wework、Electron、Backend 或 E2E 测试。

## 安装与验证

源代码完成后：

1. 在插件目录运行全部 `node --test *.test.mjs`；
2. 运行 `npm pack --dry-run`，确认不包含真实 `.env`；
3. 确认插件外 diff 只有
   `core-dsh-runtime.ts` 中约定的单行条件注册；
4. 把 tarball 安装到隔离的 DSH `wework-core` profile；
5. 向 Wework Electron 进程传入 `WEWORK_INTERNAL_TELEMETRY=1`；
6. 用 `dsh --profile wework-core --dump-config` 确认 bundle row；
7. 以 internal distribution 启动测试 Wework；
8. 打开市场、“我的工作台”和具体工作台；
9. 在测试 PostHog project 验证事件和字段；
10. 模拟缺包、disabled、超时、429 和 5xx，确认部署门禁与业务隔离符合设计。

安装 profile、设置运行环境和启动 internal distribution 是验证与部署操作，不增加
本次仓库的其他代码修改。

## 发布与运维

由于插件外只修改一行：

- 插件由仓库外的内网部署脚本、管理员或外部发行流程在首次启动前安装；
- 启动环境必须设置 `WEWORK_INTERNAL_TELEMETRY=1`，未设置时插件不会加入
  host bundle；
- internal distribution 由外部构建参数保证；
- `$DSH_HOME/config/internal-telemetry.env` 由部署系统写入；
- 关闭发送优先把插件配置 `enabled` 改为 false 或移除 project key；
- 若要卸载插件，必须同时移除启动环境中的 `WEWORK_INTERNAL_TELEMETRY=1`，
  否则启动清单会引用不存在的包；
- PostHog project key 轮换需要更新运行配置并重启 Core DSH；
- 插件可能出现在普通插件 inventory，本次无法从代码层隐藏；
- 插件可能被用户停用或卸载，本次无法从代码层阻止。

## 验收标准

- 本次所有新增生产代码和测试代码都位于
  `wework/dsh/internal-telemetry/`；
- 插件外 diff 只有
  `wework/electron/src/runtime/core-dsh-runtime.ts` 的一行条件注册；
- `WEWORK_INTERNAL_TELEMETRY=1` 且 profile 已预装插件时，Wework 启动加载该
  bundle；未设置启动开关时现有默认 bundle 不变；
- 插件使用现有 telemetry Sink、plugin runtime 和 desktop service 接口；
- 插件不注册任何 UI；
- 具体工作台事件可以按 key/name/version/source 区分；
- `.env` 只由 host 读取，browser client 看不到 key；
- PostHog key 和 HMAC key 不写入源码、catalog、队列、状态或日志；
- email、userName、原始 user id、路径、内容和原始错误不进入 PostHog；
- 队列有界、不落盘、重试有限、退出有时间上限；
- 配置或网络失败不影响 Wework 业务；
- 插件目录内单元测试和包内容检查通过；
- 不声称本次代码保证自动打包、自动预装、hidden、immutable、服务端去重、
  服务端限流或 internal 构建分流。
