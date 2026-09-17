---
sidebar_position: 1
---

# DWS 账号认证适配器

从 DWS `v1.0.58` 固定源码与 Wegent 扩展编译原生 companion。源码归档 SHA-256：
`f6b2dcf16b34492d7be25ce63fc81c7155d6a857af21c0604ae16bf4fa96f1e2`。
`overlay/` 复用官方 `edition.Hooks`、OAuth Provider、撤销和业务命令；
`auth-overlay/` 在官方认证包中增加交接函数，使用同一把刷新锁与精确账号删除逻辑。
共享通道来自 `../plugin-auth-go`，插件开发者无需处理套接字、nonce 或帧长度。

```bash
uv run --project backend python sdk/dws-auth/build.py \
  --output executor/target/dws-auth/dws-account-auth --test
```

可用 `--source-archive` 传入已下载归档，仍必须通过固定哈希校验；交叉编译遵循
`GOOS` / `GOARCH`。产物包括二进制、LICENSE、NOTICE 和记录上游哈希、扩展源码哈希、
目标平台、二进制哈希的 JSON。`--test` 运行隔离的官方存储测试、SDK 通道测试及
真实 DWS 命令/刷新/撤销的合成服务测试，不使用个人钥匙串或真实钉钉账号。

## 唯一刷新权交接

安装包通过通用 `accountAuth.localEnvironment` 声明 `DWS_CONFIG_DIR`、
`DWS_KEYCHAIN_DIR` 目录和 `DWS_DISABLE_KEYCHAIN=1` 开关。宿主校验后仅向本机
认证回调提供这些设置，Python SDK 入口再显式交给官方适配器，确保迁移读取用户
实际使用的源存储。未配置时保留官方默认行为；目录必须已存在且为绝对路径。
这些配置不上传后端，也不传给云端业务、刷新和撤销回调。

插件声明必须设置 `accountAuth.exportMode: "exclusive"`：

1. 本机 `export` 读取现有 MCP OAuth 账号，后端加密暂存，尚无可用连接或设备授权。
2. `detach` 收到私有通道中的同一快照，持有官方刷新锁，比对当前身份与令牌。
3. 本机先持久化不含令牌的交接记录，再删除该账号的 Keychain/DPAPI 存储及官方镜像；
   确认旧刷新材料已不在这些位置后，持久化完成记录。
4. 原生宿主确认后，后端在一个事务内激活连接、授权源设备并清除暂存密文。

删除后的进程退出可凭同一交接记录恢复；后端确认可幂等重试。发生刷新竞争时，
适配器先在同一把锁内持久化旧 ID 的作废记录，再由原生宿主取消旧密文暂存；
用户重试会获取新 ID 和当前令牌。迟到的旧进程无法删除凭据或激活旧快照。
账号变化或异常存储状态仍拒绝激活。交接仅支持 MCP OAuth；不读取 direct 模式的
本地 client secret。业务进程只收到 Access Token，拒绝 Refresh Token 和
`provider_private`，官方存储 hook 仅在内存读写。

## 生成完整插件包

```bash
uv run --project backend python sdk/dws-auth/package.py \
  --plugin ../wework-plugins-public/plugins/dingtalk \
  --output executor/target/dws-auth/dingtalk-account-auth.zip
```

源码声明 `accountAuth` 并包含公共 SDK；打包器在临时副本中增加五个平台的原生适配器
（macOS arm64/amd64、Linux arm64/amd64、Windows amd64），保留许可证、来源及哈希。
它拒绝符号链接，检查每个二进制哈希，并在当前平台实际执行包内 Python 入口和原生
私有通道：健康检查必须成功，错误 Connector 和携带刷新令牌的业务请求必须失败，
本机认证目录不得出现。任一步失败均不替换已有输出包。

压缩包仍遵守 Wegent 的 50 MiB 上传与 200 MiB 解压限制。公开命令入口和 24 个 Python
辅助脚本已通过公共 SDK 委派业务；已迁移账号的准备检查不再执行 DWS 登录。

## CI 与官方分发

插件根目录的 `.wework-build.json` 声明构建入口与生成目录，构建依赖保存在
`plugins/dingtalk/.wework-build/`。从 GitHub 提取插件目录并同步到内网 MR 时，
这些输入会一起保留，无需另行同步仓库根目录或下载专用制品。

```bash
uv run --project backend python sdk/dws-auth/vendor.py ../wework-plugins-public
uv run --project backend python sdk/dws-auth/vendor.py --check ../wework-plugins-public
uv run --no-project python sdk/plugin-build/vendor.py ../wework-plugins
```

内网仍使用原有 `package_plugin → unit_linux → release_plugin` 流程。打包任务
自动调用声明的入口，按固定版本与哈希准备 Go 编译器，生成五平台原生文件；测试任务
直接验证解压后的安装包，并记录实际测试的 SHA-256。发布任务只发布同一份已测试 ZIP。
普通插件没有构建声明，继续使用原来的源码打包行为。

源码、声明、SDK、风险说明与文件模式必须保持不变；只能增加声明的生成目录。
Backend 继续核对受保护分支、提交、MR 和源码身份，并向 GitLab 核实构建任务制品的
完整哈希及测试任务的哈希回执。缺少二进制、改写源码、制品不匹配、测试失败或
回执缺失均拒绝发布。构建过程不接收发布 Token 或个人认证环境。

本地发布也使用同一个入口，不需要判断包类型或手填哈希：

```bash
cd backend
uv run python scripts/publish_official_plugin.py ../../wework-plugins-public/plugins/dingtalk --slug dingtalk --visibility public --dry-run
```

去掉 `--dry-run` 才会发布到当前 Backend 配置的市场。批量 seed 同样自动构建。
已有制品的维护入口 `--prebuilt --sha256` 保留，但不是日常发布的必选步骤。

## 交付边界

当前适配器只接受默认钉钉 MCP 服务。配置了自定义 `mcp_url` 的源账号不会导出；
内存执行期间也隔离本机 DWS 配置，防止运行设备的配置改变令牌接收端。

当前源码测试已覆盖交接恢复、精确账号删除、刷新竞争拒绝，以及官方业务命令调用。
macOS 本地编译与 Windows/Linux 交叉编译已验证；Windows 真机存储与真实提供方仍待验收。
源码已声明 `accountAuth`；发布时自动生成包含原生适配器的完整安装包。
构建与官方分发入口已接通。相同打包器、原生入口和五平台二进制的最小业务夹具，
已通过真实发布服务、安装同步、Backend / Electron / 云端 Executor 的账号状态检查，
包括授权前拒绝、授权后成功和撤销后拒绝。独立 Electron 验收进一步使用官方代码
创建隔离的加密源存储，经桌面迁移后确认目标账号原授权已移除、另一账号不变，
重载后连接保留。证据位于
`wework/test-results/ai-verify/2026-09-07T12-19-29-787Z-40328/dws-source-qa.json`。
所有凭据均为合成数据，不读取个人钥匙串；真实服务方、系统钥匙串/DPAPI、远端 CI
和实际发布仍待验收。
注册的完整桌面检查点同样通过官方源存储迁移、云端授权、业务调用与撤销，
20 项标记全部成功，证据目录为
`wework/test-results/desktop-e2e/2026-09-07T12-20-59-116Z-47125/`。
通用 SDK 的交接中断恢复已通过真实 Backend / Electron / 云端 Executor 合成提供方 E2E。
源码可构建不代表插件已发布或用户可直接使用。
