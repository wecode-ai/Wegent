---
sidebar_position: 33
---

# Codex 插件运行时

Wework 的插件能力兼容 Codex plugin、skill 和 app 机制。插件页负责发现、安装、创建和管理插件；对话运行时负责把用户选中的 skill/app 以结构化 mention 传给 Codex app-server，而不是把展示用文本当成普通 prompt。

## 页面入口

桌面左侧菜单中，插件入口固定在第三位：新对话、搜索、插件、云端工作。进入插件页后：

- 顶部展示插件市场、已安装插件和搜索入口。
- 右上角刷新按钮重新读取当前市场。
- 右上角创建入口进入 Codex plugin creator 风格的创建页。
- 管理入口进入已安装插件、skill 和 app 的启停与卸载视图。

插件市场不是本地模式和云端模式的二选一能力。Wework 默认展示 Codex app-server 返回的 OpenAI 官方市场，并允许用户添加多个命名市场；自定义市场可以来自 GitHub 仓库、远程地址或本地 `marketplace.json`/目录。没有可用市场时展示欢迎页，引导用户添加自定义市场或进入管理页。

Codex 插件运行配置位于“设置 → 集成 → 插件”，当前提供远端 Apps / Connectors 开关。设置区不再提供独立的工作树管理页，也不再提供将 Claude 和 Codex 技能目录迁移为共享软链接的操作面板；工作树生命周期由会话流程管理，技能与插件内容由插件页和 Codex app-server 管理。

### Codex 插件与 Wework 插件的边界

桌面管理页把插件分为 **Codex 插件** 和 **Wework 插件**。前者继续使用 Codex app-server、Wegent 云端市场和 Executor 同步链路；后者是 `wework-core` DSH profile 的 bundle 依赖，由 Electron 主进程直接管理。Wework 插件管理能力只在受管桌面运行时可用，不通过 DSH Web Server 暴露安装或卸载 HTTP 接口。

Renderer 通过白名单 Electron capability 调用列举、安装、更新、启停和卸载操作。主进程将这些操作串行化，并在每次修改前快照 profile 的 `package.json`、锁文件、workspace 配置和 Wework 插件状态文件。修改后执行 `dsh --profile wework-core --dump-config` 预检；预检或包管理命令失败时恢复快照并按锁文件重新安装依赖。

用户插件必须声明 `dsh.bundle.patch`。内置 DSH 包在管理页中只读展示；用户插件的顺序和停用状态记录在 profile 内的 Wework 状态文件中，再据此重建 `dsh.profile.bundles`。配置修改不会隐式重启桌面运行时，页面统一提示用户在完成一组操作后调用 `runtime.restartCoreDsh`。

## 市场和安装

本地市场和 OpenAI 官方市场由 Wework 前端通过本机 executor 的 Codex app-server 读取。列表请求不限制 `marketplaceKinds`，因此 Codex 可以按照当前功能开关和登录态返回本地市场与 `openai-curated-remote` 官方市场。远程 GitHub 自定义市场会被 clone 到本地缓存目录，后续列表读取使用缓存中的 marketplace 数据和插件目录。本地市场的安装、卸载、刷新和删除都走 Codex app-server。

连接 Wegent 云端后，插件页还会展示 Backend 提供的 Wegent 云端市场。云端市场详情和安装状态来自 Backend；普通安装完成后，Backend 将用户的全局 `InstalledPlugin` 期望状态同步到在线本地设备和云设备。设备 Executor 从 Wework Backend / 对象存储取得包后，直接在隔离的 Claude 和 Codex home 中写入运行时缓存、marketplace 元数据和启用配置；云端插件的安装、更新和删除不调用 Codex app-server 的 `plugin/install`、`plugin/uninstall` 或配置 RPC，也不刷新 GitHub / OpenAI 市场。这样企业内部、Wework 公开和已发布个人插件在包已可达后不依赖 GitHub、OpenAI 或 Codex 联网接口。OpenAI 官方市场仍由 Codex 管理，不出现在自定义市场的编辑、排序和删除列表中。

云端同步中的包替换、两个运行时缓存、注册表和配置文件按一个本地事务提交。任何解压、解析或写入失败都会恢复同步前状态，避免出现新包已落盘但旧运行时仍生效，或删除一半后无法恢复的状态。Connector 的 `localAuth` 仍在包同步完成后由 Wework 独立执行，不因本地物化方式变化而跳过。

### 安装期本地授权

