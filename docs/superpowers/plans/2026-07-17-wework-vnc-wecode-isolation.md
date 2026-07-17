---
sidebar_position: 7
---

# Wework VNC Wecode Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Wework 的 VNC 自有前端、静态资源和 Rust 会话实现迁入 `wecode`，通过通用云桌面扩展契约保持现有入口、安全路径和内置浏览器行为不变。

**Architecture:** `wecode/features/vnc` 拥有 VNC API、会话桥接、打开编排、设置页操作和静态资源；`@extensions/cloud-desktop` 是公共宿主唯一接入点。Vite 内部 plugin 继续把资源发布到 `/vnc.html` 与 `/novnc/rfb.min.js`，Rust 模块仅平移到 `src-tauri/src/wecode`，不改变 IPC 命令或凭证交接。

**Tech Stack:** React 19、TypeScript 6、Vitest、Vite 8、Tauri 2/Rust、noVNC、Wework Desktop E2E controller

---

## 文件结构

### 新建

- `wework/src/extensions/cloud-desktop-contract.ts`：通用云桌面扩展类型。
- `wework/src/extensions/cloud-desktop.tsx`：没有内部覆盖时的空实现。
- `wework/src/components/settings/DeviceActionButton.tsx`：设置页通用设备操作按钮。
- `wework/wecode/extensions/cloud-desktop.tsx`：把公共契约绑定到内部 VNC feature。
- `wework/wecode/features/vnc/api.ts`：当前云连接上的 VNC 配置请求及响应类型。
- `wework/wecode/features/vnc/api.test.ts`：VNC 配置请求测试。
- `wework/wecode/features/vnc/session.ts`：安全 IPC 会话和本地页面 URL。
- `wework/wecode/features/vnc/session.test.ts`：会话、页面和 URL 测试。
- `wework/wecode/features/vnc/openCloudDesktop.ts`：共享打开编排。
- `wework/wecode/features/vnc/openCloudDesktop.test.ts`：成功、失败与 stale request 测试。
- `wework/wecode/features/vnc/VncDesktopButton.tsx`：设置页内部云桌面按钮。
- `wework/wecode/features/vnc/VncDesktopButton.test.tsx`：按钮加载、竞态、失败与重试测试。
- `wework/wecode/features/vnc/viteAssets.ts`：开发与构建静态资源 plugin。
- `wework/wecode/features/vnc/viteAssets.test.ts`：base path、MIME 与资源映射测试。
- `wework/wecode/features/vnc/assets/vnc.html`：VNC 子 WebView 页面。
- `wework/wecode/features/vnc/assets/novnc/rfb.min.js`：vendored noVNC bundle。
- `wework/src-tauri/src/wecode/vnc_session.rs`：Tauri VNC 会话注册表与命令。

### 修改

- `wework/vite.config.ts`：条件加载内部 VNC assets plugin。
- `wework/src-tauri/src/wecode/mod.rs`、`wework/src-tauri/src/lib.rs`：注册移动后的 Rust 模块。
- `wework/src/components/settings/ConnectionsSettingsPage.tsx`：使用扩展操作和共享按钮。
- `wework/src/components/settings/ConnectionsSettingsPage.test.tsx`：只测试宿主接线，VNC 状态测试移入 feature。
- `wework/src/components/layout/workspace-panels/WorkspacePanelCards.tsx`：通过扩展打开云桌面。
- `wework/src/components/layout/workspace-panels/WorkspacePanelCards.test.tsx`：mock 通用扩展并保留宿主竞态测试。
- `wework/src/components/layout/workspace-panels/WorkspaceBrowserPanel.tsx`：通过扩展判断内部桌面页面。
- `wework/src/components/layout/workspace-panels/WorkspaceBrowserPanel.test.tsx`：通过扩展或真实内部覆盖验证页面策略。
- `wework/src/components/layout/DesktopWorkbenchLayout.test.tsx`：适配内部 API 所有权，保留整链路断言。
- `wework/src/api/devices.ts`、`wework/src/types/devices.ts`：删除公开 VNC API 与类型。
- `wework/wecode/api/devices.ts`、`wework/wecode/types/devices.ts`：删除重复 VNC API 与类型。
- `wework/e2e/desktop/task-flow.e2e.mjs`、`wework/src/e2e/automation.ts`：保留现有真实桌面和浏览器标签回归。
- `docs/superpowers/plans/2026-07-17-wework-cloud-device-vnc-browser.md`：保留已完成的原生身份修复记录。

### 删除

- `wework/src/lib/vnc.ts`
- `wework/src/lib/vnc.test.ts`
- `wework/src-tauri/src/vnc_session.rs`
- `wework/public/vnc.html`
- `wework/public/novnc/rfb.min.js`

## Task 1: 固化已经验证的内置浏览器原生身份修复

**Files:**

- Modify: `docs/superpowers/plans/2026-07-17-wework-cloud-device-vnc-browser.md`
- Modify: `wework/e2e/desktop/task-flow.e2e.mjs`
- Modify: `wework/src-tauri/src/embedded_browser.rs`
- Modify: `wework/src/components/layout/DesktopWorkbenchLayout.test.tsx`
- Modify: `wework/src/components/layout/workspace-panels/WorkspaceBrowserPanel.test.tsx`
- Modify: `wework/src/components/layout/workspace-panels/WorkspaceBrowserPanel.tsx`
- Modify: `wework/src/e2e/automation.ts`
- Modify: `wework/src/lib/embedded-browser.ts`

- [ ] **Step 1: 确认工作区只包含已知修复**

Run:

```bash
git status --short
git diff --check
git diff --stat
```

