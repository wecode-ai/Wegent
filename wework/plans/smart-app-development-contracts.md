---
sidebar_position: 13
---

# 通用 Smart App 开发契约实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为所有 Wework Smart App 建立能力感知、可机器执行的开发契约，在源码、构建产物、隔离运行时和最终 ZIP 四个边界上阻止跨层错误进入安装阶段。

**Architecture:** 在 Electron Host 中新增唯一的 Smart App 验证编排器，复用 Wework 锁定的 Node.js 与 DSH Runtime；开发助手通过现有令牌保护的本地控制桥调用它，Renderer 只展示结构化结果。验证器按 `smart-app.verify.json` 声明的 Host、Client、Remote 等能力运行最小检查，并用内容指纹约束预览、打包和发布前置条件。

**Tech Stack:** Electron、TypeScript、React、Vitest、DSH Workbench Runtime、Node.js `child_process`、Corepack/pnpm、FastAPI/Python（仅发布侧复核）、桌面 E2E runner。

---

> 对应设计：`docs/zh/wework/developer-guide/smart-app-development-contracts.md`
>
> 本文件是中文主计划，也是实施、中断恢复和交接的唯一进度入口。英文文件同步范围和工作包摘要；发生差异时以本文件为准。

## 0. 执行协议

每次开始或恢复实施时：

1. 完整阅读本计划和对应设计文档。
2. 运行 `git status --short`，保留所有不属于本任务的现有改动。
3. 每次只执行一个 Task；先写失败测试，再写最小实现，再运行该 Task 的验证。
4. 不通过重试掩盖间歇失败，不增加 silent fallback，不读取或改写用户的 DSH/Codex 凭据。
5. 完成一个 Task 后提交对应 Conventional Commit，并在本文件“实施记录”中登记实际命令和结果。
6. 修改 Wework UI、Electron Host、Runtime、IPC 或桌面集成后，最终必须运行隔离的真实 Electron 验证。

## 1. 范围和不变量

本计划实现设计中的 P0、P1，并把 P2 落到“发布前复用本机验证、服务端继续独立扫描”的可执行边界。它不引入 Smart App SDK，也不改变 DSH 自身协议。

必须保持：

- 平台规则不包含任何具体页面名、行业、数据格式、服务名或 UI 布局。
- `smart-app.verify.json` 只声明能力、package script 名和最小就绪条件；Remote 方法细节仍由项目测试拥有。
- 验证命令只接受 package script 标识，不接受任意 shell 文本；所有子进程使用固定可执行文件、argv 和 `shell: false`。
- 冷启动使用一次性 `DSH_HOME`、随机 loopback 端口和最小非敏感配置。
- 用户现有 `DSH_HOME`、`.credentials.yaml`、Codex Home 和认证链接不进入验证环境。
- 开发验证器服务可信的本地源码；安装器和 Backend 继续把 ZIP 当作不可信输入执行独立安全扫描。
- `smart-app.verify.json` 与 `test-results/` 不进入 ZIP；解包复验使用打包前已解析并固定的契约。
- 仅关联目录和由 Wework 创建的可编辑项目受“验证后才能导出/发布”约束；历史市场包仍可安装和运行。

## 2. 目标数据流

```text
Smart App source
  ├─ plugin-manifest.json
  ├─ smart-app.verify.json
  └─ packages/**
          │
          ▼
SmartAppVerifier (Electron Host)
  1. package/manifest/security
  2. declared scripts
  3. built artifacts
  4. isolated DSH + DOM readiness + runtime probe
  5. fingerprinted report
          │
          ├─ Renderer status / fix location
          ├─ wework smart-app inspect|verify|pack
          └─ pack → unzip → package/artifact/runtime reverify
```

`SmartAppManager` 只编排安装记录和用户动作，不继续吸收验证细节。验证实现拆到专用模块，避免当前文件超过 1000 行。

## 3. 公共契约

### 3.1 `smart-app.verify.json`

第一版唯一合法结构：

```json
{
  "schemaVersion": 1,
  "scripts": {
    "typecheck": "typecheck",
    "test": "test",
    "build": "build",
    "runtimeProbe": "verify:runtime"
  },
  "capabilities": {
    "host": true,
    "client": true,
    "remote": true
  },
  "runtime": {
    "profile": "web",
    "path": "/",
    "readySelector": "[data-testid=\"smart-app-ready\"]"
  }
}
```

约束：

- `typecheck`、`test`、`build` 必填；`runtimeProbe` 仅在 `remote: true` 时必填。
- script 值匹配 `^[A-Za-z0-9:_-]+$`，并且必须存在于项目根 `package.json#scripts`。
- `runtime.profile` 必须严格等于 manifest 的 `entry.profile`。
- `runtime.path` 必须是以 `/` 开头的站内路径，不允许 scheme、host 或 `..`。
- `readySelector` 必填、最大 512 字符，只作为 `document.querySelector` 的数据输入，不拼接为任意 JavaScript。
- 未声明的能力不运行对应能力检查；`remote: true` 要求 `host` 和 `client` 同时为 `true`。

