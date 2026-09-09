---
sidebar_position: 1
title: Wework 自动统计实施计划
status: in_progress
source_spec: ../specs/2026-09-09-wework-automatic-telemetry-design.md
supersedes:
  - 2026-09-07-wework-smart-app-telemetry.md
  - 2026-09-08-smart-app-telemetry-domain.md
---

# Wework Automatic Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Use subagent-driven execution only when the user explicitly requests delegation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Wework 中建立一次启动、自动观察 Route 和 Operation 的统计 Agent，原子迁移现有智能工作台事件，并提供匿名 Public Sink、DSH Internal Sink 扩展契约和可同步 PostHog 的事件字典。

**Architecture:** 以结构化 Smart App Registry JSON 作为事件名称、路由匹配、操作定义和字典的单一来源，由生成器产生严格 TypeScript 契约和公共 catalog。Telemetry Agent 独立于公共统计同意状态运行，把规范化业务事实投影给 Public Sink 或内部发行版中的 DSH Sink；页面不直接调用 `track()`。

**Tech Stack:** Electron、Vite、React 19、TypeScript 6、Vitest、Node test runner、DeepSeek Harness/Cordis、PostHog、GitHub Actions、真实 Electron desktop E2E。

## 实施进度（2026-09-09）

| Task | 状态 | 说明 |
| --- | --- | --- |
| 1–3 | 已完成 | 事件注册源、生成 catalog、Public/Internal dispatcher 与 DSH Sink registry 已实现。 |
| 4 | 已完成 | `public` / `internal` 发行模式；内部构建隐藏公共同意 UI。 |
| 5 | 已完成 | Telemetry Agent 自动观察 Smart App route 和 Operation Bus，旧通用 route 事件不再双写。 |
| 6 | 已完成 | 市场安装、更新和 ZIP 导入已迁至统一服务边界。 |
| 7 | 已完成 | UI 直接埋点被 lint 阻止；旧 Smart App 事件类型已删除。 |
| 8 | 已完成 | 公共 catalog 可幂等同步 PostHog Event/Property Definitions；属性只更新已由真实事件创建的公共定义，工作流仅在主分支显式启用后读取密钥。 |
| 9–10 | 进行中 | 已补 Electron telemetry assertions；代理已使 Electron 下载成功，但 macOS ad-hoc `codesign` 发生系统内部错误，真实 checkpoint 尚未启动。 |

实施中做了两项澄清，优先级高于早期步骤中的泛化示例：

- 路由 `smart_app.app` 的规范事件名固定为 `smart_app_opened`，而不是
  `smart_app_app_opened`；生成器和 catalog 是唯一名称来源。
- 新生成事件先被接入类型契约，旧 Smart App 通用事件只在统一 Route/Operation 迁移完成后
  原子删除，避免中间提交既不完整又无法通过类型检查；当前迁移已完成，运行代码没有旧事件。

---

## 范围拆分

本计划只处理当前公开 Wegent 仓库中可独立完成和验证的工作：

- Wework Telemetry Agent；
- Smart App Route/Operation Registry；
- Public Sink 和字段投影；
- `ctx.wework.telemetry.sinks` 扩展契约；
- 现有智能工作台事件迁移；
- 公共事件 catalog 与 PostHog 定义同步；
- 公共和内部构建模式的 UI 行为；
- 单元测试、桌面 E2E 和真实 Electron 验证。

私有 Internal Sink 插件、企业邮箱域 allowlist、内部 Gateway 和内部 PostHog 项目位于
尚未提供给当前工作区的 GitLab 私有仓库。它们需要在该仓库可用后编写第二份独立
实施计划；本计划通过 fake Internal Sink 完整验证公共契约，不创建公开仓库中的私有
代码目录。

## Source of truth

- 设计：[Wework 自动统计与内外网分流设计](../specs/2026-09-09-wework-automatic-telemetry-design.md)
- 旧计划 `2026-09-07-wework-smart-app-telemetry.md` 和
  `2026-09-08-smart-app-telemetry-domain.md` 已废弃，不得执行。
- 首版事件固定为：

```text
smart_app_marketplace_opened
smart_app_owned_opened
smart_app_opened
smart_app_install_succeeded
smart_app_install_failed
smart_app_update_succeeded
smart_app_update_failed
smart_app_zip_import_succeeded
smart_app_zip_import_failed
```

## File structure

### 事件注册与生成

- Create `wework/src/telemetry/registry/smartAppRegistry.json`：Smart App 路由、操作、
  中英文说明和允许字段的单一来源。
- Create `wework/scripts/generate-telemetry-catalog.mjs`：验证 registry 并生成运行时类型、
  JSON catalog 和 Markdown 字典。
- Create `wework/scripts/generate-telemetry-catalog.test.mjs`：覆盖命名、冲突、缺少说明、
  未声明属性和 `--check` 漂移。
- Create `wework/src/telemetry/generated/smartAppEvents.ts`：生成的 TypeScript 事件契约。
- Create `wework/telemetry/catalog/public-events.json`：供 CI 和 PostHog 同步使用。
- Create `wework/telemetry/catalog/public-events.md`：供开发和数据分析人员评审。

### 运行时采集与分流

- Create `wework/src/telemetry/facts.ts`：规范化事实、内部上下文和 Sink v1 类型。
- Create `wework/src/telemetry/dispatcher.ts`：显式公共投影、Sink 故障隔离和内部启动队列。
- Create `wework/src/telemetry/dispatcher.test.ts`：公共隐私、内部上下文、标识隔离和故障测试。
- Create `wework/src/telemetry/operationBus.ts`：Operation 结果发布/订阅。
- Create `wework/src/telemetry/operationBus.test.ts`：一次尝试只有一个最终结果。
- Create `wework/src/telemetry/routeRegistry.ts`：解释 declarative route match 规则。
- Create `wework/src/telemetry/routeRegistry.test.ts`：覆盖市场、我的工作台和具体工作台。
- Create `wework/src/telemetry/TelemetryAgent.tsx`：启动一次并观察 Route、Operation、Sink。
- Create `wework/src/telemetry/TelemetryAgent.test.tsx`：去重、同意切换、内部启动队列。

### 现有代码迁移

- Modify `wework/src/telemetry/events.ts`：接入生成契约，删除旧 Smart App 通用事件分支。
- Modify `wework/src/telemetry/client.ts`：暴露类型安全的 Public Sink adapter，保留当前
  PostHog 初始化、队列和 `before_send`。
- Modify `wework/src/telemetry/client.test.ts`：验证新的九个事件和敏感字段过滤。
- Modify `wework/src/telemetry/config.ts`：加入 `public | internal` 发行模式。
- Create `wework/src/telemetry/config.test.ts`：验证发行模式默认值和非法值拒绝。
- Modify `wework/src/vite-env.d.ts`：声明发行模式环境变量。
- Modify `wework/src/telemetry/TelemetryBridge.tsx`：只管理 Public Sink 同意状态。
- Modify `wework/src/telemetry/TelemetryBridge.test.tsx`：内部构建不初始化 Public Sink。
- Modify `wework/src/components/settings/GeneralSettingsPage.tsx`：内部构建隐藏公共统计开关。
- Modify `wework/src/components/settings/GeneralSettingsPage.test.tsx`：验证内部 UI 不出现统计项。
- Modify `wework/src/App.tsx`：挂载 Telemetry Agent，删除旧 Smart App 路由 `track()`。
- Modify `wework/src/App.plugins.test.tsx`：从旧通用事件断言迁移到 Agent 路由断言。
- Create `wework/src/features/harness-apps/smartAppOperations.ts`：统一安装、更新、ZIP 导入
  业务边界。