Expected: 除本计划文件外，只出现上述八个已验证文件；没有凭证、session 文件、构建产物或用户无关改动。

- [ ] **Step 2: 重跑提交前 focused 验证**

Run:

```bash
cargo test --manifest-path wework/src-tauri/Cargo.toml --locked --lib
pnpm --filter wework test -- src/components/layout/DesktopWorkbenchLayout.test.tsx src/components/layout/workspace-panels/WorkspaceBrowserPanel.test.tsx src/lib/embedded-browser.test.ts
pnpm --filter wework exec prettier --check src/lib/embedded-browser.ts src/components/layout/workspace-panels/WorkspaceBrowserPanel.tsx src/components/layout/workspace-panels/WorkspaceBrowserPanel.test.tsx src/e2e/automation.ts e2e/desktop/task-flow.e2e.mjs
pnpm --filter wework exec eslint src/lib/embedded-browser.ts src/components/layout/workspace-panels/WorkspaceBrowserPanel.tsx src/components/layout/workspace-panels/WorkspaceBrowserPanel.test.tsx src/e2e/automation.ts
pnpm --filter wework typecheck
```

Expected: Rust 83 个 lib tests 通过；focused Vitest、Prettier、ESLint 和 TypeScript 全部退出 0。

- [ ] **Step 3: 只提交原生身份修复**

Run:

```bash
git add docs/superpowers/plans/2026-07-17-wework-cloud-device-vnc-browser.md wework/e2e/desktop/task-flow.e2e.mjs wework/src-tauri/src/embedded_browser.rs wework/src/components/layout/DesktopWorkbenchLayout.test.tsx wework/src/components/layout/workspace-panels/WorkspaceBrowserPanel.test.tsx wework/src/components/layout/workspace-panels/WorkspaceBrowserPanel.tsx wework/src/e2e/automation.ts wework/src/lib/embedded-browser.ts
git diff --cached --check
git commit -m "fix(wework): preserve embedded browser native identity"
```

Expected: commit 成功，未暂存区只保留本迁移计划。

## Task 2: 从 Wecode 发布 VNC 静态资源

**Files:**

- Create: `wework/wecode/features/vnc/viteAssets.ts`
- Create: `wework/wecode/features/vnc/viteAssets.test.ts`
- Move: `wework/public/vnc.html` → `wework/wecode/features/vnc/assets/vnc.html`
- Move: `wework/public/novnc/rfb.min.js` → `wework/wecode/features/vnc/assets/novnc/rfb.min.js`
- Modify: `wework/vite.config.ts`
- Modify: `wework/src/lib/vnc.test.ts`

- [ ] **Step 1: 写静态资源映射失败测试**

Create `wework/wecode/features/vnc/viteAssets.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveVncAssetRequest, vncAssetDefinitions } from "./viteAssets";

describe("VNC Vite assets", () => {
  test("maps root and configured-base requests to internal source assets", () => {
    expect(resolveVncAssetRequest("/", "/vnc.html")?.fileName).toBe("vnc.html");
    expect(
      resolveVncAssetRequest("/wework/", "/wework/vnc.html")?.fileName,
    ).toBe("vnc.html");
    expect(
      resolveVncAssetRequest("/wework/", "/wework/novnc/rfb.min.js")?.fileName,
    ).toBe("novnc/rfb.min.js");
    expect(resolveVncAssetRequest("/wework/", "/wework/other.js")).toBeNull();
  });

  test("uses stable output names and explicit MIME types", () => {
    expect(
      vncAssetDefinitions.map((asset) => [asset.fileName, asset.contentType]),
    ).toEqual([
      ["vnc.html", "text/html; charset=utf-8"],
      ["novnc/rfb.min.js", "text/javascript; charset=utf-8"],
    ]);
  });

  test("keeps the page and noVNC bundle in the internal feature", () => {
    const assetRoot = resolve(process.cwd(), "wecode/features/vnc/assets");
    const html = readFileSync(resolve(assetRoot, "vnc.html"), "utf8");
    const bundle = readFileSync(resolve(assetRoot, "novnc/rfb.min.js"));
    expect(html).toContain('<script src="./novnc/rfb.min.js"></script>');
    expect(bundle.byteLength).toBeGreaterThan(300_000);
  });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
pnpm --filter wework test -- wecode/features/vnc/viteAssets.test.ts
```

Expected: FAIL，因为 `viteAssets.ts` 和内部 asset 路径尚不存在。

- [ ] **Step 3: 原样移动静态资源**

Run:

```bash
mkdir -p wework/wecode/features/vnc/assets/novnc
git mv wework/public/vnc.html wework/wecode/features/vnc/assets/vnc.html
git mv wework/public/novnc/rfb.min.js wework/wecode/features/vnc/assets/novnc/rfb.min.js
```

Expected: `git status --short` 显示两个 rename，不留下 `public` 中的 VNC 源文件。

- [ ] **Step 4: 实现内部 Vite assets plugin**

Create `wework/wecode/features/vnc/viteAssets.ts`:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

interface VncAssetDefinition {
  contentType: string;
  fileName: string;
  sourcePath: string;
}

export const vncAssetDefinitions: VncAssetDefinition[] = [
  {
    contentType: "text/html; charset=utf-8",
    fileName: "vnc.html",
    sourcePath: "vnc.html",
  },
  {
    contentType: "text/javascript; charset=utf-8",
    fileName: "novnc/rfb.min.js",
    sourcePath: "novnc/rfb.min.js",
  },
];

const assetRoot = resolve(import.meta.dirname, "assets");

function normalizeBase(base: string): string {
  const pathname = new URL(base, "http://wework.local").pathname;
  return pathname === "/" ? "/" : `/${pathname.replace(/^\/+|\/+$/g, "")}/`;
}