### 3.2 结构化结果

```ts
export type SmartAppVerificationStage =
  | 'environment'
  | 'manifest'
  | 'scripts'
  | 'artifacts'
  | 'runtime'
  | 'package'

export interface SmartAppVerificationIssue {
  code: string
  stage: SmartAppVerificationStage
  file: string | null
  message: string
  expected: string | null
  actual: string | null
  blocking: boolean
  hint: string | null
}

export interface SmartAppVerificationReport {
  schemaVersion: 1
  status: 'passed' | 'failed' | 'stale'
  projectRoot: string
  inputFingerprint: string
  deliverableFingerprint: string | null
  startedAt: string
  finishedAt: string
  stages: SmartAppVerificationStageResult[]
  issues: SmartAppVerificationIssue[]
}
```

落盘报告位于 `<project>/test-results/smart-app/verification.json`。Renderer 和 CLI 使用同一结果类型，不解析人类日志。

稳定错误前缀为 `SA-ENV-*`、`SA-MANIFEST-*`、`SA-DEPENDENCY-*`、`SA-HOST-*`、`SA-CLIENT-*`、`SA-COMPOSITION-*`、`SA-REMOTE-*`、`SA-RUNTIME-*` 和 `SA-PACKAGE-*`。测试断言具体 code，界面文案可以本地化，但不得把文案当协议。

## 4. 实施任务

### Task 1：建立验证契约解析器和稳定错误模型

**Files:**

- Create: `electron/src/host/smart-app-verification-contract.ts`
- Create: `electron/src/host/smart-app-verification-contract.test.ts`
- Create: `electron/src/host/smart-app-verification-types.ts`

- [x] 写解析失败测试，覆盖缺文件、未知 schema、非法 script 名、缺失 package script、profile 不一致、非法 path/selector 和 `remote` 缺少 Host/Client。
- [x] 写最小正向测试，分别覆盖纯 Host、纯 Client、Host + Client、Host + Client + Remote。
- [x] 运行测试并确认先失败：

```bash
pnpm --filter wework test electron/src/host/smart-app-verification-contract.test.ts
```

预期：Vitest 只收集该文件，并因模块尚不存在或断言未实现而失败。

- [x] 实现严格 JSON 解析、字段归一化和 `SA-MANIFEST-CONTRACT-*` 问题码。解析器返回 typed result，不直接抛出面向 UI 的自由文本。
- [x] 再次运行同一命令，预期全部通过。
- [x] 提交：

```bash
git add electron/src/host/smart-app-verification-contract.ts electron/src/host/smart-app-verification-contract.test.ts electron/src/host/smart-app-verification-types.ts
git commit -m "feat(wework): define smart app verification contract"
```

### Task 2：从 Manager 提取包、Manifest 和安全校验

**Files:**

- Create: `electron/src/host/smart-app-package-validator.ts`
- Create: `electron/src/host/smart-app-package-validator.test.ts`
- Modify: `electron/src/host/smart-app-manager.ts`
- Modify: `electron/src/host/smart-app-manager.test.ts`

- [x] 先为现有 `validatePackageDirectory`、manifest paths、符号链接、大小限制、重复 package/plugin、`entry.installPackage` 一致性和敏感文件规则补测试。
- [x] 添加回归测试，证明市场 ZIP 预览、安装、关联目录刷新行为不变。
- [x] 运行：

```bash
pnpm --filter wework test electron/src/host/smart-app-package-validator.test.ts electron/src/host/smart-app-manager.test.ts
```

预期：新增断言先失败；现有 Manager 测试保持通过。

- [x] 将包遍历、hash、manifest 校验、ZIP 解包限制和敏感文件检查移动到 validator；Manager 只调用公开函数。
- [x] validator 对目录和解包目录返回统一 `ValidatedSmartAppPackage`，结构问题映射为 `SA-MANIFEST-*` 或 `SA-PACKAGE-*`。
- [x] 再次运行同一测试，预期全部通过。
- [x] 提交：

```bash
git add electron/src/host/smart-app-package-validator.ts electron/src/host/smart-app-package-validator.test.ts electron/src/host/smart-app-manager.ts electron/src/host/smart-app-manager.test.ts
git commit -m "refactor(wework): isolate smart app package validation"
```

### Task 3：生成能力最小化的四种脚手架

**Files:**

