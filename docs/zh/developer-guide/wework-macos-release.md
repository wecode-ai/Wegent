---
sidebar_position: 27
---

# Wework macOS 发布

[English](../../en/developer-guide/wework-macos-release.md) | 简体中文

Wework macOS 应用使用 Tauri updater 支持自动升级。发布流程由 `wework/scripts/release-mac-app.sh` 负责完成版本号计算、Tauri 构建、updater 签名、DMG 处理和上传。

## 发布模型

- 默认构建 `universal-apple-darwin`，生成一个同时支持 Apple Silicon 和 Intel Mac 的安装包。
- updater manifest 同时写入 `darwin-aarch64` 和 `darwin-x86_64`，两个平台可以指向同一个 universal archive。
- `src-tauri/tauri.conf.json` 不保存发布服务地址或 updater 公钥。发布脚本会在构建时通过临时 Tauri config 注入。
- updater 私钥和发布 token 只通过环境变量或本机文件读取，不提交到仓库。
- Codex CLI 不在本地编译。构建前通过 `wework/scripts/prepare-codex-binary.mjs` 按 `wework/codex-binaries.lock.json` 下载 npm tarball，校验 SHA256 后打进 Tauri resources。

## Bundled Codex 二进制

Wework 桌面包会直接附带 Codex CLI，避免用户在首次运行时再安装。版本和每个平台的 tarball 校验值由 `wework/codex-binaries.lock.json` 固定。

本地构建会自动准备当前目标平台的 Codex：

```bash
pnpm --filter wework run prepare:codex
```

macOS universal 构建会同时准备 Apple Silicon 和 Intel 版本：

```bash
cd wework
WEWORK_CODEX_TARGET=universal-apple-darwin pnpm run prepare:codex
```

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

## 无 Apple Developer 账号的 CI DMG

仓库提供 `.github/workflows/wework-app.yml`，用于在 GitHub Actions 上生成无需 Apple Developer Program 的 macOS 测试 DMG。该 workflow 会对 `.app` 执行 ad-hoc codesign，但不会做 Apple notarization，因此首次打开仍会触发 Gatekeeper。这个模式适合内部测试和开发者分发，不应标记为正式已公证发布包。

workflow 不需要配置 Apple signing secrets，会创建或更新 `wework-v<version>` GitHub prerelease，并分别上传两个 Release assets：

- `WeWork_<version>_macos_arm64_unsigned-adhoc.dmg`
- `WeWork_<version>_macos_x64_unsigned-adhoc.dmg`

从 GitHub Release assets 下载时，下载链接本身就是 `.dmg` 文件，不会被 Actions artifact 额外套一层 `.zip`。手动触发 workflow 且未填写版本号时，release tag 会使用 `wework-v<package-version>-<short-sha>`。

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