export function resolveVncAssetRequest(
  base: string,
  requestUrl: string,
): VncAssetDefinition | null {
  const requestPath = new URL(requestUrl, "http://wework.local").pathname;
  const normalizedBase = normalizeBase(base);
  const relativePath =
    normalizedBase === "/"
      ? requestPath.replace(/^\//, "")
      : requestPath.startsWith(normalizedBase)
        ? requestPath.slice(normalizedBase.length)
        : "";
  return (
    vncAssetDefinitions.find((asset) => asset.fileName === relativePath) ?? null
  );
}

export function createVncAssetsPlugin(): Plugin {
  let base = "/";
  return {
    name: "wework-vnc-assets",
    configResolved(config) {
      base = config.base;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const asset = resolveVncAssetRequest(base, request.url ?? "/");
        if (!asset) {
          next();
          return;
        }
        try {
          response.statusCode = 200;
          response.setHeader("Content-Type", asset.contentType);
          response.end(readFileSync(resolve(assetRoot, asset.sourcePath)));
        } catch (error) {
          next(error as Error);
        }
      });
    },
    buildStart() {
      for (const asset of vncAssetDefinitions) {
        this.emitFile({
          type: "asset",
          fileName: asset.fileName,
          source: readFileSync(resolve(assetRoot, asset.sourcePath)),
        });
      }
    },
  };
}
```

Modify `wework/vite.config.ts` to load this TypeScript module only when it exists:

```ts
import { pathToFileURL } from 'node:url'
import type { Plugin } from 'vite'

async function loadInternalVitePlugins(): Promise<Plugin[]> {
  const modulePath = path.resolve(__dirname, './wecode/features/vnc/viteAssets.ts')
  if (!fs.existsSync(modulePath)) return []
  const module = (await import(pathToFileURL(modulePath).href)) as {
    createVncAssetsPlugin: () => Plugin
  }
  return [module.createVncAssetsPlugin()]
}

export default defineConfig(async () => ({
```

Keep the current inline `fileViewerRenderers({ preset, autoPresets, copyAssets, chunkStrategy })`
call byte-for-byte and insert this array entry immediately after it:

```ts
...(await loadInternalVitePlugins()),
```

Change the final `})` of the config to:

```ts
}))
```

All `define`, `build`, `server`, `resolve`, and `test` fields remain in the same returned object.

Update the temporary `wework/src/lib/vnc.test.ts` asset read path to
`wecode/features/vnc/assets/vnc.html`; Task 4 moves this test into the feature.

- [ ] **Step 5: 运行 GREEN 测试并验证 production 输出字节**

Run:

```bash
set -euo pipefail
pnpm --filter wework test -- wecode/features/vnc/viteAssets.test.ts src/lib/vnc.test.ts
WEWORK_VNC_ASSET_TMP="$(mktemp -d)"
cleanup_vnc_assets() {
  if test -n "${WEWORK_VNC_DEV_PID:-}" && kill -0 "$WEWORK_VNC_DEV_PID" 2>/dev/null; then
    kill "$WEWORK_VNC_DEV_PID"
    wait "$WEWORK_VNC_DEV_PID" || true
  fi
  test ! -d "$WEWORK_VNC_ASSET_TMP" || rm -r -- "$WEWORK_VNC_ASSET_TMP"
}
trap cleanup_vnc_assets EXIT
VITE_APP_BASE_PATH=/wework pnpm --filter wework exec vite --host 127.0.0.1 --port 14327 --strictPort >"$WEWORK_VNC_ASSET_TMP/vite.log" 2>&1 &
WEWORK_VNC_DEV_PID=$!
for attempt in {1..50}; do
  if curl -fsS -D "$WEWORK_VNC_ASSET_TMP/vnc.headers" -o "$WEWORK_VNC_ASSET_TMP/vnc.html" http://127.0.0.1:14327/wework/vnc.html; then
    break
  fi
  sleep 0.2