- Create: `electron/src/host/smart-app-scaffold.ts`
- Create: `electron/src/host/smart-app-scaffold.test.ts`
- Modify: `electron/src/host/smart-app-manager.ts`
- Modify: `electron/src/host/electron-capabilities.ts`
- Modify: `electron/src/host/capability-router.ts`
- Modify: `src/api/local/harnessApps.ts`
- Modify: `src/api/local/harnessApps.test.ts`
- Modify: `src/features/harness-apps/SmartAppDevelopmentDialog.tsx`
- Modify: `src/components/layout/DesktopWorkbenchLayout.test.tsx`
- Modify: `src/i18n/locales/en/common.json`
- Modify: `src/i18n/locales/zh-CN/common.json`

- [ ] 为 `web | host | web-host | web-host-remote` 四种 template 写快照式结构测试，断言只生成声明能力所需入口、测试、build 配置与契约。
- [ ] 断言所有 Client 模板导出 `./client` 和 `./package.json`，构建产物使用 DSH ModuleLoader 工厂；所有模板都不默认注入 `llm`、`harness`、文件或网络服务。
- [ ] 断言 Remote 模板使用通用 `health.ping` fixture，只验证 Remote 往返，不引入业务字段。
- [ ] 为创建对话框新增模板选择交互测试和稳定 `data-testid`。
- [ ] 运行：

```bash
pnpm --filter wework test electron/src/host/smart-app-scaffold.test.ts src/api/local/harnessApps.test.ts src/components/layout/DesktopWorkbenchLayout.test.tsx
```

预期：新增模板与 UI 断言先失败。

- [ ] 实现 `scaffoldSmartApp({ template, ... })`，删除 Manager 内的 `scaffoldWebSmartApp`。
- [ ] API 将 `template` 作为必填联合类型透传，界面默认选择 `web`，并提供中英文能力说明。
- [ ] 再次运行同一测试，预期全部通过。
- [ ] 提交：

```bash
git add electron/src/host/smart-app-scaffold.ts electron/src/host/smart-app-scaffold.test.ts electron/src/host/smart-app-manager.ts electron/src/host/electron-capabilities.ts electron/src/host/capability-router.ts src/api/local/harnessApps.ts src/api/local/harnessApps.test.ts src/features/harness-apps/SmartAppDevelopmentDialog.tsx src/components/layout/DesktopWorkbenchLayout.test.tsx src/i18n/locales/en/common.json src/i18n/locales/zh-CN/common.json
git commit -m "feat(wework): add capability-aware smart app templates"
```

### Task 4：实现确定性指纹和验证失效

**Files:**

- Create: `electron/src/host/smart-app-verification-fingerprint.ts`
- Create: `electron/src/host/smart-app-verification-fingerprint.test.ts`

- [ ] 写测试证明遍历顺序和 mtime 不影响 hash，内容/manifest/dependency/bundle patch/契约变化会改变输入指纹。
- [ ] 写测试证明 `.git`、`node_modules`、`test-results`、输出 ZIP 和文档变化不使运行输入指纹失效；ZIP 内容指纹仍包含发布文档。
- [ ] 运行并确认先失败：

```bash
pnpm --filter wework test electron/src/host/smart-app-verification-fingerprint.test.ts
```

- [ ] 实现规范化 POSIX 相对路径、文件字节和用途区分：

```ts
export type SmartAppFingerprintPurpose = 'verification-input' | 'deliverable'
```

- [ ] 拒绝符号链接和逃逸路径，避免 hash 与打包观察到不同内容。
- [ ] 再次运行测试，预期全部通过。
- [ ] 提交：

```bash
git add electron/src/host/smart-app-verification-fingerprint.ts electron/src/host/smart-app-verification-fingerprint.test.ts
git commit -m "feat(wework): fingerprint smart app verification inputs"
```

### Task 5：运行声明的项目 scripts，禁止 shell 注入

**Files:**

- Create: `electron/src/host/smart-app-project-script-runner.ts`
- Create: `electron/src/host/smart-app-project-script-runner.test.ts`
- Modify: `electron/src/runtime/workbench-dsh-runtime.ts`
- Modify: `electron/src/runtime/workbench-dsh-runtime.test.ts`

- [ ] 用注入 runner 写测试，断言执行顺序固定为 typecheck → test → build，任一非零退出立即停止。
- [ ] 写安全测试，断言 `build && curl ...`、换行和路径值被契约解析器拒绝，runner 从不使用 `shell: true`。
- [ ] 写 Runtime 路径测试，证明 runner 使用 Wework 管理的 Node 和 Runtime 自带 pnpm，而不是用户 PATH 中的随机版本。
- [ ] 运行：

```bash
pnpm --filter wework test electron/src/host/smart-app-project-script-runner.test.ts electron/src/runtime/workbench-dsh-runtime.test.ts
```