插件可以在 `connectors[].localAuth` 中声明设备侧授权。`local_qr` 用于二维码登录；`browser_oauth` 用于需要本机 CLI 打开浏览器的 OAuth。两种模式都必须提供相对插件根目录的 `health` 和 `start` 命令，二维码模式还必须提供非阻塞的 `poll` 命令。`authPolicy: on_install` 会在插件包完成本机同步后检查登录状态，未登录时由 Wework 显示授权界面；取消或失败会终止本次安装。首次使用和运行中授权检查继续作为凭据失效后的恢复入口。

发送消息前的连接器授权预检只对明确包含 `plugin://` 引用或连接器认证提示的消息同步执行；普通消息直接发送，不读取插件清单，避免每次发送都被本机插件枚举阻塞。带插件引用时也只对消息中提到的插件做 `plugin/read` 补全连接器信息，禁止在发送路径上调用完整 `plugin/list` / `readState`，以免会话打开被拖慢约 10 秒。

运行中授权恢复只检查当前会话最新的 assistant/system 消息，不在任务切换时重新扫描全部历史。检测文本必须有固定大小上限，只读取消息错误、正文以及工具块中的文本或已知结构化错误字段；不得序列化 `renderPayload` 或其它无界展示载荷。这样历史分页缓存或单条大型工具输出不会阻塞渲染进程主线程，旧的授权错误也不会在后续正常回复后重新弹出。

`browser_oauth` 使用异步授权会话，状态依次为 `preparing`、`waiting_browser`、`verifying` 和 `ok/error`。关闭界面会调用 Executor 的 `cancel` RPC 并终止登录子进程。CLI 输出必须是单个状态 JSON，不得包含 token、cookie 或其他凭据。

本地授权工具支持两种来源：

- `bundled` 使用客户端随包提供的 sidecar。DingTalk 插件使用 Wework 内置 DWS，不重复下载插件仓库中的旧版本。
- `managed` 由 Executor 按操作系统和 CPU 架构选择固定版本制品，校验声明的 SHA-256 后原子安装到 Executor home。当前只允许官方 GitLab CLI 发布地址，并由三个内部 GitLab 插件共享同一份 `glab`。

插件安装是用户级状态，CLI 凭据是设备级状态。因此安装期只保证当前设备完成授权；其他设备需要独立检查和授权。`logoutOnUninstall` 默认为二维码连接器启用、浏览器 OAuth 关闭，避免卸载一个插件时清除由其他插件或 profile 共享的凭据。

`wegent-sites` 和 `weibo-miniapp-h5-develop-agent` 由独立插件仓库维护。构建 Backend 镜像前，`pnpm prepare:builtin-plugins` 会按插件配置将外部插件复制到忽略提交的 `backend/init_data/plugins/<plugin-name>` 目录；标准 `build_image.sh` 和 `build_image_mac.sh` 会自动执行该步骤。正式镜像工作流分别从配置的归档地址下载插件，校验固定 SHA-256 后执行同一 staging。下载、校验或 staging 失败会终止镜像构建。Backend 随后以系统所有者 `user_id=0` 将已 staging 的插件幂等发布为组织范围、推荐的 Wegent 云端市场条目。

内置应用插件的身份以 Backend 内置插件注册表为准。当前注册表只包含 `wegent-sites` 和 `weibo-miniapp-h5-develop-agent`，二者都使用 `visibility=workspace`，因此规范市场名是 `wegent`。`public` 在数据模型中仍然合法，但只保留给系统/官方公开目录；普通用户的企业投稿不能选择它。只有在内置插件安装路径中，系统所有者 `user_id=0` 下的这两个内置插件市场行仍保存为 `visibility=public` 时，才会被视为历史遗留行并在安装前规范化为 `workspace`。这样可以避免同一个内置插件在旧数据中以 `plugin://...@wework`、在当前应用创建流程中以 `plugin://...@wegent` 出现两套身份。

应用页通过 `GET /api/sites` 读取列表。站点和小程序共用该接口，并分别传入 `app_type=web` 和 `app_type=miniapp`；省略参数时默认返回站点，兼容已有调用。响应中的 `app_type` 是区分两类应用字段的判别值。页面还会调用 `GET /api/sites/app-types` 获取当前 Backend 启用的类型、展示顺序和 `create`、`publish`、`edit`、`delete`、`open_experience` 等能力；Wework 只显示本地已有 Definition 且服务端已启用的类型，并按能力隐藏不支持的操作。