done
curl -fsS -D "$WEWORK_VNC_ASSET_TMP/rfb.headers" -o "$WEWORK_VNC_ASSET_TMP/rfb.min.js" http://127.0.0.1:14327/wework/novnc/rfb.min.js
grep -i '^content-type: text/html; charset=utf-8' "$WEWORK_VNC_ASSET_TMP/vnc.headers"
grep -i '^content-type: text/javascript; charset=utf-8' "$WEWORK_VNC_ASSET_TMP/rfb.headers"
cmp -s wework/wecode/features/vnc/assets/vnc.html "$WEWORK_VNC_ASSET_TMP/vnc.html"
cmp -s wework/wecode/features/vnc/assets/novnc/rfb.min.js "$WEWORK_VNC_ASSET_TMP/rfb.min.js"
kill "$WEWORK_VNC_DEV_PID"
wait "$WEWORK_VNC_DEV_PID" || true
unset WEWORK_VNC_DEV_PID
pnpm --filter wework build
test -f wework/dist/vnc.html
test -f wework/dist/novnc/rfb.min.js
git show HEAD:wework/public/vnc.html | cmp -s - wework/dist/vnc.html
git show HEAD:wework/public/novnc/rfb.min.js | cmp -s - wework/dist/novnc/rfb.min.js
cleanup_vnc_assets
trap - EXIT
```

Expected: tests、base-path dev server 和 build 全部退出 0；MIME headers 正确；所有 `cmp`
证明 dev/build 输出与内部源文件及移动前受版本控制内容字节相同。

- [ ] **Step 6: 提交静态资源迁移**

Run:

```bash
git add -A -- wework/vite.config.ts wework/src/lib/vnc.test.ts wework/wecode/features/vnc/viteAssets.ts wework/wecode/features/vnc/viteAssets.test.ts wework/wecode/features/vnc/assets wework/public/vnc.html wework/public/novnc/rfb.min.js
git diff --cached --check
git commit -m "refactor(wework): move VNC assets into wecode"
```

Expected: commit 成功，rename 保留历史；不提交 `wework/dist`。

## Task 3: 将 Tauri VNC 会话模块移入 Wecode

**Files:**

- Move: `wework/src-tauri/src/vnc_session.rs` → `wework/src-tauri/src/wecode/vnc_session.rs`
- Modify: `wework/src-tauri/src/wecode/mod.rs`
- Modify: `wework/src-tauri/src/lib.rs`

- [ ] **Step 1: 移动模块并确认旧注册路径编译失败**

Run:

```bash
git mv wework/src-tauri/src/vnc_session.rs wework/src-tauri/src/wecode/vnc_session.rs
cargo test --manifest-path wework/src-tauri/Cargo.toml --locked --lib
```

Expected: FAIL，`lib.rs` 的根级 `mod vnc_session` 找不到文件；这是目标结构尚未接线的预期失败。

- [ ] **Step 2: 更新模块、state 和 handler 路径**

Modify `wework/src-tauri/src/wecode/mod.rs`:

```rust
pub mod local_executor;
pub mod vnc_session;
```

Remove `mod vnc_session;` from `lib.rs`, then use these exact paths:

```rust
.manage(wecode::vnc_session::VncSessionState::default())
```

```rust
wecode::vnc_session::get_vnc_session_config,
wecode::vnc_session::prepare_vnc_session,
```

In both page-security tests, replace the relative include with the stable manifest path:

```rust
let html = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../wecode/features/vnc/assets/vnc.html"
));
```

- [ ] **Step 3: 验证 Rust 行为和格式不变**

Run:

```bash
cargo fmt --manifest-path wework/src-tauri/Cargo.toml -- --check
cargo test --manifest-path wework/src-tauri/Cargo.toml --locked --lib
```

Expected: 格式检查退出 0；全部 lib tests 通过，测试模块名变为 `wecode::vnc_session::tests::*`。

- [ ] **Step 4: 提交 Rust 模块迁移**

Run:

```bash
git add -A -- wework/src-tauri/src/lib.rs wework/src-tauri/src/wecode/mod.rs wework/src-tauri/src/wecode/vnc_session.rs wework/src-tauri/src/vnc_session.rs
git diff --cached --check
git commit -m "refactor(wework): move VNC session into wecode"
```

Expected: commit 成功；IPC 函数名和 Tauri handler 名没有变化。

## Task 4: 建立云桌面扩展并迁移 VNC 前端实现

**Files:**

- Create: `wework/src/extensions/cloud-desktop-contract.ts`
- Create: `wework/src/extensions/cloud-desktop.tsx`
- Create: `wework/src/components/settings/DeviceActionButton.tsx`
- Create: `wework/wecode/extensions/cloud-desktop.tsx`
- Create: `wework/wecode/features/vnc/api.ts`
- Create: `wework/wecode/features/vnc/api.test.ts`
- Move: `wework/src/lib/vnc.ts` → `wework/wecode/features/vnc/session.ts`
- Move: `wework/src/lib/vnc.test.ts` → `wework/wecode/features/vnc/session.test.ts`
- Create: `wework/wecode/features/vnc/openCloudDesktop.ts`
- Create: `wework/wecode/features/vnc/openCloudDesktop.test.ts`
- Create: `wework/wecode/features/vnc/VncDesktopButton.tsx`
- Create: `wework/wecode/features/vnc/VncDesktopButton.test.tsx`
- Modify: `wework/src/components/settings/ConnectionsSettingsPage.tsx`
- Modify: `wework/src/components/settings/ConnectionsSettingsPage.test.tsx`
- Modify: `wework/src/components/layout/workspace-panels/WorkspacePanelCards.tsx`
- Modify: `wework/src/components/layout/workspace-panels/WorkspacePanelCards.test.tsx`
- Modify: `wework/src/components/layout/workspace-panels/WorkspaceBrowserPanel.tsx`
- Modify: `wework/src/components/layout/workspace-panels/WorkspaceBrowserPanel.test.tsx`
- Modify: `wework/src/components/layout/DesktopWorkbenchLayout.test.tsx`
- Modify: `wework/src/api/devices.ts`
- Modify: `wework/src/types/devices.ts`
- Modify: `wework/wecode/api/devices.ts`
- Modify: `wework/wecode/types/devices.ts`

- [ ] **Step 1: 读取 Wework UI 约束并锁定无视觉变化边界**

Run:

```bash
sed -n '1,320p' wework/DESIGN.md
```

Expected: 实现继续复用现有 `h-7 w-7` 设备操作按钮、语义错误色、翻译键和
`data-testid`；不新增字号、颜色、间距或桌面布局。

- [ ] **Step 2: 写 feature API 和共享打开流程失败测试**

Create `wework/wecode/features/vnc/api.test.ts` with a mocked `createHttpClient` and assert the
active connection is used:

```ts
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createHttpClient } from "@/api/http";
import { getVncConfig } from "./api";

vi.mock("@/api/http", () => ({ createHttpClient: vi.fn() }));