- [ ] 从 Workbench Runtime 导出受测的 managed Node/pnpm 命令描述；runner 以 `cwd = projectRoot`、固定 argv 和脱敏环境运行。
- [ ] 将 stdout/stderr 写入 `test-results/smart-app/logs/<stage>.log`，报告只保存相对日志路径和有限摘要。
- [ ] 再次运行测试，预期全部通过。
- [ ] 提交：

```bash
git add electron/src/host/smart-app-project-script-runner.ts electron/src/host/smart-app-project-script-runner.test.ts electron/src/runtime/workbench-dsh-runtime.ts electron/src/runtime/workbench-dsh-runtime.test.ts
git commit -m "feat(wework): run declared smart app project checks"
```

### Task 6：验证真实构建产物和 Client ModuleLoader

**Files:**

- Create: `electron/src/host/smart-app-artifact-validator.ts`
- Create: `electron/src/host/smart-app-artifact-validator.test.ts`
- Create: `electron/src/host/fixtures/smart-apps/artifacts/valid-client/`
- Create: `electron/src/host/fixtures/smart-apps/artifacts/missing-package-export/`
- Create: `electron/src/host/fixtures/smart-apps/artifacts/invalid-module-loader/`

- [ ] 建立最小 fixture，分别复现元数据未导出、源码有 Client 但产物无工厂包装、Host export 无法 import。
- [ ] 写能力感知测试：纯 Host 不检查 Client；纯 Client 不要求 Host；声明能力的实际 export 和 `files` 必须可解析。
- [ ] 运行并确认先失败：

```bash
pnpm --filter wework test electron/src/host/smart-app-artifact-validator.test.ts
```

- [ ] 实现 package exports/files/bundle patch 交叉校验、隔离动态 import 和受控 fixture：

```ts
const moduleFactories: unknown[] = []
const moduleLoader = { load: (factory: unknown) => moduleFactories.push(factory) }
```

- [ ] Client bundle 只能在该受控加载器中注册工厂；不以源码字符串出现某个关键词作为通过条件。
- [ ] 再次运行测试，预期正向 fixture 通过、负向 fixture 返回稳定 `SA-HOST-*`/`SA-CLIENT-*` 错误码。
- [ ] 提交：

```bash
git add electron/src/host/smart-app-artifact-validator.ts electron/src/host/smart-app-artifact-validator.test.ts electron/src/host/fixtures/smart-apps/artifacts
git commit -m "feat(wework): verify built smart app artifacts"
```

### Task 7：实现隔离 DSH 冷启动和安全页面探针

**Files:**

- Create: `electron/src/host/smart-app-runtime-verifier.ts`
- Create: `electron/src/host/smart-app-runtime-verifier.test.ts`
- Create: `electron/src/host/smart-app-verification-view.ts`
- Create: `electron/src/host/smart-app-verification-view.test.ts`
- Modify: `electron/src/runtime/workbench-dsh-runtime.ts`
- Modify: `electron/src/runtime/workbench-dsh-runtime.test.ts`

- [ ] 写 Runtime 单测，断言每次验证创建唯一临时 data directory、随机端口，且完成、失败、超时、取消时都停止进程并清理目录。
- [ ] 写环境边界测试，传入伪造的个人 `DSH_HOME`、Host token、executor token 和 credentials path，断言它们不进入验证进程。
- [ ] 写页面探针测试，覆盖 path 可访问、selector 出现、非法 selector、导航失败和超时。
- [ ] 运行：

```bash
pnpm --filter wework test electron/src/host/smart-app-runtime-verifier.test.ts electron/src/host/smart-app-verification-view.test.ts electron/src/runtime/workbench-dsh-runtime.test.ts
```

- [ ] Runtime verifier 复用 `prepareWorkbenchDshLaunch`，但显式传入临时根目录；先完成安装和 dump-config，再启动 `DshRuntime`。
- [ ] `SmartAppVerificationView` 使用独立临时 Electron session 加载 `new URL(runtime.path, prepared.url)`，只执行平台拥有的 selector 查询，不接受项目 JavaScript。
- [ ] `remote: true` 时，在页面就绪后运行声明的 `runtimeProbe` package script，并只传 `SMART_APP_BASE_URL`；项目测试自行完成 Remote 往返和断言。
- [ ] 用 `finally` 关闭 WebContents、DSH 进程和临时 session/data，日志只保留脱敏副本。
- [ ] 再次运行测试，预期全部通过。
- [ ] 提交：

```bash
git add electron/src/host/smart-app-runtime-verifier.ts electron/src/host/smart-app-runtime-verifier.test.ts electron/src/host/smart-app-verification-view.ts electron/src/host/smart-app-verification-view.test.ts electron/src/runtime/workbench-dsh-runtime.ts electron/src/runtime/workbench-dsh-runtime.test.ts
git commit -m "feat(wework): cold start smart apps in isolation"
```

### Task 8：编排五层验证并持久化报告

**Files:**