- Create `wework/src/features/harness-apps/smartAppOperations.test.ts`：覆盖成功、失败阶段、取消
  和内部上下文。
- Modify `wework/dsh/ui-applications/src/SmartAppsMarketplacePage.tsx`：调用 Operation，删除六处
  Smart App `track()`。
- Modify `wework/dsh/ui-applications/src/SmartAppsMarketplacePage.test.tsx`：只保留页面交互断言。

### DSH 扩展契约

- Modify `wework/dsh/app-wework/client.js`：提供生命周期安全的 telemetry sink registry。
- Modify `wework/dsh/app-wework/client.d.ts`：公开 `telemetry-sink/v1` 类型。
- Modify `wework/dsh/app-wework/client.test.mjs`：验证注册、清理、重复 ID 和 Sink 隔离。
- Modify `wework/src/features/dsh-runtime/dshExtensions.ts`：向 React telemetry 层暴露 Sink 列表和
  订阅。
- Modify `wework/src/features/dsh-runtime/hostExtensionBoundary.test.ts`：验证扩展边界。

### CI、架构约束与桌面验证

- Create `wework/scripts/check-telemetry-boundary.mjs`：禁止 Smart App UI 直接导入 telemetry
  client。
- Create `wework/scripts/check-telemetry-boundary.test.mjs`：验证允许和禁止路径。
- Create `wework/scripts/sync-posthog-event-definitions.mjs`：幂等同步 Event/Property Definitions。
- Create `wework/scripts/sync-posthog-event-definitions.test.mjs`：使用 fake fetch 验证 create、
  update、dry-run 和失败。
- Modify `wework/package.json`：增加 catalog、同步和边界检查脚本。
- Create `.github/workflows/wework-telemetry-catalog.yml`：PR 检查生成漂移，主分支同步公共
  PostHog 项目。
- Modify `wework/e2e/desktop/modules/shared.mjs`：允许新的公共字段。
- Modify `wework/e2e/desktop/scenarios/harness-apps.scenario.mjs`：真实 Electron 断言新事件。

## Locked runtime contracts

### Registry source shape

`smartAppRegistry.json` 必须使用以下顶层结构；事件名不写入 JSON，而由生成规则产生：

```json
{
  "schemaVersion": 1,
  "domain": "smart_app",
  "owner": "wework/harness-apps",
  "routes": [],
  "operations": []
}
```

路由事件名为 `<domain>_<feature>_opened`，操作事件名为
`<domain>_<action>_succeeded|failed`。生成器是唯一允许拼接 Smart App 事件名的位置。

### Sink protocol

```ts
export const TELEMETRY_SINK_PROTOCOL = "telemetry-sink/v1" as const;

export interface WeworkTelemetrySink {
  readonly id: string;
  readonly protocol: typeof TELEMETRY_SINK_PROTOCOL;
  accept(fact: WeworkTelemetryFact): void | Promise<void>;
}
```

Internal Sink 收到的 `context` 是进程内上下文，不是公共 payload。私有插件必须显式
投影后才可发送。Public Sink 只能收到 `name` 和 allowlist 后的 `properties`。

## Tasks

### Task 1: 建立单一事件注册源和 catalog generator

**Files:**

- Create: `wework/src/telemetry/registry/smartAppRegistry.json`
- Create: `wework/scripts/generate-telemetry-catalog.mjs`
- Test: `wework/scripts/generate-telemetry-catalog.test.mjs`
- Generate: `wework/src/telemetry/generated/smartAppEvents.ts`
- Generate: `wework/telemetry/catalog/public-events.json`
- Generate: `wework/telemetry/catalog/public-events.md`
- Modify: `wework/package.json`

- [ ] **Step 1: 写 registry 验证的失败测试**

测试直接导入生成器，并确认命名来自 domain、feature/action 和 lifecycle：

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCatalog,
  validateRegistry,
} from "./generate-telemetry-catalog.mjs";

test("generates the nine approved Smart App events", () => {
  const catalog = buildCatalog(validRegistry);
  assert.deepEqual(
    catalog.events.map((event) => event.name),
    [
      "smart_app_marketplace_opened",
      "smart_app_owned_opened",
      "smart_app_opened",
      "smart_app_install_succeeded",
      "smart_app_install_failed",
      "smart_app_update_succeeded",
      "smart_app_update_failed",
      "smart_app_zip_import_succeeded",
      "smart_app_zip_import_failed",
    ],
  );
});

test("rejects a registry entry without both descriptions", () => {
  assert.throws(
    () => validateRegistry(registryWithoutEnglishDescription),
    /description\.en is required/,
  );
});
```

增加重复 key、非法 snake_case、重复生成事件名、失败阶段未声明和未知属性五个测试。

- [ ] **Step 2: 运行测试并确认失败**

```bash
node --test wework/scripts/generate-telemetry-catalog.test.mjs
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 写入完整 Smart App Registry**

路由定义必须是以下三个，不增加点击事件：

```json
{
  "key": "smart_app.marketplace",
  "feature": "marketplace",
  "name": { "zh-CN": "打开智能工作台市场", "en": "Open Smart App marketplace" },
  "description": {
    "zh-CN": "用户进入智能工作台市场入口",
    "en": "The user enters the Smart App marketplace"
  },
  "match": {
    "pathname": "/sites",
    "query": { "app_type": "smart_app" },
    "queryNot": { "view": "owned" }
  },
  "publicProperties": [
    { "name": "domain", "type": "enum", "values": ["smart_app"] }
  ]
}
```

第二个路由使用 `feature: "owned"` 和 `query.view: "owned"`；第三个路由使用
`feature: "app"` 和 `pathnamePrefix: "/app/harness-"`。

操作定义必须是 `smart_app.install`、`smart_app.update`、
`smart_app.zip_import`。安装和更新的失败阶段为：

```json
["download", "validate", "install", "confirm"]
```

ZIP 导入的失败阶段为：

```json
["preview", "validate", "install", "confirm"]
```

成功事件只有 `domain`；失败事件允许 `domain` 和 `failure_stage`。

- [ ] **Step 4: 实现 generator 的纯函数和 CLI**

生成器导出并复用以下核心函数：

```js
export function routeEventName(domain, feature) {
  return `${domain}_${feature}_opened`;
}

export function operationEventName(domain, action, outcome) {
  return `${domain}_${action}_${outcome}`;
}

export function buildCatalog(registry) {
  validateRegistry(registry);
  return {
    schemaVersion: registry.schemaVersion,
    domain: registry.domain,
    events: [
      ...registry.routes.map((route) => buildRouteEvent(registry, route)),
      ...registry.operations.flatMap((operation) => [
        buildOperationEvent(registry, operation, "succeeded"),
        buildOperationEvent(registry, operation, "failed"),
      ]),
    ],
  };
}
```

CLI 支持：

```text
node scripts/generate-telemetry-catalog.mjs
node scripts/generate-telemetry-catalog.mjs --check
```

普通模式以末尾换行的稳定 JSON/Markdown/TypeScript 写入三个目标文件；`--check` 在任何
目标与内存生成结果不一致时列出目标路径并以状态 1 退出，不修改文件。

- [ ] **Step 5: 生成严格 TypeScript 契约**

生成文件至少包含以下公开接口和常量：