describe("getVncConfig", () => {
  const get = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createHttpClient).mockReturnValue({ get } as never);
    get.mockResolvedValue({
      wss_url: "",
      signature: "",
      sandbox_id: "sandbox-1",
    });
  });

  test("uses the active cloud API, bearer token, and encoded device id", async () => {
    const connection = {
      isConnected: true,
      apiBaseUrl: "https://cloud.example.com/api",
      socketBaseUrl: "https://cloud.example.com",
      token: "cloud-token",
    };
    await getVncConfig(connection, "device/1");
    expect(createHttpClient).toHaveBeenCalledWith({
      baseUrl: "https://cloud.example.com/api",
      getToken: expect.any(Function),
      redirectOnUnauthorized: false,
    });
    const options = vi.mocked(createHttpClient).mock.calls[0][0];
    expect(options.getToken?.()).toBe("cloud-token");
    expect(get).toHaveBeenCalledWith("/cloud-devices/device%2F1/vnc-config");
  });

  test("rejects a disconnected or incomplete cloud connection", async () => {
    await expect(
      getVncConfig({ isConnected: false, token: null }, "device-1"),
    ).rejects.toThrow("Cloud connection is required");
    expect(createHttpClient).not.toHaveBeenCalled();
  });
});
```

Create `openCloudDesktop.test.ts` and mock `api`, `session`, and the common browser request:

```ts
import { beforeEach, describe, expect, test, vi } from "vitest";
import { requestEmbeddedBrowserOpen } from "@/lib/embedded-browser";
import { getVncConfig } from "./api";
import { buildVncPageUrl, prepareVncSession } from "./session";
import { openCloudDesktop } from "./openCloudDesktop";

vi.mock("@/lib/embedded-browser", () => ({
  requestEmbeddedBrowserOpen: vi.fn(),
}));
vi.mock("./api", () => ({ getVncConfig: vi.fn() }));
vi.mock("./session", () => ({
  buildVncPageUrl: vi.fn(),
  prepareVncSession: vi.fn(),
}));

const connection = {
  isConnected: true,
  apiBaseUrl: "https://cloud.example.com/api",
  socketBaseUrl: "https://cloud.example.com",
  token: "cloud-token",
};

describe("openCloudDesktop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getVncConfig).mockResolvedValue({
      wss_url: "",
      signature: "",
      sandbox_id: "sandbox-1",
    });
    vi.mocked(prepareVncSession).mockResolvedValue("session-1");
    vi.mocked(buildVncPageUrl).mockReturnValue(
      "tauri://localhost/vnc.html?sessionId=session-1",
    );
    vi.mocked(requestEmbeddedBrowserOpen).mockReturnValue(true);
  });

  test("opens a credential-free local page", async () => {
    await expect(
      openCloudDesktop({
        connection,
        deviceId: "device-1",
        isCurrent: () => true,
      }),
    ).resolves.toBe(true);
    expect(prepareVncSession).toHaveBeenCalledWith({
      deviceId: "device-1",
      socketBaseUrl: "https://cloud.example.com",
      token: "cloud-token",
    });
    expect(requestEmbeddedBrowserOpen).toHaveBeenCalledWith(
      "tauri://localhost/vnc.html?sessionId=session-1",
    );
  });

  test.each([1, 2])(
    "drops a stale request after asynchronous stage %s",
    async (staleStage) => {
      let checks = 0;
      const result = await openCloudDesktop({
        connection,
        deviceId: "device-1",
        isCurrent: () => {
          checks += 1;
          return checks < staleStage;
        },
      });
      expect(result).toBe(false);
      if (staleStage === 1) expect(prepareVncSession).not.toHaveBeenCalled();
      if (staleStage === 2)
        expect(requestEmbeddedBrowserOpen).not.toHaveBeenCalled();
    },
  );

  test("rejects missing sandbox ids and browser refusal", async () => {
    vi.mocked(getVncConfig).mockResolvedValueOnce({
      wss_url: "",
      signature: "",
      sandbox_id: "",
    });
    await expect(
      openCloudDesktop({
        connection,
        deviceId: "device-1",
        isCurrent: () => true,
      }),
    ).rejects.toThrow("Desktop sandbox ID is missing");
    vi.mocked(getVncConfig).mockResolvedValueOnce({
      wss_url: "",
      signature: "",
      sandbox_id: "sandbox-1",
    });
    vi.mocked(requestEmbeddedBrowserOpen).mockReturnValueOnce(false);
    await expect(
      openCloudDesktop({
        connection,
        deviceId: "device-1",
        isCurrent: () => true,
      }),
    ).rejects.toThrow("Built-in browser is unavailable");
  });
});
```

- [ ] **Step 3: 移动现有 session 测试、添加按钮测试并确认 RED**

Run:

```bash
git mv wework/src/lib/vnc.ts wework/wecode/features/vnc/session.ts
git mv wework/src/lib/vnc.test.ts wework/wecode/features/vnc/session.test.ts
pnpm --filter wework test -- wecode/features/vnc/api.test.ts wecode/features/vnc/openCloudDesktop.test.ts wecode/features/vnc/session.test.ts wecode/features/vnc/VncDesktopButton.test.tsx
```

Expected: FAIL，因为 API、共享 opener、按钮和更新后的 import 尚未实现；session 测试也需要把 `./vnc` 改为 `./session`。

`VncDesktopButton.test.tsx` 必须迁入设置页现有七类行为：成功后 `onOpened`、浏览器拒绝、配置失败、加载防重复、连接切换丢弃旧响应、离线禁用、失败后重试成功。继续使用现有 `connection-vnc-button-device-1` 与 `connection-vnc-error-device-1` 断言。

- [ ] **Step 4: 实现公共契约、fallback、API 和共享 opener**

Create `wework/src/extensions/cloud-desktop-contract.ts`:

```ts
import type { ComponentType } from "react";

export interface CloudDesktopConnection {
  apiBaseUrl?: string;
  isConnected: boolean;
  socketBaseUrl?: string;
  token: string | null;
}