连接 Wegent 云端时，Wework 会调用 `POST /api/users/me/wegent-runtime-token` 获取本地应用 Skill 访问 Backend runtime API 的 token，并把它作为 `WEGENT_RUNTIME_AUTH_TOKEN` 写入本机 Codex shell 环境配置；该 token 会按响应中的 `expires_in` 提前刷新。`AUTH_TOKEN` 仍表示单次任务的原有 bearer token，`WEGENT_AUTH_TOKEN` 仍保留给 executor 设备连接使用，三者不能混用。

新增应用类型时，在 Backend 增加响应模型和 `ApplicationTypeHandler`，注册到 `APPLICATION_TYPE_HANDLERS`；在 Wework 的 `applicationTypeDefinitions.tsx` 增加对应 Definition，只声明图标、文案、列和行渲染。创建插件身份由 `GET /api/sites/app-types` 的 `create.plugin_name` 和 `create.marketplace_name` 下发，Wework 会缓存最近一次成功的 app-types descriptor，并在云端短暂不可用时复用缓存。读取缓存时必须先验证 `items` 中每个 descriptor 都是对象，且可选的 `create.plugin_name`、`create.marketplace_name` 在存在时是字符串；缓存不满足契约时返回空缓存并回到服务端发现或默认 Definition。若使用新的内置插件，同时在 Backend 内置插件注册表和 `builtin-plugin-staging.mjs` 增加插件定义。列表工作区和创建流程不应再增加按类型分支。服务端可独立调整类型顺序、开关、能力和创建插件，但未知类型会被旧版客户端安全忽略。

创建入口会先调用 `GET /api/plugins/installed?device_id=<target>` 检查目标设备的本地插件安装态；如果对应插件在该设备上的 `currentDeviceInstallation` / `status.devices` 已是 `installed`，前端直接使用插件的 `displayName` 和默认提示词打开新任务，不再重复安装。未安装时，创建站点调用 `POST /api/plugins/builtin/wegent-sites/ensure-installed`，创建小程序调用 `POST /api/plugins/builtin/weibo-miniapp-h5-develop-agent/ensure-installed`，请求体都必须携带目标 `device_id`。该接口只允许安装系统所有者发布的内置插件；内置应用插件使用 `visibility=workspace`，因此 Backend 下发的 `create.marketplace_name` 和安装记录中的 `source.marketplace` 都是 `wegent`。不同 visibility 对应不同插件市场名：`personal` 使用 `wework-personal`，`workspace` 使用 `wegent`，`public` 使用 `wework`，前端不应写死某一个市场名，而应复用共享的 marketplace 身份工具。重复调用会复用并重新启用对应插件的已有安装记录；后端可能先执行全量 `replace` 同步，并在目标设备缺少该插件时再执行单插件 `merge`。前端只以目标设备回执为准，要求本次应用插件的安装 ID 或插件名返回 `synced`；如果旧响应没有 `sync.results`，则按没有目标设备专属结果处理，并继续使用顶层 `sync.plugins` 回退校验。其他设备或历史能力的同步错误不会阻塞应用创建对话。目标设备不存在、离线或本次请求的插件未能同步到目标设备时，前端不会创建对话。确认成功后，前端分别使用稳定的 `plugin://wegent-sites@wegent` 和 `plugin://weibo-miniapp-h5-develop-agent@wegent` 引用打开新任务；小程序入口还会带入插件提供的默认创建提示。插件安装和同步期间，应用页会显示“正在安装应用插件，完成后将进入会话...”的状态提示。点击 mention 时，插件页直接加载相应的云端插件详情。

本地自定义市场和 OpenAI 官方市场的卸载继续走 Codex app-server。Wegent 云端插件卸载则删除账号安装意图和设备期望状态，并由 Executor 本地删除 Wegent 管理的中心包、Claude / Codex 缓存及对应配置；个人本地插件和 OpenAI 市场配置不会被一并清理。连接器登录态仍按插件授权策略处理。

## 独立 Codex Home

Wework 使用独立的 Codex home，避免直接污染用户命令行 Codex 的配置目录。默认路径来自 executor home 下的 `codex` 子目录，也可以通过 `WEGENT_CODEX_HOME` 显式覆盖。

为了复用用户已有登录态，Wework Codex home 会软链用户 `~/.codex/auth.json`。如果目标位置存在失效软链，会先移除再重新创建；如果不是 Unix 系统，则复制 auth 文件。插件、市场缓存和 Wework 运行时配置继续存放在 Wework 自己的 Codex home 中。

首次启动时，如果 Wework Codex home 还没有初始化，而本机存在原生 `~/.codex`，应用启动阶段会显示迁移选择。用户可以选择：

