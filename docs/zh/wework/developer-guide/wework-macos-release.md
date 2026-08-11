---
sidebar_position: 27
---

# Wework macOS 发布

[English](../../en/developer-guide/wework-macos-release.md) | 简体中文

Wework macOS 应用使用 Tauri updater 支持自动升级。本地或独立发布由 `wework/scripts/release-mac-app.sh` 负责；GitHub Release 由 `.github/workflows/wework-app.yml` 构建和发布。

## 发布模型

- 默认构建 `universal-apple-darwin`，生成一个同时支持 Apple Silicon 和 Intel Mac 的安装包。
- updater manifest 同时写入 `darwin-aarch64` 和 `darwin-x86_64`，两个平台可以指向同一个 universal archive。
- `src-tauri/tauri.conf.json` 不保存发布服务地址或 updater 公钥。本地发布脚本和 GitHub Actions 都通过 `wework/scripts/generate-release-config.mjs` 生成临时 Tauri config，在注入发布参数的同时完整保留基础配置中的 `bundle.resources`。Tauri config 覆盖会整体替换资源数组，因此发布路径不能单独维护一份不完整的 resources 列表。
- updater 私钥和发布 token 只通过环境变量或本机文件读取，不提交到仓库。
- Codex CLI 不在本地编译。构建前通过 `wework/scripts/prepare-codex-binary.mjs` 按 `wework/codex-binaries.lock.json` 下载 npm tarball，校验 SHA-512 integrity 后打进 Tauri resources。

## Bundled Codex 二进制

Wework 桌面包会直接附带 Codex CLI，避免用户在首次运行时再安装。版本和每个平台的 tarball 校验值由 `wework/codex-binaries.lock.json` 固定。

当前固定版本为稳定版 Codex `0.147.0`。升级时必须同时更新所有支持平台的 npm
包版本、官方 registry tarball 地址与 SHA-512 integrity 值；不能直接替换已签名
应用包中的二进制。请通过发布构建重新准备 sidecar、打包并代码签名。

本地构建会自动准备当前目标平台的 Codex：

```bash
pnpm --filter wework run prepare:codex
```

macOS universal 构建会同时准备 Apple Silicon 和 Intel 版本：

```bash
cd wework
WEWORK_CODEX_TARGET=universal-apple-darwin pnpm run prepare:codex
```

Codex 的下载包和解压后的二进制默认缓存到用户级目录，多个 worktree 会复用同一份缓存。macOS 默认目录为 `~/Library/Caches/wegent/codex`；如需自定义，可设置 `WEGENT_CODEX_CACHE_DIR`。开发准备阶段只在 `src-tauri/binaries/codex` 下创建指向缓存的链接，发布构建会自动使用 `--materialize` 将文件物化到当前 worktree，以便 Tauri 打包和代码签名。

release 构建会在 `wework/src-tauri/build.rs` 中校验目标平台的 Codex 二进制存在；缺失时构建会失败。运行时 Wework 会把 bundled Codex 路径注入本地 executor sidecar：

- `CODEX_BINARY_PATH`
- `CODEX_MANAGED_PACKAGE_ROOT`

如果用户已经显式设置 `CODEX_BINARY_PATH` 或 `CODEX_BIN`，Wework 不会覆盖用户配置。

## 环境变量

发布前需要在当前 shell 中提供这些变量：

```bash
export WEWORK_UPDATE_BASE_URL=https://example.com/wework/update
export WEWORK_UPDATE_PUBLISH_TOKEN=...
export TAURI_UPDATER_PUBKEY=...
```

updater 私钥可以通过 `TAURI_SIGNING_PRIVATE_KEY` 直接提供，也可以使用默认文件路径 `~/.tauri/wework-updater.key`：

```bash
export TAURI_SIGNING_PRIVATE_KEY=...
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=...
```

生产发布还需要 Developer ID 签名和 Apple notarization 配置：

```bash
export MACOS_APP_SIGN_IDENTITY="Developer ID Application: Example (TEAMID)"
export MACOS_NOTARY_PROFILE=wework-notary
```

也可以用 Apple ID、Team ID 和 app-specific password 生成 notary profile：

```bash
export APPLE_BUILD_ID=...
export APPLE_BUILD_TEAM_ID=...
export APPLE_BUILD_PASSWORD=...
```

## 本地验证

本地验证会生成 local updater 目录，默认地址是 `http://127.0.0.1:8787/dist/wework`：

```bash
cd wework
scripts/release-mac-app.sh --target local --version 0.1.99 --notes "Local verification."
```

如果要验证 local updater，启动一个静态文件服务指向脚本输出目录：

```bash
python3 -m http.server 8787 --directory src-tauri/target/release/local-update-server
```

## 窗口表面