export interface CloudDesktopActionProps {
  deviceId: string;
  disabled: boolean;
  onOpened: () => void;
}

export interface OpenCloudDesktopOptions {
  connection: CloudDesktopConnection;
  deviceId: string;
  isCurrent: () => boolean;
}

export interface CloudDesktopExtension {
  available: boolean;
  DeviceAction: ComponentType<CloudDesktopActionProps>;
  isInternalPageUrl: (value: string) => boolean;
  open: (options: OpenCloudDesktopOptions) => Promise<boolean>;
}
```

Create `wework/src/extensions/cloud-desktop.tsx`:

```tsx
import type { CloudDesktopExtension } from "./cloud-desktop-contract";

export const cloudDesktopExtension: CloudDesktopExtension = {
  available: false,
  DeviceAction: () => null,
  isInternalPageUrl: () => false,
  open: async () => {
    throw new Error("Cloud desktop extension is unavailable");
  },
};
```

Create `wework/wecode/features/vnc/api.ts`:

```ts
import { createHttpClient } from "@/api/http";
import type { CloudDesktopConnection } from "@/extensions/cloud-desktop-contract";

export interface VncConfigResponse {
  sandbox_id: string;
  signature: string;
  wss_url: string;
}

export async function getVncConfig(
  connection: CloudDesktopConnection,
  deviceId: string,
): Promise<VncConfigResponse> {
  if (!connection.isConnected || !connection.apiBaseUrl || !connection.token) {
    throw new Error("Cloud connection is required");
  }
  const client = createHttpClient({
    baseUrl: connection.apiBaseUrl,
    getToken: () => connection.token,
    redirectOnUnauthorized: false,
  });
  return client.get<VncConfigResponse>(
    `/cloud-devices/${encodeURIComponent(deviceId)}/vnc-config`,
  );
}
```

Create `wework/wecode/features/vnc/openCloudDesktop.ts`:

```ts
import { requestEmbeddedBrowserOpen } from "@/lib/embedded-browser";
import type { OpenCloudDesktopOptions } from "@/extensions/cloud-desktop-contract";
import { getVncConfig } from "./api";
import { buildVncPageUrl, prepareVncSession } from "./session";

export async function openCloudDesktop({
  connection,
  deviceId,
  isCurrent,
}: OpenCloudDesktopOptions): Promise<boolean> {
  if (!connection.socketBaseUrl || !connection.token) {
    throw new Error("Cloud connection is required");
  }
  const config = await getVncConfig(connection, deviceId);
  if (!isCurrent()) return false;
  if (!config.sandbox_id) throw new Error("Desktop sandbox ID is missing");
  const sessionId = await prepareVncSession({
    deviceId,
    socketBaseUrl: connection.socketBaseUrl,
    token: connection.token,
  });
  if (!isCurrent()) return false;
  const pageUrl = buildVncPageUrl({ sandboxId: config.sandbox_id, sessionId });
  if (!requestEmbeddedBrowserOpen(pageUrl)) {
    throw new Error("Built-in browser is unavailable");
  }
  return true;
}
```

Update moved `session.ts` imports to `@/config/runtime`, and update `session.test.ts` imports and asset path to the feature-local files.

- [ ] **Step 5: 提取通用按钮并迁移设置页操作组件**

Create `wework/src/components/settings/DeviceActionButton.tsx` by moving the existing local
`DeviceActionButton` function without changing its markup, classes, aria attributes or test ID:

```tsx
import type { ComponentType } from "react";