```ts
export interface SmartAppGeneratedEventMap {
  smart_app_marketplace_opened: { domain: "smart_app" };
  smart_app_owned_opened: { domain: "smart_app" };
  smart_app_opened: { domain: "smart_app" };
  smart_app_install_succeeded: { domain: "smart_app" };
  smart_app_install_failed: {
    domain: "smart_app";
    failure_stage: "download" | "validate" | "install" | "confirm";
  };
  smart_app_update_succeeded: { domain: "smart_app" };
  smart_app_update_failed: {
    domain: "smart_app";
    failure_stage: "download" | "validate" | "install" | "confirm";
  };
  smart_app_zip_import_succeeded: { domain: "smart_app" };
  smart_app_zip_import_failed: {
    domain: "smart_app";
    failure_stage: "preview" | "validate" | "install" | "confirm";
  };
}
```

同时生成 `SMART_APP_EVENT_PROPERTY_KEYS`、`SMART_APP_EVENT_VALUE_CONSTRAINTS`、
`SMART_APP_ROUTE_DEFINITIONS` 和 `SMART_APP_OPERATION_DEFINITIONS`。

- [ ] **Step 6: 增加 package scripts 并验证幂等**

```json
{
  "telemetry:catalog": "node scripts/generate-telemetry-catalog.mjs",
  "telemetry:catalog:check": "node scripts/generate-telemetry-catalog.mjs --check"
}
```

Run:

```bash
pnpm --filter wework telemetry:catalog
pnpm --filter wework telemetry:catalog:check
node --test wework/scripts/generate-telemetry-catalog.test.mjs
```

Expected: 三个命令退出 0，第二次生成不改变 Git diff。

- [ ] **Step 7: 提交单一注册源**

```bash
git add wework/package.json wework/src/telemetry/registry wework/src/telemetry/generated wework/telemetry/catalog wework/scripts/generate-telemetry-catalog.mjs wework/scripts/generate-telemetry-catalog.test.mjs
git commit -m "feat(wework): generate smart app telemetry catalog"
```

### Task 2: 用生成契约替换旧 Smart App 事件形状

**Files:**

- Modify: `wework/src/telemetry/events.ts:7-240,278-590`
- Modify: `wework/src/telemetry/client.ts:379-415`
- Test: `wework/src/telemetry/client.test.ts:639-685`

- [ ] **Step 1: 先把客户端测试改成九个新事件**

使用新事件发送额外的禁止字段，证明现有运行时 allowlist 仍是最后一道边界：

```ts
track("smart_app_install_failed", {
  domain: "smart_app",
  failure_stage: "install",
  smart_app_name: "private name",
  file_path: "/private/workbench.zip",
} as AnalyticsEventMap["smart_app_install_failed"] & {
  smart_app_name: string;
  file_path: string;
});

await flushPostHogCaptures();

expect(posthogMocks.capture).toHaveBeenCalledWith(
  "smart_app_install_failed",
  expect.objectContaining({ domain: "smart_app", failure_stage: "install" }),
);
expect(posthogMocks.capture.mock.calls.at(-1)?.[1]).not.toHaveProperty(
  "smart_app_name",
);
expect(posthogMocks.capture.mock.calls.at(-1)?.[1]).not.toHaveProperty(
  "file_path",
);
```

对九个事件逐一断言名称和允许字段；非法 `failure_stage` 必须被移除或拒绝发送。

- [ ] **Step 2: 运行测试并确认失败**

```bash
pnpm --filter wework test src/telemetry/client.test.ts
```

Expected: FAIL，新事件不在 `AnalyticsEventMap`。

- [ ] **Step 3: 合并生成事件 map 和 allowlist**

在 `events.ts` 中导入生成物：

```ts
import {
  SMART_APP_EVENT_PROPERTY_KEYS,
  SMART_APP_EVENT_VALUE_CONSTRAINTS,
  type SmartAppGeneratedEventMap,
} from "./generated/smartAppEvents";

export interface AnalyticsEventMap extends SmartAppGeneratedEventMap {
  account_signed_in: ExistingAccountSignedInProperties;
  feature_opened: ExistingNonSmartAppFeatureOpenedProperties;
}
```

上面的两个类型名代表迁移时从当前接口中提取并原样保留的实际非 Smart App 属性类型；
实现时必须使用仓库中的最终类型名，并逐项保留其余现有事件，不允许用空接口或索引签名
代替。

在属性和约束对象中展开生成常量：

```ts
export const ANALYTICS_EVENT_PROPERTY_KEYS = {
  account_signed_in: existingAccountSignedInPropertyKeys,
  feature_opened: existingNonSmartAppFeatureOpenedPropertyKeys,
  ...SMART_APP_EVENT_PROPERTY_KEYS,
} satisfies {
  [EventName in AnalyticsEventName]: ReadonlyArray<
    keyof AnalyticsEventMap[EventName]
  >;
};
```

删除 `smart_app_installed`，并从 `feature_opened`、`feature_action_completed` 和
`operation_failed` 中删除所有 Smart App 专属枚举与可选 domain。其他 Wework 事件保持
原样。

- [ ] **Step 4: 增加类型安全的事件对象入口**

在 `events.ts` 增加相关联合类型：

```ts
export type AnalyticsEvent = {
  [Name in AnalyticsEventName]: {
    readonly name: Name;
    readonly properties: AnalyticsEventMap[Name];
  };
}[AnalyticsEventName];
```

在 `client.ts` 增加 adapter，内部继续走原有 `track()`：

```ts
export function trackEvent<Name extends AnalyticsEventName>(event: {
  readonly name: Name;
  readonly properties: AnalyticsEventMap[Name];
}): void {
  track(event.name, event.properties);
}
```

- [ ] **Step 5: 运行 focused tests、typecheck 和格式检查**

```bash
pnpm --filter wework test src/telemetry/client.test.ts
pnpm --filter wework typecheck
pnpm --filter wework exec prettier --check src/telemetry/events.ts src/telemetry/client.ts src/telemetry/client.test.ts
```

Expected: 全部通过，旧 Smart App 事件名在运行契约中不存在。

- [ ] **Step 6: 提交新契约**

```bash
git add wework/src/telemetry/events.ts wework/src/telemetry/client.ts wework/src/telemetry/client.test.ts
git commit -m "refactor(wework): adopt generated smart app events"
```

### Task 3: 建立 Sink v1、显式投影和 DSH 注册接口

**Files:**

- Create: `wework/src/telemetry/facts.ts`
- Create: `wework/src/telemetry/dispatcher.ts`
- Test: `wework/src/telemetry/dispatcher.test.ts`
- Modify: `wework/dsh/app-wework/client.js:178-231,340-752,955-970`
- Modify: `wework/dsh/app-wework/client.d.ts:192-375`
- Test: `wework/dsh/app-wework/client.test.mjs:330-490`
- Modify: `wework/src/features/dsh-runtime/dshExtensions.ts`
- Test: `wework/src/features/dsh-runtime/hostExtensionBoundary.test.ts`

- [ ] **Step 1: 写 dispatcher 隐私和故障隔离失败测试**