- 创建新的 Wework Codex home，只复用 auth 链接。
- 从原生 Codex home 迁移配置到 Wework Codex home。
- 是否启用 Codex 远端 apps 拉取。这个开关只控制远端 app 初始化，不代表特定内置能力。

迁移完成后状态写入 Wework Codex home，插件页面和对话运行时都继续从同一个 Codex app-server 读取插件状态。设置页也暴露远端 apps 开关，便于用户后续修改自己的 Wework Codex 配置。

### 运行配置规范化

executor 在启动 Codex app-server 前会解析并规范化 Wework Codex home 下的 `config.toml`：缺少配置文件时自动创建，缺少 personality 时默认写入 `pragmatic`，并把旧版 `instructions` 迁移为 `developer_instructions`。`instructions` 在新版 Codex 中是模型基础指令的完整覆盖项，保留它会移除模型自带的 personality、commentary 和过程更新规则，因此 Wework 不再使用该字段保存用户自定义指令。

用户在“设置 → 上下文”中维护的自定义指令通过 Codex app-server 的 `config/read` 和 `config/batchWrite` 读写。写入时会与 Wework 内置浏览器路由指令合并，并使用 `reloadUserConfig` 热加载已存在的线程。启动规范化是幂等的，使用 TOML 解析和原子文件替换，并保留已有配置文件权限；Unix 上新建配置文件的权限为 `0600`。

交互风格也以同一份 `config.toml` 为唯一来源。设置页修改 Friendly 或 Pragmatic 时通过 `config/batchWrite` 更新 personality，不再把 personality 保存在 localStorage，也不再在每个 thread/turn 请求中重复覆盖。

## 运行时权限模式

Wework Composer 为本地 Codex 任务提供三种权限模式，并把选择保存在任务的 `modelSelection.options.permissionMode` 中。新任务和缺少该字段的历史任务默认使用“完整访问”；用户从其它模式主动切换到“完整访问”时，界面会显示明确的风险确认：

| 权限模式 | Codex permission profile | Approval policy | 行为                                                                   |
| -------- | ------------------------ | --------------- | ---------------------------------------------------------------------- |
| 只读     | `:read-only`             | `on-request`    | 允许读取工作区；写文件、运行超出权限边界的命令或请求额外权限时需要审批 |
| 工作区   | `:workspace`             | `on-request`    | 允许在工作区内读写；访问工作区之外或扩大权限时需要审批                 |
| 完整访问 | `:danger-full-access`    | granular        | 文件、终端和网络执行不弹审批；MCP 插件业务表单仍可以请求用户输入       |

前端在每次本地运行时请求中发送 `runtime_permission_profile`。Executor 在 `thread/start`、`thread/resume`、`thread/fork` 和 `turn/start` 上同时设置对应的 `permissions` 与 `approvalPolicy`；从任务运行句柄恢复或继续会话时，也必须从保存的权限模式重建相同配置，不能回退为更高权限。

完整访问使用 granular approval policy，关闭 `sandbox_approval`、`rules`、`skill_approval` 和 `request_permissions`，但保留 `mcp_elicitations: true`。MCP elicitation 是插件主动发起的业务交互，不属于命令、文件或权限提升等执行安全审批，因此不能通过 `approvalPolicy: "never"` 一并关闭。

Wework 的 Claude Code 普通对话通过非交互子进程运行，无法展示或完成 Claude CLI 自带的审批提示。因此，Claude Code 设置中的 `default` 在这条执行路径上会映射为 `bypassPermissions`；用户明确选择的 `acceptEdits`、`plan`、`auto` 或 `bypassPermissions` 仍会原样传递。交互式本地终端不经过这项映射。