- Create: `electron/src/host/smart-app-verifier.ts`
- Create: `electron/src/host/smart-app-verifier.test.ts`
- Modify: `electron/src/host/smart-app-manager.ts`
- Modify: `electron/src/host/smart-app-manager.test.ts`

- [ ] 先写编排测试，断言阶段严格按 manifest → scripts → artifacts → runtime 执行，blocking issue 停止后续阶段。
- [ ] 写并发测试：同一 project root 复用进行中的验证，不同 root 可独立运行；新验证完成时不得被旧请求覆盖。
- [ ] 写 stale 测试：报告写入后修改运行输入，`inspect` 返回 `stale`；仅修改文档不使运行报告失效。
- [ ] 运行：

```bash
pnpm --filter wework test electron/src/host/smart-app-verifier.test.ts electron/src/host/smart-app-manager.test.ts
```

- [ ] 实现：

```ts
verify(projectRoot: string): Promise<SmartAppVerificationReport>
inspect(projectRoot: string): Promise<SmartAppVerificationReport | null>
```

- [ ] 用临时文件 + rename 原子写报告；报告中的 `projectRoot` 在落盘版本中改为 `.`，API 返回值才包含规范化绝对路径。
- [ ] Manager 仅为 `source === 'linked'` 的 installation 暴露 inspect/verify；managed/market 安装记录不强制生成开发契约。
- [ ] 再次运行测试，预期全部通过。
- [ ] 提交：

```bash
git add electron/src/host/smart-app-verifier.ts electron/src/host/smart-app-verifier.test.ts electron/src/host/smart-app-manager.ts electron/src/host/smart-app-manager.test.ts
git commit -m "feat(wework): orchestrate smart app verification gates"
```

### Task 9：让打包依赖当前验证并从 ZIP 复验

**Files:**

- Modify: `electron/src/host/smart-app-package-validator.ts`
- Modify: `electron/src/host/smart-app-verifier.ts`
- Modify: `electron/src/host/smart-app-manager.ts`
- Modify: `electron/src/host/smart-app-manager.test.ts`
- Create: `electron/src/host/smart-app-package-verification.test.ts`

- [ ] 写测试：未验证、验证失败、验证后内容变化、ZIP 漏文件、ZIP 内多根、ZIP 冷启动失败均阻止导出。
- [ ] 写兼容测试：市场/managed 安装包沿用既有 export 行为；只有 linked 开发目录进入强制验证路径。
- [ ] 运行：

```bash
pnpm --filter wework test electron/src/host/smart-app-package-verification.test.ts electron/src/host/smart-app-manager.test.ts
```

- [ ] `pack` 执行完整源码验证，记录固定契约，生成排除 `.git`、`node_modules`、`test-results`、`.env*`、key/pem 和契约文件的 ZIP。
- [ ] 解压到第二个临时目录，复用 package validator、artifact validator 和 runtime verifier；比较 deliverable fingerprint 与 ZIP hash。
- [ ] 只有复验成功才以原子 rename 发布最终 ZIP；失败删除临时 ZIP 和解包目录。
- [ ] `export`/`exportToDownloads` 对 linked installation 委托给该路径。
- [ ] 再次运行测试，预期全部通过。
- [ ] 提交：

```bash
git add electron/src/host/smart-app-package-validator.ts electron/src/host/smart-app-verifier.ts electron/src/host/smart-app-manager.ts electron/src/host/smart-app-manager.test.ts electron/src/host/smart-app-package-verification.test.ts
git commit -m "feat(wework): verify smart app delivery archives"
```

### Task 10：通过 Wework CLI 向开发助手提供唯一验证入口

**Files:**

- Modify: `electron/src/host/wework-desktop-control-bridge.ts`
- Modify: `electron/src/host/wework-desktop-control-bridge.test.ts`
- Modify: `electron/src/cli/wework-cli.mjs`
- Create: `electron/src/cli/wework-cli.test.ts`
- Modify: `electron/src/main.ts`
- Modify: `resources/bundled-plugins/wework-personal/plugins/smart-app-builder/scripts/smart-app-tool.mjs`
- Modify: `resources/bundled-plugins/wework-personal/plugins/smart-app-builder/skills/create-smart-app/SKILL.md`
- Modify: `src/test/bundled-plugin-resources.test.ts`

- [ ] 先写 CLI 解析和桥接测试：

```text
wework smart-app inspect --project /absolute/smart-app --format json
wework smart-app verify  --project /absolute/smart-app --format json
wework smart-app pack    --project /absolute/smart-app --output /absolute/output.zip --format json
```

- [ ] 断言实例选择继续复用当前 `--instance`/`--project` 规则，token 不输出到 stdout/stderr，路径必须是已关联的 Smart App 根目录。
- [ ] 断言控制桥只接受固定 action，不暴露任意命令、argv、JavaScript 或用户凭据。
- [ ] 运行：