```ts
test("projects public fields and does not forward internal context", async () => {
  const publicSink = vi.fn();
  const internalSink = vi.fn();
  const dispatcher = createTelemetryDispatcher({
    distribution: "public",
    publicSink: { id: "public", accept: publicSink },
    internalSinks: () => [
      { id: "internal", protocol: "telemetry-sink/v1", accept: internalSink },
    ],
  });

  dispatcher.publish({
    name: "smart_app_opened",
    properties: { domain: "smart_app" },
    context: {
      user: {
        id: 7,
        userName: "zhongyang",
        email: "zhongyang@example.invalid",
      },
      smartApp: {
        key: "research",
        name: "Research",
        version: "1.0.0",
        source: "market",
      },
    },
  });

  await flushPromises();
  expect(publicSink).toHaveBeenCalledWith({
    name: "smart_app_opened",
    properties: { domain: "smart_app" },
  });
  expect(internalSink).not.toHaveBeenCalled();
});

test("does not throw when one internal sink rejects", async () => {
  const recordingSink = vi.fn();
  const dispatcher = createTelemetryDispatcher({
    distribution: "internal",
    publicSink: null,
    internalSinks: () => [
      {
        id: "rejecting",
        protocol: "telemetry-sink/v1",
        accept: () => Promise.reject(new Error("sink unavailable")),
      },
      { id: "recording", protocol: "telemetry-sink/v1", accept: recordingSink },
    ],
  });
  const fact = smartAppFact("smart_app_owned_opened");

  expect(() => dispatcher.publish(fact)).not.toThrow();
  await flushPromises();

  expect(recordingSink).toHaveBeenCalledOnce();
  expect(recordingSink).toHaveBeenCalledWith(
    expect.objectContaining({ name: fact.name }),
  );
});
```

再覆盖内部模式不调用 Public Sink、无 Sink 时最多缓存 100 条、Sink 注册后 flush、不同
Sink 收到不同 envelope event id。

- [ ] **Step 2: 运行 dispatcher 测试并确认失败**

```bash
pnpm --filter wework test src/telemetry/dispatcher.test.ts
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 定义规范化事实和 Sink v1**

```ts
export const TELEMETRY_SINK_PROTOCOL = "telemetry-sink/v1" as const;

export interface SmartAppIdentityContext {
  readonly key: string;
  readonly name: string;
  readonly version: string;
  readonly source: "managed" | "linked" | "market";
}

export interface TelemetryUserContext {
  readonly id: number;
  readonly userName: string;
  readonly email: string;
}

export interface WeworkTelemetryContext {
  readonly smartApp?: SmartAppIdentityContext;
  readonly user?: TelemetryUserContext;
}

export type WeworkTelemetryFact = SmartAppTelemetryEvent & {
  readonly occurredAt: string;
  readonly context?: WeworkTelemetryContext;
};
```

`SmartAppTelemetryEvent` 从生成的事件 map 构造为判别联合。不要把 context 合并进
`properties`。

- [ ] **Step 4: 实现显式分流和有界启动队列**

Dispatcher 使用以下规则：

```ts
const MAX_STARTUP_EVENTS = 100;

function publicProjection(fact: WeworkTelemetryFact): AnalyticsEvent {
  const allowedKeys = SMART_APP_EVENT_PROPERTY_KEYS[fact.name];
  const properties = Object.fromEntries(
    allowedKeys.flatMap((key) =>
      fact.properties[key] === undefined ? [] : [[key, fact.properties[key]]],
    ),
  );
  return { name: fact.name, properties } as AnalyticsEvent;
}

function acceptIsolated(
  sink: WeworkTelemetrySink,
  fact: WeworkTelemetryFact,
): void {
  const envelope = { ...fact, eventId: crypto.randomUUID() };
  void Promise.resolve(sink.accept(envelope)).catch(() => undefined);
}
```

`publicProjection` 必须按生成的 key 列表重新构建对象，不得透传原始 properties，也不得
展开 `fact.context`。
内部模式无 Sink 时缓存最后 100 条规范化事实，Sink 就绪后按顺序 flush；公共模式不把
事件送给 DSH Sink。

- [ ] **Step 5: 为 `ctx.wework.telemetry.sinks` 写失败测试**

```js
test("registers telemetry sinks with Cordis lifecycle cleanup", async () => {
  const client = await loadClient();
  const runtime = client.exports.createExtensionRuntime();
  const cleanups = [];
  const owner = { effect: (factory) => cleanups.push(factory()) };
  const sink = {
    id: "internal",
    protocol: "telemetry-sink/v1",
    accept() {},
  };

  runtime.service.telemetry.sinks.register(owner, sink);
  assert.equal(runtime.service.telemetry.sinks.list()[0], sink);
  for (const cleanup of cleanups.reverse()) cleanup();
  assert.equal(runtime.service.telemetry.sinks.list().length, 0);
});
```

增加错误协议、缺少 `accept()`、重复 ID 和 disposal 后调用的测试。

- [ ] **Step 6: 实现 DSH Sink Registry 和声明文件**

在 `client.js` 复用 `createProviderRegistry`，要求 `accept` 方法，并为 Sink 变化维护独立
listeners：

```js
const telemetrySinkListeners = new Set()
const notifyTelemetrySinks = () => {
  notify()
  for (const listener of [...telemetrySinkListeners]) listener()
}
const telemetrySinks = createProviderRegistry(
  'telemetry-sink',
  ['accept'],
  notifyTelemetrySinks
)

telemetry: Object.freeze({
  sinks: Object.freeze({
    register: telemetrySinks.register,
    get: telemetrySinks.get,
    list: telemetrySinks.list,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function')
      telemetrySinkListeners.add(listener)
      return () => telemetrySinkListeners.delete(listener)
    },
  }),
}),
```

不要把所有 Wework extension revision 变化都当成 Sink 变化。`dispose()` 必须清空 Sink
和 `telemetrySinkListeners`；对应测试必须证明 dispose 后 list 为空且旧 listener 不再收到
通知。

在 `client.d.ts` 定义 `WeworkTelemetrySink`、`WeworkTelemetrySinkRegistry`、
`WeworkTelemetryService`，并将 `telemetry` 加入 `WeworkService` 和
`WeworkExtensionHost`。

- [ ] **Step 7: 暴露 React adapter 并运行全部 focused tests**

在 `dshExtensions.ts` 增加：

```ts
export function getDshTelemetrySinks(): readonly WeworkTelemetrySink[] {
  return getDshExtensionHost()?.telemetry.sinks.list() ?? [];
}

export function subscribeDshTelemetrySinks(listener: () => void): () => void {
  return (
    getDshExtensionHost()?.telemetry.sinks.subscribe(listener) ?? (() => {})
  );
}
```

Run:

```bash
node --test wework/dsh/app-wework/client.test.mjs
pnpm --filter wework test src/telemetry/dispatcher.test.ts src/features/dsh-runtime/hostExtensionBoundary.test.ts
pnpm --filter wework typecheck
```

Expected: 全部通过。

- [ ] **Step 8: 提交 Sink 契约**

```bash
git add wework/src/telemetry/facts.ts wework/src/telemetry/dispatcher.ts wework/src/telemetry/dispatcher.test.ts wework/dsh/app-wework/client.js wework/dsh/app-wework/client.d.ts wework/dsh/app-wework/client.test.mjs wework/src/features/dsh-runtime/dshExtensions.ts wework/src/features/dsh-runtime/hostExtensionBoundary.test.ts
git commit -m "feat(wework): add telemetry sink registry"
```

### Task 4: 区分公共和内部发行模式并隐藏内部 UI

**Files:**

- Modify: `wework/src/vite-env.d.ts`
- Modify: `wework/src/telemetry/config.ts`
- Create: `wework/src/telemetry/config.test.ts`
- Modify: `wework/src/telemetry/TelemetryBridge.tsx`
- Modify: `wework/src/telemetry/TelemetryBridge.test.tsx`
- Modify: `wework/src/components/settings/GeneralSettingsPage.tsx:898-910`
- Modify: `wework/src/components/settings/GeneralSettingsPage.test.tsx:480-525`

- [ ] **Step 1: 写发行模式失败测试**

```ts
test("defaults to the public telemetry distribution", () => {
  expect(getTelemetryConfig().distribution).toBe("public");
});