Codex app-server 的 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval` 和 `item/permissions/requestApproval` 请求会映射为 Wework 的 `request_user_input` 卡片。卡片保持 `availableDecisions` 的顺序，只展示协议实际提供的决定，并使用稳定协议值回传。Executor 支持单次批准 `accept`、会话批准 `acceptForSession`、命令规则 `acceptWithExecpolicyAmendment`、网络 host 规则 `applyNetworkPolicyAmendment`、拒绝 `decline` 和停止 `cancel`；结构化规则直接使用 Codex 请求携带的 amendment，缺失或不匹配时安全拒绝，不会根据显示文本自行扩大授权。权限请求可以按 turn 或 session scope 授权，也可以在当前 turn 启用 `strictAutoReview`，逐一审查之后的命令；拒绝时不授予任何额外权限。

## 模型列表

Wework 通过本机 executor 请求 Codex app-server 的 `model/list` 获取模型目录，并将返回的 provider 和模型数组顺序原样用于模型选择器。前端不会重排官方模型、默认模型或自定义 provider，也不会补充未由 Codex 返回的模型。请求使用 `includeHidden: false`，因此 Codex 标记为隐藏的模型不会显示。

已有任务会保留创建或上次发送时保存的模型选择。如果该模型暂时不在当前模型目录中，Wework 会要求用户重新选择可用模型，并阻止继续发送；它不会把新任务的默认模型静默替换到已有任务中。

### 监督模型

任务监督与会话共用同一个模型选择组件和同一份模型目录，但分别保存最近一次选择。监督设置不能维护第二套模型过滤或排序逻辑；会话中可选的官方 Codex 模型、自定义 provider 和本地模型也必须在监督中可选。

云端 `public`、`user` 和 `group` 模型继续通过 Backend 的 `/api/model-runtime/responses` 执行。`runtime` 模型由 Wework 在保存监督设置时按会话模型的同一规则构造 `modelConfig`，通过本地 IPC 交给 Executor；Executor 只在进程内保存该配置，并为每次巡检启动独立、临时且不复用任务线程的 Codex app-server turn。这样巡检不会污染主会话记录，也不会把本地模型凭据写入任务持久化数据或日志。

### 图片附件预处理

Wework 会把当前模型类别写入本地运行时请求。Codex 官方模型直接接收原始图片；Codex provider、本地模型接口和云端模型属于非官方模型，executor 在发送图片前会生成临时的模型输入文件，并把图片短边等比缩小到最多 `720px`。长边不设上限，因此超长截图会保留完整长边比例，而不会被强制塞入固定的 `1280×720` 边界。短边本来不超过 `720px` 的图片保持原样；原始附件、聊天记录和预览地址都不会被改写。临时输入文件只在当前 turn 使用，并在 turn 结束后清理。

## 对话运行时

新对话的 Composer 会展开显示插件入口和最多三个可用插件预览；进入会话后，插件入口折叠为单个图标以减少工具栏占用，但点击图标仍会打开完整插件选择器。窄工具栏同样使用图标形态。

用户在输入框中选择 skill、app 或插件时，编辑器插入不可拆分的行内 mention。光标只能停在 mention 前后；复制或提交时，编辑器会把 mention 序列化为 Codex app-server 支持的 markdown 输入：

- skill 使用 `[$name](/absolute/path/to/SKILL.md)`。
- app 使用 `[$name](app://connector_id)`。
- plugin 使用 `[$name](plugin://plugin_name@marketplace_name)`。

点击 skill mention 会在右侧工作区打开对应的本机 `SKILL.md`。executor 在发送 `turn/input` 前解析这些 markdown mention，并构造成 Responses API 风格的 `input` text element；为兼容已保存的历史消息，旧的 `skill:///absolute/path/to/SKILL.md` 格式仍可解析。这样 Codex 可以识别真实的 skill/app/plugin，而不是只看到展示文本。

未被用户选择的插件不会自动注入普通对话。已安装插件只是让 Codex app-server 能发现其 skill/app；是否启用仍由 Codex app-server 的插件状态和用户在对话中的选择共同决定。

从插件详情或市场列表点击“在对话中试用”时，Wework 会按 Codex 协议写入单条 plugin mention，而不是同时写入 plugin 和 skill 两条 mention。试用内容会进入新对话草稿，相关模板会显示在输入框上方；用户发送后，消息气泡继续把 `plugin://` mention 渲染成 badge，避免把协议字符串作为普通文本展示。

## Backend 市场与上传

Backend 同时接受 Codex 与 Claude Code 插件包，支持上传、云端市场发布、安装与设备同步，并为每个存储包标准化生成两个运行时的清单。Wegent 云端市场以 Backend 的安装记录为准；本地自定义市场和 OpenAI 官方市场仍以本机 Codex app-server 为准。

Backend 重建或迁移市场目录后，会核对已安装 Kind 的 `pluginId`、`releaseId`、`source.catalogItemId` 和 `source.marketplace`。即使插件和 Release ID 都没有变化，只要 `source.marketplace` 与插件当前 visibility 推导出的市场名不一致，也必须更新安装记录并重置失败的设备安装状态。这样 visibility 从 `public` 调整到 `workspace` 时，已安装记录会从 `wework` 修复到 `wegent`，不会因为其他引用字段相同而被误判为 no-op。