```bash
pnpm --filter wework test electron/src/cli/wework-cli.test.ts electron/src/host/wework-desktop-control-bridge.test.ts src/test/bundled-plugin-resources.test.ts
```

- [ ] 为控制桥增加注入的 `smartApps()` provider 和 `POST /smart-app`；main 使用闭包接入现有 Manager。
- [ ] CLI 输出人类摘要或 `--format json` 的完整 typed report，失败时非零退出。
- [ ] helper 保留本地 `doctor`/`search`，将 `inspect`/`verify`/`pack` 委托给 `wework smart-app`；删除旧的重复 validate/pack 实现，不添加找不到 Wework 时的弱校验 fallback。
- [ ] Skill 状态机改为 `inspect → contract → doctor → verify → preview → pack`，并要求按结构化错误码修复后重新验证。
- [ ] 再次运行测试，预期全部通过。
- [ ] 提交：

```bash
git add electron/src/host/wework-desktop-control-bridge.ts electron/src/host/wework-desktop-control-bridge.test.ts electron/src/cli/wework-cli.mjs electron/src/cli/wework-cli.test.ts electron/src/main.ts resources/bundled-plugins/wework-personal/plugins/smart-app-builder/scripts/smart-app-tool.mjs resources/bundled-plugins/wework-personal/plugins/smart-app-builder/skills/create-smart-app/SKILL.md src/test/bundled-plugin-resources.test.ts
git commit -m "feat(wework): expose smart app verification to builder"
```

### Task 11：在开发预览展示验证阶段、错误和 stale 状态

**Files:**

- Modify: `electron/src/host/electron-capabilities.ts`
- Modify: `electron/src/host/capability-router.ts`
- Modify: `src/api/local/harnessApps.ts`
- Modify: `src/api/local/harnessApps.test.ts`
- Modify: `src/features/harness-apps/smartAppDevelopmentPreview.ts`
- Modify: `src/features/harness-apps/smartAppDevelopmentPreview.test.ts`
- Modify: `src/components/layout/workspace-panels/RightWorkspacePanel.tsx`
- Modify: `src/components/layout/DesktopWorkbenchLayout.test.tsx`
- Modify: `src/i18n/locales/en/common.json`
- Modify: `src/i18n/locales/zh-CN/common.json`

- [ ] 写 UI 测试，覆盖未验证、运行中、passed、failed、stale；失败时显示首个 blocking code/file/hint，并可展开完整问题列表。
- [ ] 写交互测试，断言“验证”按钮触发 `smartApps.verify`；内容变化后状态变 stale；failed/stale 禁用 linked app 的导出入口。
- [ ] 所有新交互元素添加描述性 `data-testid`，继续使用共享尺寸和语义色，不用绿色定义默认产品 chrome。
- [ ] 运行：

```bash
pnpm --filter wework test src/api/local/harnessApps.test.ts src/features/harness-apps/smartAppDevelopmentPreview.test.ts src/components/layout/DesktopWorkbenchLayout.test.tsx
```

- [ ] 注册 `smartApps.inspectVerification` 与 `smartApps.verify` capability，Renderer 不直接读报告文件。
- [ ] 在现有开发预览 header 增加紧凑状态与操作，不新建平行页面。
- [ ] 更新中英文文案，错误详情使用验证器提供的结构化字段。
- [ ] 再次运行测试，预期全部通过。
- [ ] 提交：

```bash
git add electron/src/host/electron-capabilities.ts electron/src/host/capability-router.ts src/api/local/harnessApps.ts src/api/local/harnessApps.test.ts src/features/harness-apps/smartAppDevelopmentPreview.ts src/features/harness-apps/smartAppDevelopmentPreview.test.ts src/components/layout/workspace-panels/RightWorkspacePanel.tsx src/components/layout/DesktopWorkbenchLayout.test.tsx src/i18n/locales/en/common.json src/i18n/locales/zh-CN/common.json
git commit -m "feat(wework): show smart app verification status"
```

### Task 12：发布前复用本机闸门，服务端保持独立不可信扫描

**Files:**

- Modify: `src/api/smartApps.ts`
- Modify: `src/api/smartApps.test.ts`
- Modify: `electron/src/host/smart-app-manager.ts`
- Modify: `electron/src/host/electron-capabilities.ts`
- Modify: `src/api/local/harnessApps.ts`
- Modify: `../backend/app/services/smart_app_package_parser.py`
- Modify: `../backend/tests/services/test_smart_app_marketplace.py`

- [ ] 写客户端测试，证明从 linked 项目发布时必须先由 Host 生成并复验 ZIP；前端不能把任意 `File` 标记为“本机验证通过”。
- [ ] 写 Backend 回归测试，证明上传包仍独立执行 ZIP、路径、manifest 和敏感内容扫描，不信任客户端报告或包内自报字段。
- [ ] 写测试证明旧版市场包仍可上传审核和安装，开发契约不是服务端兼容性要求。
- [ ] 运行：