Wework 主窗口和独立工作区窗口必须使用不透明的 Tauri 窗口，并由 WebView
中的主题表面色完整覆盖。不要为这些窗口启用 `transparent`、`windowEffects`
或原生 vibrancy 材质；不同 macOS 版本和图形环境对透明窗口边缘的合成结果不一致，
可能显示为透出桌面、半透明描边或灰色边框。

系统拖拽面板和 Popout Window 是独立的轻量浮层，不受该约束。修改普通窗口的背景、
标题栏或创建参数时，需要同时验证主窗口和独立工作区窗口，并保留自动化断言，确保
两者不会重新启用原生透明效果。

## Tauri 依赖升级

升级 Tauri 时需要同时维护 Rust 核心依赖和前端工具链，避免开发、测试与发布使用不同版本：

- 在 `wework/src-tauri/Cargo.toml` 中升级 `tauri` 和兼容的 `tauri-build`，并刷新 `wework/src-tauri/Cargo.lock`。
- 在 `wework/package.json` 中升级 `@tauri-apps/api` 和 `@tauri-apps/cli`，并刷新仓库根目录的 `pnpm-lock.yaml`。
- Tauri 插件独立发布，不要求与核心包使用相同版本号；只升级与当前核心版本兼容且变更确实需要的插件。
- 升级后至少运行 Wework TypeScript 类型检查、Vitest、Rust 测试和格式检查。窗口、托盘、IPC、asset protocol 或打包链路发生变化时，还必须使用 `pnpm --filter wework ai:verify` 启动隔离的真实 Tauri 应用验证，不能只依赖浏览器或 mock 测试。

如果多个 worktree 同时运行桌面验证，应为每个实例设置独立的 `WEWORK_PORT`。共享 Cargo target 会串行协调编译；首次升级依赖时，本机 executor 的编译可能超过普通界面启动等待时间，应结合隔离会话下的 Tauri 和 executor 日志确认它仍在编译，而不是把慢启动误判为运行时失败。

## GitHub Release 自动更新

仓库提供 `.github/workflows/wework-app.yml`，用于在 GitHub Actions 上生成 macOS DMG、Windows installer、Tauri updater archive、签名文件和 updater manifest。客户端内置的 updater endpoint 指向固定的 `wework-updater` Release，并通过 Tauri 的 `target` 和 `arch` 占位符选择更新渠道与平台：

```text
https://github.com/<owner>/<repo>/releases/download/wework-updater/{{target}}-{{arch}}.json
```

macOS CI job 不调用 `release-mac-app.sh`，但两条发布路径共享 `wework/scripts/generate-release-config.mjs`。该生成器从 `src-tauri/tauri.conf.json` 复制完整的 `bundle.resources`，确保 Codex、hooks、bundled plugins 及隐藏的 marketplace manifests 都进入正式发布包。修改桌面资源清单时应更新基础 Tauri 配置，不要在 workflow 中重新复制资源列表。

workflow 只能通过 GitHub Actions 手动触发，不会响应 tag push。启动 workflow 时选择发布渠道：

- `stable`：发布正式版。`version` 可以留空并自动增加最新正式版的 patch，也可以填写 `X.Y.Z` 覆盖。
- `beta`：发布 Beta 版。不要填写版本；workflow 总是根据现有正式版和 Beta tag 自动生成下一个 `X.Y.Z-beta.N`。
- `publish_release=false`：只生成测试 artifacts，不提交版本文件或发布 Release。
- `publish_release=true`：同步版本文件、构建签名产物并发布 GitHub Release。

例如最新正式版是 `1.2.3` 时，第一次 Beta 发布得到 `1.2.4-beta.1`，后续依次得到 `1.2.4-beta.2`、`1.2.4-beta.3`。正式发布 `1.2.4` 后，下一个自动 Beta 是 `1.2.5-beta.1`。

正式发布会创建或更新 `wework-v<version>` draft release。Release changelog 会收集自上一个 Wework tag 以来 `wework/` 和 `executor/` 下的提交；首次发布没有上一个 tag 时，会收集当前发布提交可达的全部匹配历史。通过 squash PR 合入的条目会包含 PR 编号和 `@贡献者`，直接提交则保留短 commit SHA，并在 GitHub 能识别作者账号时包含 `@贡献者`。构建完成后，workflow 生成该版本自己的 `latest.json` 并上传到同一个 Release，再发布 Release。正式版设置为 GitHub latest；Beta 设置为 prerelease，不改变 GitHub latest。禁止 tag push 自动触发可以避免 workflow 创建 tag 时再次启动同版本构建并覆盖已签名产物。

发布完成后，workflow 更新固定 `wework-updater` Release 中的滚动 manifest：