test("selects internal distribution from the build environment", () => {
  vi.stubEnv("VITE_WEWORK_TELEMETRY_DISTRIBUTION", "internal");
  expect(getTelemetryConfig().distribution).toBe("internal");
});

test("rejects an unsupported distribution value", () => {
  vi.stubEnv("VITE_WEWORK_TELEMETRY_DISTRIBUTION", "private-ish");
  expect(() => getTelemetryConfig()).toThrow(/telemetry distribution/i);
});
```

- [ ] **Step 2: 运行测试并确认失败**

```bash
pnpm --filter wework test src/telemetry/config.test.ts
```

Expected: FAIL，`distribution` 尚不存在。

- [ ] **Step 3: 增加严格构建配置**

```ts
export type TelemetryDistribution = "public" | "internal";

function telemetryDistribution(value: string): TelemetryDistribution {
  if (!value || value === "public") return "public";
  if (value === "internal") return "internal";
  throw new Error(`Unsupported telemetry distribution: ${value}`);
}
```

将 `distribution` 加入 `TelemetryConfig`，来源为
`VITE_WEWORK_TELEMETRY_DISTRIBUTION`。在 `vite-env.d.ts` 声明该变量。

- [ ] **Step 4: 写内部构建 UI 失败测试**

TelemetryBridge 测试断言 internal 模式下 `installTelemetry` 只以 `false` 调用、不渲染
consent dialog。General Settings 测试断言：

```ts
expect(
  screen.queryByTestId("general-settings-privacy-section"),
).not.toBeInTheDocument();
expect(
  screen.queryByTestId("general-telemetry-toggle"),
).not.toBeInTheDocument();
expect(
  screen.queryByText(/内部使用统计|发送位置|工作台名称/),
).not.toBeInTheDocument();
```

- [ ] **Step 5: 实现 Public Sink 专属 consent 和设置项**

`TelemetryBridge` 在 internal 模式下关闭当前 PostHog client 并返回 `null`；它不控制
Telemetry Agent 或 DSH Internal Sink。General Settings 使用：

```tsx
{
  telemetryDistribution === "public" ? (
    <section data-testid="general-settings-privacy-section" className="mt-12">
      {/* Existing anonymous telemetry toggle remains unchanged. */}
    </section>
  ) : null;
}
```

不要新增内部统计状态、字段、地址或插件提示文案。

- [ ] **Step 6: 运行 focused tests 和 typecheck**

```bash
pnpm --filter wework test src/telemetry/config.test.ts src/telemetry/TelemetryBridge.test.tsx src/components/settings/GeneralSettingsPage.test.tsx
pnpm --filter wework typecheck
```

Expected: 公共 consent 行为保持不变，内部构建不出现相关 UI。

- [ ] **Step 7: 提交发行模式**

```bash
git add wework/src/vite-env.d.ts wework/src/telemetry/config.ts wework/src/telemetry/config.test.ts wework/src/telemetry/TelemetryBridge.tsx wework/src/telemetry/TelemetryBridge.test.tsx wework/src/components/settings/GeneralSettingsPage.tsx wework/src/components/settings/GeneralSettingsPage.test.tsx
git commit -m "feat(wework): separate telemetry distributions"
```

### Task 5: 启动 Telemetry Agent 并自动采集路由

**Files:**

- Create: `wework/src/telemetry/routeRegistry.ts`
- Test: `wework/src/telemetry/routeRegistry.test.ts`
- Create: `wework/src/telemetry/operationBus.ts`
- Test: `wework/src/telemetry/operationBus.test.ts`
- Create: `wework/src/telemetry/TelemetryAgent.tsx`
- Test: `wework/src/telemetry/TelemetryAgent.test.tsx`
- Modify: `wework/src/features/harness-apps/harnessAppTabs.ts`
- Modify: `wework/src/App.tsx:571-581,704-723`
- Modify: `wework/src/App.plugins.test.tsx:1093-1153`

- [ ] **Step 1: 写 declarative route resolver 失败测试**

```ts
test.each([
  ["/sites", "?app_type=smart_app", "smart_app_marketplace_opened"],
  ["/sites", "?app_type=smart_app&view=owned", "smart_app_owned_opened"],
  ["/app/harness-research-desk", "", "smart_app_opened"],
  ["/sites", "?app_type=web", null],
])("resolves %s%s", (pathname, search, expected) => {
  expect(resolveTelemetryRoute(pathname, search)?.eventName ?? null).toBe(
    expected,
  );
});
```

增加 query 顺序不同、无关 query 变化和 `/app/native-task` 不匹配的测试。

- [ ] **Step 2: 写 Operation Bus 最终结果测试**

```ts
test("publishes only the first terminal result for an attempt", () => {
  const events: unknown[] = [];
  const unsubscribe = subscribeOperationResults((event) => events.push(event));
  const attempt = beginOperation("smart_app.install");
  attempt.succeed({ smartApp: installedContext });
  attempt.fail("install", { smartApp: installedContext });
  expect(events).toHaveLength(1);
  unsubscribe();
});
```

取消的 attempt 不发布成功或失败；未知 operation key 直接抛错。

- [ ] **Step 3: 实现 Route Registry 和 Operation Bus**

Route Registry 读取生成的 `SMART_APP_ROUTE_DEFINITIONS`，按数组顺序匹配 pathname、
pathnamePrefix、query 和 queryNot。返回值包含生成事件名和 `domain: 'smart_app'`。

Operation Bus 使用模块内 listener set 和 attempt terminal flag：

```ts
export function beginOperation(key: SmartAppOperationKey): OperationAttempt {
  let completed = false;
  const finish = (outcome: OperationOutcome, detail: OperationResultDetail) => {
    if (completed) return false;
    completed = true;
    publish({ key, outcome, ...detail });
    return true;
  };
  return {
    succeed: (detail) => finish("succeeded", detail),
    fail: (failureStage, detail) =>
      finish("failed", { ...detail, failureStage }),
    cancel: () => {
      completed = true;
    },
  };
}
```

- [ ] **Step 4: 写 Telemetry Agent 失败测试**

测试挂载 Agent 后执行真实 `history.pushState` + `popstate`：

```ts
test('automatically publishes distinct Smart App route events once', async () => {
  window.history.replaceState({}, '', '/sites?app_type=smart_app')
  render(<TelemetryAgent />)
  await waitFor(() => expect(dispatchMock).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'smart_app_marketplace_opened' })
  ))
  window.dispatchEvent(new PopStateEvent('popstate'))
  expect(dispatchMock).toHaveBeenCalledTimes(1)
})
```

再覆盖 owned 路由、具体 app 路由、Operation 成功/失败转换、StrictMode 双 effect 去重、
internal Sink 晚注册后 flush 和一个 Sink reject 不阻塞其他 Sink。还必须覆盖：

- `useAuth().isLoading` 为 true 时不发布首个 route；变为 false 后只发布一次，并携带已加载
  的 internal user context；
- public 统计从 disabled 切换为 enabled 时，当前匹配 route 补发一次；后续重复 render 不
  再发送；
- internal 构建不依赖 public consent，且 consent 变化不会造成内部事件重复。

- [ ] **Step 5: 实现并挂载 Agent**

Agent 必须：

1. 独立监听 `popstate`；
2. 使用 `pathname + search` 的规范化 route key 去重；
3. 订阅 Operation Bus；
4. 订阅 DSH Sink Registry；
5. 使用 `useAuth()` 提供进程内用户上下文；
6. 等待 `useAuth().isLoading === false` 后才采集首个 route，避免先发缺少用户的内部事件；
7. 仅在 internal 构建向 DSH Sink 提供 context；
8. 观察 Public Sink disabled → enabled，并为当前 route 补发一次；
9. 不监听页面 DOM。

在 `harnessAppTabs.ts` 增加只读安装解析函数：

```ts
export function resolveRunningHarnessAppInstallation(
  key: string,
): HarnessAppInstallation | null {
  if (!key.startsWith("harness-")) return null;
  return runningApps.get(key.slice("harness-".length)) ?? null;
}
```

在 `MainApp` 的 `AuthProvider` 内挂载：

```tsx
<AuthProvider>
  <TelemetryBridge />
  <TelemetryAgent />
  <AppShell />