```bash
pnpm --filter wework test src/api/smartApps.test.ts src/api/local/harnessApps.test.ts electron/src/host/smart-app-manager.test.ts
cd ../backend && uv run pytest tests/services/test_smart_app_marketplace.py
```

- [ ] 发布调用改为接收 Host 返回的 archive path/hash/manifest，并使用现有二阶段上传；本机报告只用于 UX 和审计摘要，不参与 Backend 授权判断。
- [ ] Backend parser 补齐与本地 validator 相同的可静态复核项；不能在 Backend 模拟或声称完成 DSH 冷启动。
- [ ] 再次运行测试，预期全部通过。
- [ ] 提交：

```bash
git add src/api/smartApps.ts src/api/smartApps.test.ts electron/src/host/smart-app-manager.ts electron/src/host/electron-capabilities.ts src/api/local/harnessApps.ts ../backend/app/services/smart_app_package_parser.py ../backend/tests/services/test_smart_app_marketplace.py
git commit -m "feat(smart-apps): require verified archives for publication"
```

### Task 13：扩展自动化 fixture 和桌面 E2E

**Files:**

- Create: `electron/src/host/fixtures/smart-apps/runtime/host/`
- Create: `electron/src/host/fixtures/smart-apps/runtime/client/`
- Create: `electron/src/host/fixtures/smart-apps/runtime/web-host/`
- Create: `electron/src/host/fixtures/smart-apps/runtime/remote/`
- Create: `electron/src/host/fixtures/smart-apps/runtime/multi-package/`
- Create: `electron/src/host/fixtures/smart-apps/runtime/failures/`
- Modify: `e2e/desktop/scenarios/harness-apps.scenario.mjs`

- [ ] 正向 fixture 覆盖纯 Host、纯 Client、Host + Client、Remote、多包和本地/远程插件组合。
- [ ] 负向 fixture 覆盖未注入服务、错误页面组合、缺 package export、无 ModuleLoader 工厂、Remote 契约错、版本不满足、用户 DSH 配置损坏、ZIP 缺文件和 stale report。
- [ ] 每个 fixture 只表达一个边界，名称和 README 说明预期错误码，不包含具体业务数据。
- [ ] 扩展现有 `harness-apps` checkpoint；每个新增场景自行创建最小前置，不依赖被跳过的前序 checkpoint。
- [ ] 运行单 checkpoint：

```bash
pnpm --filter wework e2e:desktop -- --segment harness-apps
```

预期：创建模板 → 注入结构错误 → 验证失败并阻止导出 → 修复 → 冷启动通过 → 导出 → 重新导入和启动全部成功，且临时 Runtime/端口被清理。

- [ ] 提交：

```bash
git add electron/src/host/fixtures/smart-apps/runtime e2e/desktop/scenarios/harness-apps.scenario.mjs
git commit -m "test(wework): cover smart app verification lifecycle"
```

### Task 14：更新开发文档并完成全量验证

**Files:**

- Modify: `../docs/zh/wework/developer-guide/smart-app-development-contracts.md`
- Modify: `../docs/en/wework/developer-guide/smart-app-development-contracts.md`
- Modify: `../docs/zh/wework/plugins-and-skills.md`
- Modify: `../docs/en/wework/plugins-and-skills.md`
- Modify: `plans/smart-app-development-contracts.md`
- Modify: `plans/smart-app-development-contracts.en.md`

- [ ] 把设计文档中的将来时更新为实际命令、错误码和兼容边界；中文先改，英文同步语义。
- [ ] 在用户文档说明四种模板、验证状态、日志位置、CLI 和“不修改个人 DSH 配置”的保证。
- [ ] 运行格式、类型、lint 和全部 Wework 单测：

```bash
pnpm --filter wework exec prettier --check \
  electron/src/host \
  electron/src/runtime \
  electron/src/cli \
  src/api \
  src/features/harness-apps \
  src/components/layout/workspace-panels/RightWorkspacePanel.tsx \
  src/i18n/locales/en/common.json \
  src/i18n/locales/zh-CN/common.json \
  resources/bundled-plugins/wework-personal/plugins/smart-app-builder \
  plans/smart-app-development-contracts.md \
  plans/smart-app-development-contracts.en.md
pnpm --filter wework typecheck
pnpm --filter wework lint
pnpm --filter wework test
```

- [ ] 运行 Backend 聚焦与全量测试（Task 12 有改动时）：

```bash
cd ../backend && uv run pytest tests/services/test_smart_app_marketplace.py
cd ../backend && uv run pytest
```

- [ ] 按 QA 计划启动隔离真实 Electron：