- `stable-*` 只指向最新正式版。
- `beta-*` 指向 Beta 和正式版中 SemVer 更高的版本，因此选择 Beta 的用户也会收到更新的正式版。
- 新版本只有在 SemVer 高于当前渠道版本时才覆盖滚动 manifest，历史发布或较低版本不会让用户降级。

用户可以在 Wework 的“设置 → 关于”中打开“接收 Beta 版本更新”。默认关闭时客户端使用 `stable` target；打开后使用 `beta` target。切换后立即检查更新，并把选择保存在本机。

updater manifest 中的 `notes` 会作为该版本的更新日志随安装流程保存。新版本第一次启动后，Wework 不会自动弹出更新日志，而是在桌面侧边栏底部、账户区域上方显示固定提示。用户点击提示后可以查看 Markdown 格式的更新内容；关闭详情不会移除提示，只有点击提示卡上的关闭按钮才会清除，并且清除状态在应用重载后保持。保存的版本号必须与当前运行版本一致，否则客户端会丢弃这份过期记录。

GitHub Actions 需要配置这些 repository secrets：

- `TAURI_SIGNING_PRIVATE_KEY`：Tauri updater 私钥。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码；如果私钥无密码可以留空。
- `TAURI_UPDATER_PUBKEY`：与私钥匹配的 updater 公钥，会被注入到构建产物中。

不要轮换 updater 私钥，除非可以接受旧客户端无法继续自动升级。Tauri 会用已安装客户端内置的公钥校验新版本签名。

workflow 分别上传这些 Release assets：

- `WeWork_<version>_macos_arm64_unsigned-adhoc.dmg`
- `WeWork_<version>_macos_x64_unsigned-adhoc.dmg`
- `WeWork_<version>_macos_arm64.app.tar.gz`
- `WeWork_<version>_macos_arm64.app.tar.gz.sig`
- `WeWork_<version>_macos_x64.app.tar.gz`
- `WeWork_<version>_macos_x64.app.tar.gz.sig`
- `latest.json`

从 GitHub Release assets 下载时，下载链接本身就是 `.dmg` 文件，不会被 Actions artifact 额外套一层 `.zip`。正式渠道未填写版本时，会基于最新正式版 `wework-vX.Y.Z` tag 增加 patch；Beta 渠道始终自动生成版本，不读取 `version` 输入。

正式发布时，workflow 会在构建前把 `wework/package.json`、`wework/src-tauri/tauri.conf.json`、`wework/src-tauri/Cargo.toml` 和 `wework/src-tauri/Cargo.lock` 同步到本次 release version，并直接提交回触发 workflow 的 `main` 分支。后续 macOS 构建和 GitHub Release 都会使用这个版本提交，确保关于页版本、Tauri 包版本和源码版本一致。

手动触发但未勾选正式发布时只生成测试 artifacts，不会提交版本文件。也可以在 GitHub Actions 中选择已有的正式版或 Beta `wework-v<version>` tag 后手动运行 workflow；workflow 会从 tag 自动识别版本和渠道，此时不会改写源码。如果 tag 指向的版本文件和 tag 版本不一致，发布会失败，需要先更新版本文件并重新打 tag。仅推送 tag 不会启动发布。

## 无 Apple Developer 账号的 CI DMG

GitHub workflow 会对 `.app` 执行 ad-hoc codesign，但不会做 Apple notarization，因此首次打开仍会触发 Gatekeeper。这个模式适合内部测试和开发者分发，不应标记为正式已公证发布包。

首次打开被拦截时，可以强制打开。macOS 15 之后的提示可能仍会出现 **Move to Trash / 移到废纸篓** 按钮；只要 CI 中 `codesign --verify --deep --strict` 通过，这通常仍属于未公证 app 的 Gatekeeper 拦截，不是包损坏：

1. 双击打开 DMG，把 `WeWork.app` 拖到 `/Applications`。
2. 第一次打开如果看到“无法验证开发者”或 **Move to Trash / 移到废纸篓** 提示，点“完成”，不要点“移到废纸篓”。
3. 打开 **System Settings > Privacy & Security**，在 Security 区域点击 **Open Anyway**。

如果 macOS 仍保留 quarantine 标记，也可以在确认来源可信后执行：

```bash
xattr -dr com.apple.quarantine /Applications/WeWork.app
```

## 生产发布

生产发布会读取远端 `latest.json` 自动计算下一个 patch 版本；也可以用 `--version` 指定版本：

```bash
cd wework
scripts/release-mac-app.sh --target prod --notes "Release notes."
```

脚本会上传 `.app.tar.gz`、签名文件和 DMG。下载入口应指向最新的 universal DMG；updater 客户端则通过 `latest.json` 获取对应平台的 archive URL 和 signature。