</AuthProvider>
```

删除 `AppShell` 中原有 Smart App `feature_opened` effect。通用非 Smart App
`feature_opened` 如仍有产品需求，暂时保留在独立 legacy helper 中，不得再次发送 Smart
App route。

- [ ] **Step 6: 迁移路由测试并运行**

```bash
pnpm --filter wework test src/telemetry/routeRegistry.test.ts src/telemetry/operationBus.test.ts src/telemetry/TelemetryAgent.test.tsx src/App.plugins.test.tsx
pnpm --filter wework typecheck
```

Expected: 九个事件中的三个 route event 由 Agent 自动产生，旧 Smart App
`feature_opened` 不再出现。

- [ ] **Step 7: 提交 Agent 和 Route Registry**

```bash
git add wework/src/telemetry/routeRegistry.ts wework/src/telemetry/routeRegistry.test.ts wework/src/telemetry/operationBus.ts wework/src/telemetry/operationBus.test.ts wework/src/telemetry/TelemetryAgent.tsx wework/src/telemetry/TelemetryAgent.test.tsx wework/src/features/harness-apps/harnessAppTabs.ts wework/src/App.tsx wework/src/App.plugins.test.tsx
git commit -m "feat(wework): observe smart app routes automatically"
```

### Task 6: 迁移安装、更新和 ZIP 导入到统一 Operation

**Files:**

- Create: `wework/src/features/harness-apps/smartAppOperations.ts`
- Test: `wework/src/features/harness-apps/smartAppOperations.test.ts`
- Modify: `wework/dsh/ui-applications/src/SmartAppsMarketplacePage.tsx:469-546,677-710`
- Modify: `wework/dsh/ui-applications/src/SmartAppsMarketplacePage.test.tsx:303-489`

- [ ] **Step 1: 写 Marketplace Operation 失败测试**

```ts
test("reports install success only after the local installation is confirmed", async () => {
  const prepared = marketplacePreparation({ intent: "install" });
  installMock.mockResolvedValue(installed);
  const results: OperationResult[] = [];
  const unsubscribe = subscribeOperationResults((result) =>
    results.push(result),
  );

  await installMarketplaceSmartApp(prepared, "model-1");

  expect(results).toEqual([
    expect.objectContaining({ key: "smart_app.install", outcome: "succeeded" }),
  ]);
  expect(notifyMock.mock.invocationCallOrder[0]).toBeLessThan(
    operationResultListener.mock.invocationCallOrder[0],
  );
  unsubscribe();
});
```

分别覆盖 download、validate、install、confirm 失败；更新必须使用
`smart_app.update`，不能产生 install success。

- [ ] **Step 2: 写 ZIP Operation 失败测试**

```ts
test("maps an invalid ZIP preview to validate failure without leaking details", async () => {
  previewMock.mockResolvedValue({
    valid: false,
    manifest: null,
    archivePath: "/private/a.zip",
    sha256: "a".repeat(64),
    issues: ["private validation detail"],
  });

  await expect(importSmartAppPackage("/private/a.zip")).rejects.toThrow();
  expect(operationResults).toEqual([
    {
      key: "smart_app.zip_import",
      outcome: "failed",
      failureStage: "validate",
      context: undefined,
    },
  ]);
});
```

选择器取消仍由页面直接 return，不调用 `importSmartAppPackage()`，因此不产生事件。

- [ ] **Step 3: 运行测试并确认失败**

```bash
pnpm --filter wework test src/features/harness-apps/smartAppOperations.test.ts
```

Expected: FAIL，Operation service 不存在。

- [ ] **Step 4: 实现 Marketplace preparation/install/update**

公开 service API 固定为：

```ts
export interface MarketplaceSmartAppPreparation {
  readonly intent: "install" | "update";
  readonly item: SmartAppMarketplaceItem;
  readonly preview: HarnessAppPreview;
}

export async function prepareMarketplaceSmartApp(
  api: SmartAppsApi,
  item: SmartAppMarketplaceItem,
  intent: MarketplaceSmartAppPreparation["intent"],
): Promise<MarketplaceSmartAppPreparation>;

export async function installMarketplaceSmartApp(
  preparation: MarketplaceSmartAppPreparation,
  modelKey: string,
): Promise<HarnessAppInstallation>;

export async function importSmartAppPackage(
  path: string,
): Promise<HarnessAppInstallation>;
```

`prepareMarketplaceSmartApp` 下载失败时创建相应 install/update attempt 并以 `download`
结束；下载成功不发送事件。`installMarketplaceSmartApp` 根据保留的 intent 启动 attempt，
调用 `harnessAppsApi.install`、发送安装变更通知，随后成功；异常按 `install` 或 `confirm`
失败。`importSmartAppPackage` 内部完整执行 preview、validate、install、confirm。

构造内部 context 时只创建进程内对象：

```ts
function smartAppContext(
  installation: HarnessAppInstallation,
): SmartAppIdentityContext {
  return {
    key: installation.manifest.name,
    name: installation.manifest.displayName,
    version: installation.manifest.version,
    source: installation.source,
  };
}
```

不得把 `packagePath`、archivePath、sha256、issues 或 error 放入结果 detail。

- [ ] **Step 5: 页面改为调用语义 service**

删除 `import { track } from '@/telemetry/client'` 以及全部六处 Smart App `track()`。
`download()` 调用 `prepareMarketplaceSmartApp()`；`install()` 调用
`installMarketplaceSmartApp()`；`importCreatedPackage()` 调用
`importSmartAppPackage()`。页面继续负责 busy、dialog、refresh 和用户可见错误。

- [ ] **Step 6: 将页面测试从 track mock 改为 service mock**

删除：

```ts
vi.mock("@/telemetry/client", () => ({ track: trackMock }));
```

改为 mock `smartAppOperations`，断言安装和导入入口传入正确 intent/path；成功、失败阶段
和隐私断言由 `smartAppOperations.test.ts` 与 `TelemetryAgent.test.tsx` 承担。

- [ ] **Step 7: 运行 focused tests**

```bash
pnpm --filter wework test src/features/harness-apps/smartAppOperations.test.ts dsh/ui-applications/src/SmartAppsMarketplacePage.test.tsx src/telemetry/TelemetryAgent.test.tsx
pnpm --filter wework typecheck
```

Expected: 全部通过，页面源码不再导入 telemetry client。

- [ ] **Step 8: 提交 Operation 迁移**

```bash
git add wework/src/features/harness-apps/smartAppOperations.ts wework/src/features/harness-apps/smartAppOperations.test.ts wework/dsh/ui-applications/src/SmartAppsMarketplacePage.tsx wework/dsh/ui-applications/src/SmartAppsMarketplacePage.test.tsx
git commit -m "refactor(wework): centralize smart app operations"
```

### Task 7: 加入架构约束并确认旧事件彻底退出

**Files:**

- Create: `wework/scripts/check-telemetry-boundary.mjs`
- Test: `wework/scripts/check-telemetry-boundary.test.mjs`
- Modify: `wework/package.json`
- Verify: `wework/src/telemetry/events.ts`
- Verify: `wework/src/App.tsx`
- Verify: `wework/dsh/ui-applications/src/SmartAppsMarketplacePage.tsx`

- [ ] **Step 1: 写边界检查失败测试**

```js
test("rejects direct telemetry imports in Smart App UI", () => {
  assert.deepEqual(
    findForbiddenTelemetryImports({
      "dsh/ui-applications/src/SmartAppsMarketplacePage.tsx":
        "import { track } from '@/telemetry/client'",
    }),
    ["dsh/ui-applications/src/SmartAppsMarketplacePage.tsx"],
  );
});