```bash
pnpm --filter wework ai:verify start
```

- [ ] 从返回的 session path 执行：`snapshot`；创建 `web-host-remote` 项目；确认契约文件与状态；制造缺失 export；确认 `SA-CLIENT-*`、阻止导出；修复后重新验证；运行预览；导出 ZIP；重新导入并启动；捕获最终截图。
- [ ] 无论成功或失败都执行：

```bash
pnpm --filter wework ai:verify stop --session /absolute/ai-verify-session.json
```

- [ ] 检查 `test-results/ai-verify/` 下 app/executor/host 日志，记录环境、用例、实际结果和证据路径；不得用浏览器 mock 替代。
- [ ] 运行 git 自检：

```bash
git diff --check
git status --short
git diff --stat origin/main...HEAD
```

- [ ] 更新本计划实施记录，提交文档：

```bash
git add ../docs/zh/wework/developer-guide/smart-app-development-contracts.md ../docs/en/wework/developer-guide/smart-app-development-contracts.md ../docs/zh/wework/plugins-and-skills.md ../docs/en/wework/plugins-and-skills.md plans/smart-app-development-contracts.md plans/smart-app-development-contracts.en.md
git commit -m "docs(wework): document smart app verification workflow"
```

## 5. QA 验收矩阵

| 场景              | 前置                                    | 操作                                     | 预期                               | 恢复与清理           |
| ----------------- | --------------------------------------- | ---------------------------------------- | ---------------------------------- | -------------------- |
| 四种模板创建      | 隔离 Electron、空临时父目录             | 逐一创建模板                             | 仅生成对应能力；契约可解析         | 删除临时项目         |
| 未声明服务        | Host fixture 访问未提供服务             | 运行 verify                              | `SA-DEPENDENCY-*`，不进入预览/打包 | 修正注入后重验       |
| Client 元数据缺失 | 删除 `./package.json` export            | 运行 verify                              | `SA-CLIENT-*` 指向 package.json    | 恢复 export 后重验   |
| Client 工厂错误   | 构建普通 IIFE                           | 运行 verify                              | ModuleLoader 产物检查失败          | 修正 build wrapper   |
| 页面未就绪        | selector 永不出现                       | 冷启动                                   | `SA-COMPOSITION-*` 超时            | 修复注册/selector    |
| Remote 不兼容     | 两端 fixture 方法不一致                 | runtime probe                            | `SA-REMOTE-*`                      | 同步共享契约         |
| 用户配置损坏      | session-local personal DSH fixture 非法 | verify                                   | 隔离验证仍通过，不读取该配置       | 删除 fixture         |
| stale             | 验证通过后修改依赖/源码                 | inspect/export                           | `stale`，阻止 linked export        | 重新验证             |
| ZIP 差异          | 打包阶段移除产物                        | pack reverify                            | `SA-PACKAGE-*`，无最终 ZIP         | 清理临时 ZIP         |
| 完整链路          | 修复后的 Remote 模板                    | verify → preview → pack → import → start | 全部通过，hash/报告一致            | 停止 runtime/session |

## 6. 完成定义

- [ ] 五类原始跨边界问题均由通用 fixture 在安装前稳定失败：依赖注入、页面组合、模块发现、Remote 协议、环境隔离。
- [ ] 未声明能力不会触发无关检查，六类正向 fixture 通过各自最小验证集合。
- [ ] linked 项目的预览、导出和发布都能看到当前验证状态；过期结果不可复用。
- [ ] ZIP 解包后的结构、产物和冷启动复验通过，最终 hash 与返回值一致。
- [ ] 任何验证路径都没有读取、覆盖、复制或记录用户凭据。
- [ ] CLI、Renderer、Skill 使用同一 Host 验证器和结构化错误，不保留旧弱校验分支。
- [ ] 聚焦测试、全量测试、桌面 checkpoint 和隔离真实 Electron QA 全部通过。
- [ ] 中文文档先更新，英文文档语义一致，所有新文档包含 frontmatter。

## 7. 实施记录

执行者在每个 Task 完成后追加一行，不改写历史结果：

| 日期       | Task   | 提交                                                     | 验证结果                                            | 证据/备注                                    |
| ---------- | ------ | -------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------- |
| 2026-09-04 | 计划   | 本次计划提交                                             | 文档格式与路径检查通过                              | 设计提交 `5fb59f9bc`                         |
| 2026-09-04 | Task 1 | `feat(wework): define smart app verification contract`   | 14 个聚焦测试、ESLint、Electron typecheck 通过      | 完成严格契约解析和 typed report 基础类型     |
| 2026-09-04 | Task 2 | `refactor(wework): isolate smart app package validation` | 17 个聚焦/回归测试、ESLint、Electron typecheck 通过 | Manager 删除重复 validator，新增结构化包错误 |