export function DeviceActionButton({
  testId,
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  testId: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}
```

Move the existing `VncDesktopButton` state machine into
`wework/wecode/features/vnc/VncDesktopButton.tsx`. Keep its generation-based stale-request guards,
but replace the inline API/session/browser sequence with:

```ts
const opened = await openCloudDesktop({
  connection: cloudConnection,
  deviceId,
  isCurrent: isCurrentRequest,
});
if (opened) onOpened();
```

Use the extracted public `DeviceActionButton`, `Monitor`, `useOptionalCloudConnection`, and the
existing translation keys. Preserve the exact error rendering:

```tsx
<p
  role="alert"
  data-testid={`connection-vnc-error-${deviceId}`}
  className="max-w-48 text-right text-xs text-red-500"
>
  {error}
</p>
```

Create `wework/wecode/extensions/cloud-desktop.tsx`:

```tsx
import type { CloudDesktopExtension } from "@/extensions/cloud-desktop-contract";
import { VncDesktopButton } from "@wecode/features/vnc/VncDesktopButton";
import { isInternalVncPageUrl } from "@wecode/features/vnc/session";
import { openCloudDesktop } from "@wecode/features/vnc/openCloudDesktop";

export const cloudDesktopExtension: CloudDesktopExtension = {
  available: true,
  DeviceAction: VncDesktopButton,
  isInternalPageUrl: isInternalVncPageUrl,
  open: openCloudDesktop,
};
```

- [ ] **Step 6: 将三个公共宿主切到扩展边界**

In `ConnectionsSettingsPage.tsx`, import `cloudDesktopExtension` and the shared button, remove the
local VNC component, and destructure the extension component once at module scope:

```ts
const CloudDesktopDeviceAction = cloudDesktopExtension.DeviceAction;
```

Render:

```tsx
{
  canUseCloudSessions && cloudDesktopExtension.available && (
    <CloudDesktopDeviceAction
      deviceId={device.device_id}
      disabled={!isOnline}
      onOpened={onVncDesktopOpened}
    />
  );
}
```

In `WorkspacePanelCards.tsx`, remove `createCloudDeviceSessionApi` and replace the VNC-specific
sequence with:

```ts
const opened = await cloudDesktopExtension.open({
  connection: cloudConnection,
  deviceId: activeWorkspaceDeviceId,
  isCurrent: isCurrentRequest,
});
if (!opened) return;
```

Add `cloudDesktopExtension.available` to desktop tool visibility/disabled conditions so the public
fallback never exposes a broken action.

In `WorkspaceBrowserPanel.tsx`, replace every `isInternalVncPageUrl(value)` call with
`cloudDesktopExtension.isInternalPageUrl(value)`. Keep annotation cleanup and external-open rules
unchanged.

- [ ] **Step 7: 删除公开和重复的 VNC API/type**

Delete `getVncConfig` and its `VncConfigResponse` import from `src/api/devices.ts`; delete
`VncConfigResponse` from `src/types/devices.ts`. Remove the duplicate method/import from
`wecode/api/devices.ts` and the duplicate interface from `wecode/types/devices.ts`.

Run:

```bash
rg -n "VncConfigResponse|getVncConfig|@/lib/vnc" wework/src wework/wecode
```

Expected: matches exist only in `wecode/features/vnc` tests/implementation and intentional test
fixture names; no public API/type/helper definition remains.

- [ ] **Step 8: 调整宿主测试并运行 focused GREEN 验证**

Move the VNC button behavior cases from `ConnectionsSettingsPage.test.tsx` into
`VncDesktopButton.test.tsx`. In public host tests, mock `@extensions/cloud-desktop` with an
`available: true` extension whose `DeviceAction` renders the preserved test ID and whose `open` is a
`vi.fn()`; assert only render/onOpened and workspace/browser integration.

Keep `DesktopWorkbenchLayout.test.tsx` as one real internal-overlay integration test. Change its
VNC config mock from `createDeviceApi.getVncConfig` to the `createHttpClient().get` path used by
`wecode/features/vnc/api.ts`; preserve the assertions for `/vnc.html`, no token in URL,
`prepare_vnc_session`, disabled annotation/external buttons and stable `nativeLabel`.

Run:

```bash
pnpm --filter wework test -- wecode/features/vnc/api.test.ts wecode/features/vnc/session.test.ts wecode/features/vnc/openCloudDesktop.test.ts wecode/features/vnc/VncDesktopButton.test.tsx src/components/settings/ConnectionsSettingsPage.test.tsx src/components/layout/workspace-panels/WorkspacePanelCards.test.tsx src/components/layout/workspace-panels/WorkspaceBrowserPanel.test.tsx src/components/layout/DesktopWorkbenchLayout.test.tsx src/lib/browser-url.test.ts
pnpm --filter wework exec prettier --check src/extensions/cloud-desktop-contract.ts src/extensions/cloud-desktop.tsx src/components/settings/DeviceActionButton.tsx wecode/extensions/cloud-desktop.tsx wecode/features/vnc/api.ts wecode/features/vnc/api.test.ts wecode/features/vnc/session.ts wecode/features/vnc/session.test.ts wecode/features/vnc/openCloudDesktop.ts wecode/features/vnc/openCloudDesktop.test.ts wecode/features/vnc/VncDesktopButton.tsx wecode/features/vnc/VncDesktopButton.test.tsx src/components/settings/ConnectionsSettingsPage.tsx src/components/settings/ConnectionsSettingsPage.test.tsx src/components/layout/workspace-panels/WorkspacePanelCards.tsx src/components/layout/workspace-panels/WorkspacePanelCards.test.tsx src/components/layout/workspace-panels/WorkspaceBrowserPanel.tsx src/components/layout/workspace-panels/WorkspaceBrowserPanel.test.tsx src/components/layout/DesktopWorkbenchLayout.test.tsx src/api/devices.ts src/types/devices.ts wecode/api/devices.ts wecode/types/devices.ts
pnpm --filter wework exec eslint src/extensions/cloud-desktop-contract.ts src/extensions/cloud-desktop.tsx src/components/settings/DeviceActionButton.tsx wecode/extensions/cloud-desktop.tsx wecode/features/vnc/api.ts wecode/features/vnc/api.test.ts wecode/features/vnc/session.ts wecode/features/vnc/session.test.ts wecode/features/vnc/openCloudDesktop.ts wecode/features/vnc/openCloudDesktop.test.ts wecode/features/vnc/VncDesktopButton.tsx wecode/features/vnc/VncDesktopButton.test.tsx src/components/settings/ConnectionsSettingsPage.tsx src/components/settings/ConnectionsSettingsPage.test.tsx src/components/layout/workspace-panels/WorkspacePanelCards.tsx src/components/layout/workspace-panels/WorkspacePanelCards.test.tsx src/components/layout/workspace-panels/WorkspaceBrowserPanel.tsx src/components/layout/workspace-panels/WorkspaceBrowserPanel.test.tsx src/components/layout/DesktopWorkbenchLayout.test.tsx src/api/devices.ts src/types/devices.ts wecode/api/devices.ts wecode/types/devices.ts
pnpm --filter wework typecheck
```

Expected: focused tests、格式、lint 和类型检查全部退出 0；原有 `data-testid` 不变。

- [ ] **Step 9: 提交前端 feature 与扩展迁移**

Run:

```bash
git add -A -- wework/src/extensions/cloud-desktop-contract.ts wework/src/extensions/cloud-desktop.tsx wework/src/components/settings/DeviceActionButton.tsx wework/wecode/extensions/cloud-desktop.tsx wework/wecode/features/vnc wework/src/components/settings/ConnectionsSettingsPage.tsx wework/src/components/settings/ConnectionsSettingsPage.test.tsx wework/src/components/layout/workspace-panels/WorkspacePanelCards.tsx wework/src/components/layout/workspace-panels/WorkspacePanelCards.test.tsx wework/src/components/layout/workspace-panels/WorkspaceBrowserPanel.tsx wework/src/components/layout/workspace-panels/WorkspaceBrowserPanel.test.tsx wework/src/components/layout/DesktopWorkbenchLayout.test.tsx wework/src/api/devices.ts wework/src/types/devices.ts wework/wecode/api/devices.ts wework/wecode/types/devices.ts wework/src/lib/vnc.ts wework/src/lib/vnc.test.ts
git diff --cached --check
git commit -m "refactor(wework): isolate VNC in wecode"
```

Expected: commit 成功；`git status --short` 不包含源代码改动。

## Task 5: 完成全量与真实桌面验证

**Files:**

- Verify: all files changed by Tasks 1–4
- Evidence: the diagnostics directory printed by `pnpm --filter wework e2e:desktop`
- Evidence: the isolated session directory printed by `pnpm --filter wework ai:verify start`

- [ ] **Step 1: 定义并执行 QA 主路径、边界与恢复用例**

QA cases:

1. 前置：在线 cloud device、有效 Cloud Connection、默认浏览器逻辑标签可用。步骤：从连接设置点击“桌面”。预期：退出设置，右侧浏览器展示 `/vnc.html`，URL 仅有 `sessionId`/`sandboxId`，RFB 进入 connected。
2. 前置：默认逻辑标签已打开后 relabel 给旧 owner。步骤：再次从云设备打开桌面。预期：创建新的唯一原生 WebView，无 `already exists`。
3. 前置：VNC 配置请求失败一次。步骤：首次点击失败，再次点击。预期：显示现有错误，第二次成功，无系统浏览器 fallback。
4. 前置：配置请求未完成。步骤：切换设备、项目或 Cloud Connection。预期：旧响应被丢弃，不打开旧桌面。
5. 前置：production build。步骤：检查 dist 并从真实 Tauri 加载。预期：`vnc.html` 和 noVNC bundle 均从新源码位置发布且相对路径可用。
6. 清理：关闭 VNC browser 和 regression owner，停止隔离 Tauri session，确认临时 auth link/process group 被移除。

- [ ] **Step 2: 运行全量静态、单元和构建验证**

Run:

```bash
cargo fmt --manifest-path wework/src-tauri/Cargo.toml -- --check
cargo test --manifest-path wework/src-tauri/Cargo.toml --locked --lib
pnpm --filter wework test
pnpm --filter wework lint
pnpm --filter wework typecheck
pnpm --filter wework build
git diff --check
```

Expected: 全部退出 0；Vite build 包含稳定 VNC 资源路径。

- [ ] **Step 3: 运行真实 Desktop E2E**

Run:

```bash
pnpm --filter wework e2e:desktop
```

Expected: `Wework desktop task-flow E2E passed`；HTTP Bearer、WebSocket token、RFB 3.8
握手、connected 标记、右侧浏览器和 relabel 回归全部通过。记录新的 diagnostics 目录。

- [ ] **Step 4: 在隔离 Tauri 会话验证真实资源与回归路径**

Run:

```bash
pnpm --filter wework ai:verify start
```

保存返回的 session path，不打印其文件内容。使用 `snapshot`、现有 E2E bridge 或稳定
`data-testid` 完成 QA cases 1、2、5；检查 app log 不含 `already exists` 或资源 404。最后：

```bash
WEWORK_VNC_VERIFY_SESSION="$(find wework/test-results/ai-verify -mindepth 1 -maxdepth 1 -type d -mmin -10 -print | sort | tail -1)"
test -n "$WEWORK_VNC_VERIFY_SESSION"
pnpm --filter wework ai:verify stop --session "$WEWORK_VNC_VERIFY_SESSION"
```

Expected: 主路径和 relabel 后重开均成功；`stop` 成功清理隔离进程与认证链接。命令中的
session path 必须使用 `start` 实际返回值，不得写入仓库或最终答复。

- [ ] **Step 5: 处理验证失败而不扩大提交范围**

任何验证命令失败时停止 push，回到拥有该行为的 Task：assets 回到 Task 2，Rust/IPC 回到
Task 3，前端入口、竞态或页面策略回到 Task 4。先在该 Task 已列出的测试文件加入失败用例，
确认 RED 后修改同一 Task 已列出的实现文件，并重复该 Task 的 GREEN 命令与本 Task
Steps 2–4。不得提交 `test-results`、session 文件、日志或构建产物。

## Task 6: 推送当前分支

- [ ] **Step 1: 确认分支、提交序列和工作区**

Run:

```bash
git branch --show-current
git status --short
git log --oneline --decorate origin/feature/wework-cloud-device-vnc-browser..HEAD
```

Expected: 分支为 `feature/wework-cloud-device-vnc-browser`；工作区干净；日志包含设计、原生
身份修复、assets、Rust session、前端 feature 和计划提交。

- [ ] **Step 2: 在独立后台进程 push 并等待 pre-push checks**

Run:

```bash
git push origin feature/wework-cloud-device-vnc-browser > /tmp/wegent-vnc-wecode-push.log 2>&1 &
push_pid=$!
wait "$push_pid"
push_status=$?
tail -80 /tmp/wegent-vnc-wecode-push.log
exit "$push_status"
```

Expected: push 退出 0，远端分支更新到本地 HEAD；不得跳过 Husky 或 pre-push checks。

- [ ] **Step 3: 验证本地与远端完全一致**

Run:

```bash
git fetch origin feature/wework-cloud-device-vnc-browser
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/feature/wework-cloud-device-vnc-browser)"
git status --short
```

Expected: SHA 相同且工作区为空。