test("allows telemetry infrastructure and operation result publication", () => {
  assert.deepEqual(
    findForbiddenTelemetryImports({
      "src/telemetry/TelemetryAgent.tsx":
        "import { trackEvent } from './client'",
      "src/features/harness-apps/smartAppOperations.ts":
        "import { beginOperation } from '@/telemetry/operationBus'",
    }),
    [],
  );
});
```

- [ ] **Step 2: 实现并接入 lint**

脚本扫描：

```text
wework/src/features/harness-apps/**/*.{ts,tsx}
wework/dsh/ui-applications/src/**/*.{ts,tsx}
```

禁止导入 `@/telemetry/client`、调用 `track(` 或 `posthog.capture(`；只允许
`smartAppOperations.ts` 导入 `@/telemetry/operationBus`。在 package scripts 增加：

```json
{
  "lint:telemetry-boundary": "node scripts/check-telemetry-boundary.mjs",
  "lint": "eslint . && pnpm run lint:typography && pnpm run lint:task-lifecycle && pnpm run lint:telemetry-boundary"
}
```

- [ ] **Step 3: 运行边界检查和旧名称扫描**

```bash
node --test wework/scripts/check-telemetry-boundary.test.mjs
pnpm --filter wework lint:telemetry-boundary
rg -n "smart_app_installed|smart_app_marketplace_download|smart_app_marketplace_install|smart_app_marketplace_update|smart_app_zip_import" wework/src wework/dsh --glob '!**/*.md'
```

Expected: 测试和脚本退出 0；`rg` 只允许在迁移测试 fixture 或 deprecated catalog metadata
中出现旧名，不得在运行代码出现。

- [ ] **Step 4: 运行完整 Smart App/telemetry unit suite**

```bash
pnpm --filter wework test src/telemetry src/features/harness-apps dsh/ui-applications/src/SmartAppsMarketplacePage.test.tsx src/App.plugins.test.tsx
pnpm --filter wework typecheck
pnpm --filter wework lint
```

Expected: 初始 collection 只包含指定目录/文件，全部测试、typecheck 和 lint 通过。

- [ ] **Step 5: 提交架构约束**

```bash
git add wework/scripts/check-telemetry-boundary.mjs wework/scripts/check-telemetry-boundary.test.mjs wework/package.json
git commit -m "test(wework): enforce telemetry boundaries"
```

### Task 8: 幂等同步公共 PostHog Event/Property Definitions

实现依据为 PostHog 当前官方
[Event definitions API](https://posthog.com/docs/api/event-definitions)、
[Property definitions API](https://posthog.com/docs/api/property-definitions) 和
[API authentication guide](https://posthog.com/docs/api)。如果实施时官方契约发生变化，先
更新本计划和 fake-fetch 测试，再改同步脚本。

**Files:**

- Create: `wework/scripts/sync-posthog-event-definitions.mjs`
- Test: `wework/scripts/sync-posthog-event-definitions.test.mjs`
- Modify: `wework/package.json`
- Create: `.github/workflows/wework-telemetry-catalog.yml`

- [x] **Step 1: 写 fake fetch 同步失败测试**

```js
test("creates missing event definitions and updates existing descriptions", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (!options.method) return response({ results: existingDefinitions });
    return response({ id: "definition-id" });
  };

  await syncEventDefinitions({
    apiKey: "test-key",
    catalog,
    fetchImpl,
    host: "https://posthog.example",
    projectId: "12",
  });

  assert.ok(requests.some((request) => request.options.method === "POST"));
  assert.ok(requests.some((request) => request.options.method === "PATCH"));
});
```

增加 dry-run 不写、401 失败、分页、重复运行不更新、属性尚未出现时跳过并报告的测试。

- [x] **Step 2: 运行测试并确认失败**

```bash
node --test wework/scripts/sync-posthog-event-definitions.test.mjs
```

Expected: FAIL，模块不存在。

- [x] **Step 3: 实现 Event Definition 同步**

脚本读取 `telemetry/catalog/public-events.json`，通过以下端点列出、创建和更新：

```text
GET  /api/projects/{projectId}/event_definitions/
POST /api/projects/{projectId}/event_definitions/
PATCH /api/projects/{projectId}/event_definitions/{definitionId}/
```

以精确事件 `name` 关联。创建或更新 payload 只包含：

```js
{
  name: event.name,
  description: event.description.en,
  tags: ['wework', event.domain, `schema-v${event.schemaVersion}`],
  verified: true,
  default_columns: event.properties.map(property => property.name),
}
```

不得读取桌面 `.env`；仅从 `POSTHOG_HOST`、`POSTHOG_PROJECT_ID` 和
`POSTHOG_PERSONAL_API_KEY` 读取 CI 配置。`POSTHOG_HOST` 必须是当前项目对应的 private
API host，而不是事件 ingest host；Personal API Key 至少具有
`event_definition:read`、`event_definition:write`、`property_definition:read` 和
`property_definition:write` scopes。

- [x] **Step 4: 实现 Property Definition 更新**

通过：

```text
GET   /api/projects/{projectId}/property_definitions/?type=event
PATCH /api/projects/{projectId}/property_definitions/{definitionId}/
```

只更新已经存在的属性定义；尚未由真实事件创建的属性输出
`property pending first event: <name>`，不视为失败。更新字段为 description、tags、
property_type 和 verified。

- [x] **Step 5: 增加 scripts 和 GitHub workflow**

```json
{
  "telemetry:posthog:dry-run": "node scripts/sync-posthog-event-definitions.mjs --dry-run",
  "telemetry:posthog:sync": "node scripts/sync-posthog-event-definitions.mjs"
}
```

Workflow 行为固定为：

- pull request：安装依赖、运行 generator tests、`telemetry:catalog:check` 和 sync tests；
- push main：重复 validation；仅当 repository variable
  `POSTHOG_TELEMETRY_SYNC_ENABLED == 'true'` 时使用 environment secrets 同步；
- 不把 secrets 传给 pull request job；
- workflow 日志不输出 Authorization header 或 API key。

- [x] **Step 6: 本地验证**

```bash
node --test wework/scripts/sync-posthog-event-definitions.test.mjs
pnpm --filter wework telemetry:catalog:check
pnpm --filter wework telemetry:posthog:dry-run
```

Expected: 测试和 catalog check 通过；无凭据 dry-run 报告九个公共事件和两个公共属性，且不发送写请求。

- [x] **Step 7: 提交 catalog CI**

```bash
git add wework/scripts/sync-posthog-event-definitions.mjs wework/scripts/sync-posthog-event-definitions.test.mjs wework/package.json .github/workflows/wework-telemetry-catalog.yml
git commit -m "ci(wework): sync telemetry definitions"
```

### Task 9: 扩展真实 Electron 回归和内部 UI 验证

**Files:**

- Modify: `wework/e2e/desktop/modules/shared.mjs:404-427`
- Modify: `wework/e2e/desktop/scenarios/harness-apps.scenario.mjs:430-540,906-975`
- Verify: `.github/workflows/wework-e2e.yml`

- [ ] **Step 1: 先更新公共字段 allowlist**

只增加：

```js
'domain',
'event_schema_version',
'failure_stage',
```

不要把 email、user、smart_app_name、path、filename 或 error 加入
`TELEMETRY_SAFE_PROPERTY_KEYS`。保留现有 forbidden pattern。

- [ ] **Step 2: 在 harness-apps checkpoint 断言 route 和 install 事件**

市场页面稳定后：

```js
await control.awaitTelemetryEvent("smart_app_marketplace_opened");
```

市场安装完成后：

```js
const installRequest = await control.awaitTelemetryEvent(
  "smart_app_install_succeeded",
);
const installEvent = telemetryEvents(installRequest.payload).find(
  (event) => event.event === "smart_app_install_succeeded",
);
assert.equal(installEvent.properties.domain, "smart_app");
assert.equal("smart_app_name" in installEvent.properties, false);
```

打开运行工作台后断言 `smart_app_opened`；进入“我的”后断言
`smart_app_owned_opened`；拖入 ZIP 成功后断言 `smart_app_zip_import_succeeded`。

- [ ] **Step 3: 验证没有旧事件双写**

从 `control.telemetryRequests` 展开所有事件，断言不包含：

```js
const forbiddenLegacyEvents = new Set(["smart_app_installed"]);
```

同时拒绝 domain 为 smart_app 的 `feature_opened`、`feature_action_completed` 和
`operation_failed`。

- [ ] **Step 4: 运行 CI 覆盖的真实 Electron checkpoint**

```bash
pnpm --filter wework e2e:desktop --segment harness-apps
```

Expected: checkpoint 通过并保留 Smart App 截图及测试 PostHog 请求证据；该 checkpoint
已经由 `.github/workflows/wework-e2e.yml` 调用，不新增本地专用入口。

- [ ] **Step 5: 使用 ai:verify 验证内部构建不显示统计 UI**

```bash
wework_telemetry_start="$(VITE_WEWORK_TELEMETRY_DISTRIBUTION=internal pnpm --filter wework ai:verify start --packaged true)"
wework_telemetry_session="$(node -e "const fs = require('node:fs'); const value = JSON.parse(fs.readFileSync(0, 'utf8')); process.stdout.write(value.session)" <<< "$wework_telemetry_start")"
```

上述命令从 `start` 返回的 JSON 中提取本次隔离 session path。然后执行：

```bash
pnpm --filter wework ai:verify wait-for --session "$wework_telemetry_session" --selector body --text Wework
pnpm --filter wework ai:verify snapshot --session "$wework_telemetry_session"
pnpm --filter wework ai:verify click --session "$wework_telemetry_session" --selector '[data-testid="sidebar-settings"]'
pnpm --filter wework ai:verify wait-for --session "$wework_telemetry_session" --selector '[data-testid="general-settings-page"]'
pnpm --filter wework ai:verify snapshot --session "$wework_telemetry_session"
pnpm --filter wework ai:verify request-close --session "$wework_telemetry_session"
```

检查两个 snapshot 均不包含 `telemetry-consent-overlay`、`general-telemetry-toggle`、
“内部使用统计”、“发送位置”或“工作台名称”。如果仓库实际设置入口 test id 与示例不同，
必须先通过第一次 snapshot 选择其中已经存在的稳定 product test id，不得使用坐标点击。

- [ ] **Step 6: 提交桌面回归**

```bash
git add wework/e2e/desktop/modules/shared.mjs wework/e2e/desktop/scenarios/harness-apps.scenario.mjs
git commit -m "test(wework): cover automatic smart app telemetry"
```

### Task 10: 完成原子切换验证和发布准备

**Files:**

- Verify: all files changed by Tasks 1-9
- Modify only if required by actual results: generated catalog artifacts

- [ ] **Step 1: 重新生成并证明无漂移**

```bash
pnpm --filter wework telemetry:catalog
git diff --exit-code -- wework/src/telemetry/generated wework/telemetry/catalog
pnpm --filter wework telemetry:catalog:check
```

Expected: 无 diff，catalog check 退出 0。

- [ ] **Step 2: 运行所有 Node tests**

```bash
node --test wework/scripts/generate-telemetry-catalog.test.mjs wework/scripts/check-telemetry-boundary.test.mjs wework/scripts/sync-posthog-event-definitions.test.mjs wework/dsh/app-wework/client.test.mjs
```

Expected: 0 failures。

- [ ] **Step 3: 运行完整 Wework test、typecheck 和 lint**

```bash
pnpm --filter wework test
pnpm --filter wework typecheck
pnpm --filter wework lint
```

Expected: 所有命令退出 0，不允许通过重跑掩盖间歇失败。

- [ ] **Step 4: 运行 Smart App desktop checkpoint**

```bash
pnpm --filter wework e2e:desktop --segment harness-apps
```

Expected: 真实 Electron 流程和全部 telemetry assertions 通过。

- [ ] **Step 5: 审查最终运行代码中的旧事件和敏感字段**

```bash
rg -n "smart_app_installed|smart_app_marketplace_download|smart_app_marketplace_install|smart_app_marketplace_update" wework/src wework/dsh --glob '!**/*.test.*' --glob '!**/*.md'
rg -n "smart_app_name|email|packagePath|archivePath|error" wework/src/telemetry wework/telemetry/catalog
```

Expected: 第一条没有运行时代码命中；第二条中的 email 和 smart_app_name 只允许出现在
进程内 context 类型或明确的禁止字段测试中，公共 catalog 和 Public Projection 不得包含。

- [ ] **Step 6: 检查单次生产事实只发送一个新事件**

使用 E2E 保存的 PostHog request evidence，分别统计 install、open、ZIP import。每个
用户动作只有一个新事件，且不存在对应旧事件。失败 fixture 必须分别产生一个带受限
`failure_stage` 的失败事件。

- [ ] **Step 7: PostHog dry-run 并记录切换边界**

```bash
pnpm --filter wework telemetry:posthog:dry-run
```

Expected: 计划创建或更新九个新事件定义，并把旧事件列入 deprecated migration report；
不删除历史定义。

- [ ] **Step 8: 最终提交仅包含验证产生的必要改动**

如果验证没有产生文件变化，不创建空提交。如果 generator 修复了确定性输出，使用：

```bash
git add wework/src/telemetry/generated wework/telemetry/catalog
git commit -m "chore(wework): refresh telemetry catalog"
```

## Internal plugin follow-up gate

只有在以下信息可用后，才编写并执行第二份私有实施计划：

1. GitLab 私有插件仓库的本地 worktree 路径；
2. 私有 package 的实际 scope/name；
3. 内部 Gateway 的测试环境契约；
4. 允许生成 `user_key` 的企业邮箱域配置来源；
5. 内部 `wework-core` profile 的管理位置和打包命令；
6. 内部 PostHog project 的 CI environment 名称。

第二份计划不得把这些值复制回公开仓库。当前计划完成后，fake Internal Sink 已能证明
协议、启动顺序、故障隔离和 context 边界，私有项目只负责投影、队列、Gateway 和内部
catalog。

## Execution handoff

计划按依赖顺序执行。Tasks 1-5 建立平台和路由自动采集；Task 6 完成原有 Smart App
代码迁移；Tasks 7-10 锁定架构、PostHog、真实 Electron 和发布边界。正式发行版不允许
新旧事件双写。
