---
sidebar_position: 36
---

# Wework DSH 运行时升级与验证

Wework Core、内置 DSH 插件和新 Smart app 模板使用官方 `0.2.0-rc.2`。
既有 Smart app 根据 manifest 中的 DSH 版本运行；`0.1.0-rc.8` 首次使用时下载，
校验归档大小、SHA-256 和运行时身份后缓存，后续可离线运行。旧运行时不随安装包分发。

构建时实际查询打包 Executor 的 Workbench schema，并将响应写入组件描述。
启动时必须同时验证 schema 和二进制内容哈希；只允许相同内容的 Executor 使用
这份响应。旧组件未携带响应时，可在实际内容哈希相同的前提下使用打包响应；
不同内容的自定义 Executor 仍执行只读 schema 查询。
不兼容或校验失败时禁止迁移 Home。在线组件发布必须保留 schema 响应和内容哈希。
共享 E2E 归档必须保留打包 Executor 的原始字节，不得在生成证明后再次 strip；
归档发布前校验实际 Executor 与组件描述的内容哈希。

主窗口只加载自己的首屏依赖。弹出窗口页面按需加载；服务函数、翻译器和小组件
直接引用协作包的具体模块，避免通过总入口提前加载协作页面。组件组合与只读
Executor 兼容性校验及 Codex 文件校验并行执行，但必须全部完成后才返回启动路径。Node 和 CLI
准备与组件准备并行，Home 迁移仍在兼容性校验之后进行。

首屏云连接恢复复用父级偏好 Provider 的首次已加载快照，避免对同一串行偏好存储重复读取。独立使用云连接 Provider 时仍按原路径读取。恢复只执行一次，之后的偏好更新不覆盖当前连接；等待偏好期间的断开或新连接操作继续受初始 generation 和断开标记保护。

`0.2.0-rc.2` 的 `dsh-app-boot` 使用正式 pnpm patch，在同一不可变运行时进程中
只读取并解析一次版本 manifest；每个插件的版本兼容性检查仍照常执行，首次读取或
解析失败也仍向调用方报错。补丁配置、补丁字节和对应锁文件全部参与运行时构建指纹，
不能复用未打补丁的归档。`0.1.0-rc.8` 不应用此补丁，既有按需下载身份保持不变。

浏览器认证只交换一次 token。Electron 将 DSH 响应的 Set-Cookie 保存到原有浏览器
分区，保留 Cookie 的域、路径、有效期、Secure、HttpOnly 和 SameSite 属性。

`dsh-runtime-upgrade` 桌面 E2E 验证冷启动和重启均严格小于 5 秒，并覆盖旧配置、
旧应用首次下载与离线重启、新模板、停止应用及进程清理。运行时归档由真实 HTTP
服务提供；Linux 和 Windows CI 需要在共享构建产物中传递测试服务使用的归档，
不能依赖构建用户的私有缓存，也不能将这些测试资源混入正式发行包。
Windows 的启动预算使用 release Executor。Executor 通过原生注册表 API 读取并展开
机器和用户 PATH，保留父进程路径优先级，不在启动时创建 PowerShell 进程。
Windows CI 对比原生读取和 .NET 的实际结果，并验证缺失值不阻止启动。普通用户测试进程的 `PNPM_HOME` 和
pnpm store 必须属于该测试账户，不能继承 CI 管理员的包存储；测试日志实时输出，
以便在进程卡住或诊断包上传失败时保留失败证据。
插件市场注册验证应解析 TOML 后比较市场类型和完整路径；合法的 Windows 单引号
路径不能因为与 JSON 双引号格式不同而被拒绝。精简 Linux E2E 产物须包含
Socket.IO 客户端和 TOML 解析器的独立构建，不依赖测试容器的 `node_modules`。

关闭到托盘保留主窗口 WebView 和控制客户端；真实重新加载才应建立新客户端并拒绝
旧客户端响应。文件标签出现后，测试仍须等待按需加载的文件面板显示路径，再验证
编码链接的解析结果。模型选择测试只滚动已渲染的列表，不能滚动隐藏的高级列表，
否则会把进入高级列表的按钮移出窗口。环境摘要的滚动验证同时覆盖宽屏停靠布局
和窄屏浮层布局，保持位置不变及对应的屏幕边界断言。
DSH 就绪超时须保留失败端点路径和最后一次 HTTP 错误，不输出认证查询参数。

切换稳定版或测试版更新渠道后，Electron 更新器必须明确禁止自动降级，避免较旧
发行版下载和重启提示干扰当前应用。抽屉动画 E2E 在隔离 Electron 中明确设置
`prefers-reduced-motion: no-preference`，保持生产环境对系统减少动画设置的支持。

内存 E2E 在相同任务和终端界面采样前后内存。Markdown 预渲染距离最多为一个
实际滚动视口，并保留长代码块和快速滚动时的同步渲染。不得通过增大启动或内存
预算、跳过断言或重复运行掩盖失败。

Windows Git workspace 克隆显式启用 `core.longpaths`，新回归在 Windows CI 验证超过旧路径长度限制的真实仓库。运行时工作索引仍采用原子替换；仅 Windows 临时共享冲突允许有界等待，永久写入失败必须向恢复和同步确认调用方返回错误。索引落盘成功前不得发布新恢复状态或清理旧会话目录。

受管 Git worktree 命令通过 `-c core.longpaths=true` 启用 Windows 长路径。删除、恢复及快照引用清理使用公共 Git 目录的父目录和相对目录名，避免 Git 对 `GIT_DIR` 字符串的长度限制。Git for Windows 在加载仓库配置前先发现 linked worktree 的 `HEAD` 和公共 Git 目录，因此工作目录和这些发现路径必须保持在 `MAX_PATH` 内；命令行长路径设置不能解除这一前置限制。原生回归保留此边界，验证实际 blob 对象、源和目标跟踪文件路径超过 260 个 UTF-16 单元，以及准备、修改、快照删除、恢复和永久删除完整链路。设备文件路径复用现有绝对路径规范，正确保留 Windows canonical drive 和 UNC 根，避免生成图片读取时误按 POSIX 路径解析。

macOS 桌面验证通过现有 `caffeinate` 守护请求用户活动，并在测试期间保留显示和空闲休眠断言；退出测试即释放。仅使用 AC 生效的系统休眠断言不能避免电池环境从 DarkWake 回到维护睡眠。该验证守护不修改系统设置，也不改变用例的原有超时和性能预算。

macOS 正式包验证首先执行 `dsh-runtime-upgrade`，保留冷启动和重启均小于 5 秒的原断言，并使用保持签名与公证的正式包。临时 ad-hoc 包若出现额外原生启动耗时，仍按实际时钟记录为未通过，不能通过预热或扣除耗时将它视为达标；没有堆栈或系统日志证据时不将其直接归因于安全扫描。

桌面 PR 与 Merge Queue 构建使用同一提交、同一事件的 Executor 二进制产物；打包可与生产者构建并行，不依赖 OCI 标签在短等待窗口内完成发布。fork 的 Backend Rust 继续从源码构建，其它路径保留现有 OCI 缓存。

DSH UI 原生动态导入在模块可用前加载入口及其静态依赖的构建 CSS，并跨模块复用同一加载结果。CSS 加载失败直接返回错误，不通过重新导入整个协作包隐藏问题；长草稿编辑器仍由固定视口滚动，附件和工具栏保持原位置。

正式发布资产与运行时归档生产者使用同一个缓存路径解析器，确保默认缓存与相对覆盖路径下的新版 Core、新版 Workbench、按需旧版运行时归档均被收集，Executor 原始字节与组件内容哈希保留。

Core profile 准备与宿主桥启动并行，仍须先通过 Executor schema 兼容性检查；原生进程仅在桥接环境就绪后启动。取消或停止时等待正在准备的任务结束，重启重新准备，保留 Smart app 运行时所需的桥接环境。

当前激活的任务页面并行加载已注册的 Home 模块与 Core 页面模块，复用同一模块与样式加载结果；隐藏任务和项目看板不触发 Home 加载。模块加载失败仍向页面错误处理传播，启动就绪信号继续等待实际页面完成。

任务首屏不静态加载项目看板、任务看板、连接设置和移动布局。对应模块仅在实际显示分支时加载，保留看板的原有样式与交互；移动浏览器继续加载移动布局，窄屏 Electron 仍使用桌面布局。加载占位不发送启动就绪信号。

反馈归档和 Smart app 的压缩、解包库仅在实际操作时加载，主窗口初始化不再加载未使用的归档依赖；实际归档内容与安全校验保持。

CI 的 `harness-apps` 使用隔离的客户端缓存，验证启动时未下载旧运行时。首次启动旧 Smart app 只下载一次归档；市场、导入和目录安装的三个实例均须报告原 manifest 要求的 `0.1.0-rc.8`，并与实际缓存的运行时身份及 DSH 包版本一致。后续实例复用同一归档，保留原有停止、重新打开与页面状态验证。

应用更新器与运行时配置并行准备，在注册宿主能力前完成初始化，复用唯一服务实例；初始化失败继续阻止启动，不隐藏更新功能错误。

Core profile 准备不等待更新器初始化；完整宿主管道仍使用唯一更新服务，启动前等待管道就绪。停止操作等待并释放尚未完成准备的管道，初始化失败保留原错误，不启动 Executor 或 Core。

首次启动的工作台模式检测在确认任意开发工具为可执行文件后即可持久化开发模式，不等待其余不存在工具遍历整个 PATH。确认成功后停止其余候选扫描，已经发出的文件系统操作自然结束，不再触发后续无用的访问与 stat。全部工具不存在时仍等待完整结果；已有模式不重新探测，Windows PATHEXT、目录排除和 macOS Git 占位检查保持。这个等待优化不改变真实冷启动的计时范围或预算。

渲染器阶段日志区分模块导入完成、样式开始与结束、实际页面就绪信号。日志使用固定模块白名单和单调时钟，写入 `runtime-launch.log`，不包含任务、文件或认证数据。阶段拆分保留原加载等待和错误传播，不能把加载占位算作就绪。

Core CPU 诊断仅在显式设置 `WEWORK_E2E_CORE_CPU_PROFILE=1` 时启用。Node 在官方 DSH 入口执行前开始采样，在实际端点就绪时立即保存固定模块与操作白名单的摘要，不输出私有路径、任意函数或原始 profile，Windows 强制结束进程后仍保留摘要。新端点的 `before-endpoint` 标记要求同进程摘要已落盘，缺失时诊断清理明确失败；旧退出采样的强制结束缺失单独计数。既有本地原始 profile 由清理脚本按进程和端点时钟汇总，并在上传前删除。采样窗口不包含此前的宿主启动；诊断开销计入原有启动预算，不预热或扣除时间，仍须完成默认配置下的严格启动验证。

诊断模式等待 Inspector 的真实异步回调，启动采样后才加载 DSH，停止采样并写入摘要后才发布端点标记。重复完成调用共享同一个 Promise。失败只记录固定的停止、汇总或写入阶段代码，仍由严格清理检查拒绝缺失摘要；普通模式保持原有同步端点发布。

未归属采样仅按空 URL、安装包、文件模块和其他脚本四个固定类别细分，保留原总量，不输出包名、路径或函数。空 URL 不能作为原生代码归属的证明。

正式 macOS 签名保留时间戳、hardened runtime、entitlements 与严格验证。共享签名入口仅对明确的时间戳服务不可用或必需时间戳缺失错误进行最多三次原命令请求；包含其它错误时不重试。权限、签名和验证错误立即失败，时间戳请求持续失败时不发布签名缓存或组件 manifest。[Apple DTS 的说明](https://developer.apple.com/forums/thread/654794)支持将时间戳缺失归为该请求错误，不代表本轮已确认全局服务故障。

执行器轮询未确认的任务时，先按当前运行时身份查找候选，再按任务主键加锁并重新检查身份和状态。没有匹配任务的轮询不锁住其它安装的任务或索引范围；匹配任务仍保留原有租约、重投递和终态保护，避免运行时配置预检失败的状态写回被无关轮询阻塞。

活动目标自动继续执行时，Codex 子进程退出或通知流关闭不得复用上一轮的成功结果。执行器关闭保留原有恢复记录；单独子进程崩溃结束当前运行状态并报告失败，保留目标记录供手动恢复或执行器重启后的原有队列恢复。已入队恢复的目标不得重复入队，普通业务错误保留原有处理。

插件管理 E2E 保留安装包资源不变的完整哈希断言，额外记录变化文件的相对路径、类型和 SHA-256，不输出文件内容或链接的私有绝对路径。页面加载完成不能代替模块执行及测试控制客户端连接；资源变化和模块加载失败仍须从具体日志定位。

Core profile 不再建立指向安装包 App 静态资源的冗余 `web` 链接，静态服务继续通过 `WEWORK_APP_WEB_ROOT` 使用原有组件。Windows 的 Electron Node 同步删除目录会穿透 junction；pnpm 替换旧包时会因此清空安装包资源。已有 profile 通过布局版本迁移，在重建或重置包之前仅解除旧 App `web` 链接，保留用户插件和设置；后续启动复用已有布局。pnpm 导入的文件为独立目录中的普通文件，不重新建立该 junction，插件安装、更新和卸载继续使用原有资源完整性断言验证。

Windows 发布验证根据当前 Core profile 的 `corePluginsFingerprint` 选择实际组件 composition，允许同时存在发布 backing 目录和旧版本目录，并检查该 composition 的 `wework-app/web/assets` 仍使用无需符号链接权限的 Junction，并确认 Core profile 中不存在危险的 `web` 别名。文件树 API 在序列化时复用既有路径规范移除 Windows 扩展前缀，内部文件系统安全检查仍使用 canonical 路径；真实目录回归同时验证返回路径可读取及原有路径相等断言。

运行环境选择器和本地 API 通过协作包的 `agent-form/runnerRouting` 精确入口加载纯路由函数，保留环境与模型选择语义，避免首屏从包的聚合入口静态加载项目平台和 Issue 编辑器。启动就绪仍等待实际页面、模块和数据完成。

共享滚动类型通过整条 `import type` 引用 `MessageListProps`，反馈诊断读取滚动几何时只加载所需代码。

Executor 覆盖路径的候选 schema 在同一次检查中只读取一次二进制内容哈希。匹配时使用该证明，不匹配时继续查询实际二进制的 schema；已缓存或明确指定的证明仍在每次独立检查中重验，二进制被修改时继续拒绝启动。

启动遮罩取得冻结的截图像素后等待窗口的真实 `closed` 事件，再编码并持久化 PNG。关闭日志记录实际窗口关闭，不等待测试证据写盘；关闭操作的 Promise 仍等待截图保存，采集、编码或写盘失败继续返回错误。原有截图、就绪顺序和严格启动预算保持。

Transcript outbox 的表、索引和既有字段迁移在一次原子事务中初始化，保留 WAL、FULL 同步和忙等待要求。初始化失败回滚并关闭连接，保留原有记录，不留下部分创建的表。

活动 Goal 的自动续轮事件通过唯一生命周期协调器推进活动 turn；旧 turn 的迟到结束事件不得结束新轮，轮次结束也不得结束仍活动的 Goal。远程协作 E2E 明确通过实际智能体编辑器选择目标远程环境，不用允许多台设备的项目池替代固定远程执行要求，保留所有远程领取断言。

Markdown 解析实现仅在实际展示内容时加载，公开组件和 props 保持。共享消息列表使用局部 Suspense 边界及既有加载占位，避免首次解析器加载隐藏整页、释放内置浏览器原生视图或打断输入框；内容就绪回调留在边界内，须实际提交消息后才能触发。选中任务的 transcript 尚未加载完成或虚拟列表未提交可见内容时不报告启动就绪。Bootstrap 和 Harness 恢复加载占位界面同样不能报告就绪；活动 Harness 终端等待快照写入完成，恢复失败时等待实际错误界面。空任务启动不加载解析器，实际消息、计划与子会话仍使用原实现。构建依赖减少不能代替跨平台严格启动实测。

首屏的协作组件、翻译与纯模型函数通过对应模块入口加载，保留包根入口的既有导出和组件身份。18 条首屏聚合导入改用既有实现的精确入口后，同一源版本的 Vite production 构建中，应用入口、Core 和 Developer Home 的静态 JS 闭包从 5,740,346 字节降至 5,151,628 字节，减少 588,718 字节；18 个项目平台模块移出该闭包。该数值来自实际生成 chunk 的静态依赖集合，启动耗时继续由原有小于 5 秒的真实冷启动断言验证。文件编辑器、文件树、diff 和终端继续使用原有按需入口；现有调用的行为和 props 不迁移。

首屏分块只指定主入口，删除重复的模块图遍历，由 Rolldown 按实际使用的依赖递归分组，避免 Lucide 聚合导出的按需图标被误提升到初始包。引用次数至少为两次的纯图标模块组成共享分块，动态图标仍沿原入口加载；同源码构建中，主页面静态 JS 闭包从 2,851,300 字节降至 2,357,349 字节，减少 493,951 字节，图标模块从 1713 个降至 58 个，静态分块均为 3 个。实际任务首屏还加载 Core 和 Developer Home；这三个入口的静态闭包合集从 5,151,626 字节降至 4,694,367 字节，减少 457,259 字节，图标模块为 198 个，静态分块从 78 变为 79。两种范围分别记录，不混用主页面入口与完整任务首屏的加载量。真实编译回归检查必要静态依赖、共享图标与按需入口的可达性，实际收益仍须通过真实冷启动断言验证。

Core 就绪诊断沿用既有启动事件，分别记录认证交换、浏览器 Cookie 安装和端点就绪检查的固定阶段及状态，不输出 URL、令牌或 Cookie。端点阶段包含认证子阶段；日志不改变 Cookie 安装顺序、全部端点成功条件或启动预算。

启用 Core CPU 诊断时，outbox 额外记录初始化、数据库打开、PRAGMA 和 schema 事务的单调时钟及耗时；日志仅包含固定阶段和状态，不包含数据库路径、SQL 或错误内容。未启用诊断时保持原操作和错误传播。采样归属不能替代这些阶段的实际耗时证据。

终端插件注册路由和空会话管理器时不加载 `node-pty` 原生模块；实际创建终端时通过标准 Node 加载器读取同一依赖。保持同步 spawn、原错误返回和资源配对要求，真实 Node 与 Electron 验证均须创建、读写并关闭 PTY。

Windows 失败诊断保留原错误与清理流程。Git worktree 仅增加固定错误形式、已知目录角色及 UTF-16 长度和存在性，不输出路径或 stderr。桌面失败快照记录进程退出状态和隔离 Codex SQLite 的文件元数据；数据库检查只打开临时字节副本，原 DB/WAL/SHM 不变，检查只输出固定状态和迁移版本，副本最终删除。副本可能跨写入时点，不能用它代替原初始化错误的因果证据。E2E 的 Executor HTTP 诊断分别记录请求到达、请求体读取和 SSE 活跃数，不记录请求内容；这些诊断不视为底层错误已修复。

Codex app-server 重启在同一客户端状态锁内完成旧进程树终止与退出确认，之后才允许请求启动新实例，避免同一 SQLite Home 的旧新进程重叠。等待取消时保留正在终止的实例，后续请求继续等待退出；终止或退出确认失败向调用方返回错误，不报告重启成功。Windows 的阻塞进程树终止在专用阻塞任务中执行，并保留原 active-turn、pending-request 与强制重启语义。

失败目录诊断只补充实际报错 Gitdir 的 UTF-16 长度、存在性及是否属于当前 common directory 的 worktrees 元数据，不输出路径。桌面启动复用既有阶段日志记录主模块、实例锁、Electron 就绪、renderer 初始化和控制注册；renderer 使用同一结构化阶段格式，便于主进程保留日志。阶段记录不代替真实控制连接、应用就绪或启动预算断言。

Windows Git 的失败制品确认 linked-worktree 元数据目录长 251 个 UTF-16 单元：`HEAD` 为 256，而 `commondir` 为 261。Git 在读取仓库配置之前发现这些元数据，单独设置 `core.longpaths` 不能保证此阶段可用。Executor 复用现有 `.git` 与 `commondir` 解析，先通过 Rust 文件系统读取实际共享目录，再为 Windows Git 命令设置官方 `GIT_COMMON_DIR`；外部同名环境变量被隔离，`HEAD` 和 index 仍属于各自 worktree。创建、快照、删除及恢复使用同一命令准备路径，不改变仓库布局，也不重试。已有 Windows compatibility suite 覆盖该 251/261 几何、linked source、相对指针和仓库隔离回归；本机语义测试通过，实际 Windows 修复结果仍待下一轮 CI 验证。

首屏存储阶段按原顺序记录存储恢复、模型读取、旧模型迁移和运行时解析；计时包含并行 JavaScript 工作造成的等待，不等同于纯 I/O 耗时。迁移依赖恢复后的 localStorage，运行时解析仍校验已接受配置的 revision。

Windows 的控制连接超时可能发生在主模块执行后、实例锁开始前：已有失败制品仅记录主模块进入，应用进程仍存活，没有 Executor 或 SQLite 初始化记录，尚不能确认具体同步调用或异常。此区间补充包元数据读取、环境隔离和可信隔离页面清单读取的固定阶段；临时 `uncaughtExceptionMonitor` 只保留固定异常类型与来源类别，不记录消息、堆栈或路径，不改变原有异常处理。实例锁阶段结束后移除该监听。下一次失败须依据最后完成的阶段与异常记录继续定位，不能把客户端进程重启竞态修复视为此启动故障已解决。

### `2e15949f2` 启动实测

同一提交的 CI 冷启动均开启 `WEWORK_E2E_CORE_CPU_PROFILE=1`，诊断开销仍计入原有小于 5 秒的预算；三个平台均未通过冷启动门槛，不代表默认配置已达标。下列阶段来自实际启动事件，Core 进程阶段包含认证与端点检查，不能与其子阶段重复相加。

| 阶段（毫秒）                          | Linux Core19 | Windows Core19 | 正式签名 macOS ARM |
| ------------------------------------- | -----------: | -------------: | -----------------: |
| 冷启动总计                            |         5492 |          10182 |              10373 |
| Electron 就绪                         |          252 |            291 |               1533 |
| Runtime configure                     |          512 |           1019 |               1212 |
| Core 进程启动至全部端点就绪           |         1989 |           3986 |               3438 |
| Renderer 页面加载                     |         1490 |           1284 |               1517 |
| 页面加载完成至实际界面就绪            |         1138 |           3495 |               2009 |
| 界面就绪至 splash 关闭                |           48 |             39 |                 37 |
| Core JS 模块加载                      |          611 |           2386 |               1214 |
| Core 样式加载                         |           35 |             59 |                 15 |
| 认证交换 / Cookie 安装 / 端点检查余量 |  26 / 6 / 16 |    21 / 9 / 15 |         18 / 9 / 8 |

三次冷启动均保留对应进程的安全 CPU 摘要，端点进程数、完整摘要数和缺失数分别为 1、1、0。采样窗口分别为 1773、3723、3015 毫秒；这是采样覆盖时长，不是 CPU 使用量。Windows 的未细分安装包采样为 1241 毫秒，空 URL 为 247 毫秒；这些分类不能证明具体依赖或原生操作的耗时。其 outbox 初始化实际为 8.43 毫秒，数据库打开、PRAGMA、schema 事务分别为 0.80、2.57、3.74 毫秒。正式 ARM 的三个后续 release、component-update、app-update 流程全部通过，五个 Core 进程摘要均完整，诊断清理通过；这些成功不能替代失败的冷启动断言。

Windows 偏好状态等待与 Core JS 加载重叠，缺少 host 请求到达和响应的独立时点，不能将其 2046 毫秒等待归为磁盘 I/O。独立构建的 Dialog 按需加载候选仅减少首屏约 50KB、增加 3 个静态请求且主入口不变，缺少关键路径收益证据，已撤销该候选及其代码改动。

仅在 Core CPU 诊断开启时，`preferences.get` 记录 Electron 宿主收到调用和实际写出响应的固定阶段；同时保留读取耗时与包含响应写出的总耗时，不记录参数、偏好内容或错误信息。该计时用于区分 renderer 等待与宿主工作，保持原读取顺序和错误传播。

### `4ad7e26f2` Linux 验证

[本轮 Linux Core19](https://github.com/wecode-ai/Wegent/actions/runs/38443244153/job/115458646108) 保持原有严格小于 5 秒的断言，实测冷启动 4430 毫秒、重启 4372 毫秒。旧版 Smart app 首次按需下载一次 `0.1.0-rc.8`，原始 manifest 字节保持不变；重启后复用缓存并离线运行，强制终止 Core 后可恢复且 Executor PID 不变，四类模板均通过。三个端点进程的 CPU 摘要全部完整，诊断清理通过。

冷启动的 Core 进程至端点就绪为 1694 毫秒，页面加载为 1130 毫秒，页面加载完成至界面就绪为 808 毫秒。九次宿主偏好读取分别耗时 1–12 毫秒，包含响应写出的总耗时为 2–12 毫秒；此 Linux 结果不能推断 Windows 的等待原因。Renderer 存储恢复为 683.7 毫秒，模型初始化为 89.2 毫秒；存储恢复的墙钟时间包含并行 JavaScript 执行等待，尚不能归为纯磁盘 I/O。Windows 的本轮验证尚未完成，正式 ARM 结果见下一节，跨平台启动目标仍未达成。

### `4ad7e26f2` 正式 ARM 验证

[正式签名 ARM 包](https://github.com/wecode-ai/Wegent/actions/runs/38443420520/job/115455670238) 的冷启动为 10995 毫秒，原小于 5 秒断言失败；原 release、component-update 和 app-update 流程通过。主模块首次记录为 2198 毫秒，后续包元数据、环境隔离和页面清单读取合计约 4 毫秒，实例锁约 6 毫秒，Electron 就绪为 2740 毫秒。Core 至端点就绪为 2758 毫秒，页面加载 1581 毫秒，加载完成至界面就绪 2035 毫秒。首个宿主偏好读取为 102 毫秒，renderer 存储恢复为 1157 毫秒；尚无独立宿主存储读取计时，不能把后者全部归为磁盘读取。

component-update 的首个 Core 进程报告固定 `core_profile_summarize_failed`，清理脚本误报为时钟缺失；该进程原始 profile 已按隐私规则删除，具体无效输入尚无证据。诊断传播保留摘要生成阶段与固定验证原因，未知原因和真正时钟缺失继续硬失败，不修改采样或有效性门槛。最早的输出 bootstrap 仅在 CPU 诊断开启时记录固定阶段，复用已有启动计时器；此标记用于区分早期依赖执行区间，不代表启动性能已修复。

本轮 Windows 原生兼容步骤使用与原失败相同的 Git `2.55.0.windows.5`，四项长路径测试全部通过，无失败或忽略：原文件生命周期、251/256/261 元数据几何、linked-source 与相对指针及 HEAD/common-dir 隔离、无效元数据拒绝。真实桌面第 9 组随后通过，详见下一节。

`host-renderer-storage-initialize` 复用偏好读取的宿主响应计时，只在 CPU 诊断开启时记录；`readDurationMs` 包含存储队列等待、读取或首次种子写入，`durationMs` 截止响应实际写完，均不能直接视为纯 I/O。共享计时避免复制处理路径，原结果、串行化和异常传播不变，58 项能力测试通过。

归档库不再由三个运行时模块提前导入，仅在实际归档读取或解包时加载。目录链接、已验证缓存、下载大小与哈希校验和原解包操作保持原顺序，51 项运行时与更新测试通过。这项删除不证明任何平台已达到启动预算。

### `4ad7e26f2` Windows 桌面结果与后续定位

[Windows 第 9 组](https://github.com/wecode-ai/Wegent/actions/runs/38443244153/job/115471069197) 原 collaboration-worktree-policy 及全部七项通过；第 10 组七项和第 13 组三项均通过。Windows 全部十九组已结束，实际失败仅第 14、16、19 组；Linux 全部 Core 组通过。

[Windows 第 19 组](https://github.com/wecode-ai/Wegent/actions/runs/38443244153/job/115471068936) 严格冷启动为 8810 毫秒，仍未达标。配置阶段 1786 毫秒，Core 至端点就绪 3793 毫秒，页面加载 1216 毫秒，加载完成至界面就绪 1622 毫秒。schema 查询 1086 毫秒、CLI 安装 858 毫秒和插件 composition 923 毫秒彼此并行，不能相加；原独立校验保留。CPU 摘要完整、缺失为零、Prune 通过。

[第 14 组](https://github.com/wecode-ai/Wegent/actions/runs/38443244153/job/115471069089) component-update 未完成暂存，日志在需要下载约 25.19MB 归档后没有完成事件；同组原生窗口、存储恢复与外部导入通过。现有下载和未变更组件快照已经并行，无法从旧制品区分传输、解包和校验卡点。固定组件 ID 和阶段计时覆盖响应头、传输、归档校验、解包、内容校验、发布和快照，不记录 URL 或异常消息，36 项聚焦测试通过，原 E2E 预算、错误传播和成功条件保持不变；此诊断尚不是行为修复。

[第 16 组](https://github.com/wecode-ai/Wegent/actions/runs/38443244153/job/115471069209) workbench-mode 仍在连接前失败；其他五项通过。主模块进入为 231 毫秒，包元数据读取完成 232 毫秒，环境隔离随后开始，未记录完成或实例锁。主入口提前读取原生 appData 路径，而独立受控、打包和插件开发实例随后跳过隔离，不使用该值；现删除其提前读取，仅在实际开发隔离需要时读取一次。此删除不证明旧故障就是该调用造成。

[官方 Electron ESM 入口](https://github.com/electron/electron/blob/v44.7.0/lib/browser/init.ts#L176-L183) 直接发出 `uncaughtException`，不会触发 Node 的 `uncaughtExceptionMonitor`，因此原进程存活且 Monitor 没有输出不能排除入口抛错。同步阶段记录固定异常类别后原样抛出，不增加普通异常监听器或改变默认 GUI 处理。隔离与启动相关 29 项测试、类型和 lint 通过；仍需下一轮 Windows 原场景验证。

### `703c1196e` 单测日志审查

[本轮 Tests](https://github.com/wecode-ai/Wegent/actions/runs/38451605817) 两个 Wework 分片通过，但启动 Transcript 恢复单测在 `renderer.startupReady` mock 内执行的断言被产品的异常处理捕获并记录，无法使测试失败。此用例只设置了被 mock 的 Electron 标记，真实 renderer-phase 模块读取的 runtime config 仍为 browser，正确抑制了 Electron 专用阶段。

修复将用例配置设为真实的 Electron/main，在 readiness 调用当刻用 Vitest `expect.soft` 检查内容可见性，由测试运行器记录失败而不被产品捕获；阶段日志快照与调用次数仍在测试主流程断言。临时隐藏内容后立即恢复的故障注入确认最终 DOM 可见也不能掩盖调用时刻失败。四个启动/恢复用例与 17 个阶段测试通过。保留原正则、产品门槛与 E2E，在用例结束恢复 invoke mock 的实现，并逐用例重置配置，避免断言被吞或环境泄漏。

### `703c1196e` ARM CPU 摘要的样本顺序

[正式 ARM 日志](https://github.com/wecode-ai/Wegent/actions/runs/38451602677/job/115483778017) 首次给出固定原因 `core_profile_summarize_failed; core_profile_negative_delta`。原始 profile 已按隐私规则删除，无法确定负值的位置、幅度或累计时间戳是否仍在有效时钟范围内，因此不能声称本次输入必然合法或 ARM 启动已修复。

[V8 Inspector 的时间序列编码](https://github.com/v8/v8/blob/main/src/inspector/v8-profiler-agent-impl.cc#L103-L113) 直接输出相邻样本时间戳之差；[DevTools 的解码](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/models/cpu_profile/CPUProfileDataModel.ts#L131-L141) 恢复累计时间戳，再[按时间稳定排序样本与对应时间戳](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/models/cpu_profile/CPUProfileDataModel.ts#L240-L261)。摘要现在按这一语义处理有效时钟内的乱序样本，而非直接拒绝所有负 delta。所有样本保留原节点身份；有限数、节点与帧、profile 时钟、累计时间戳边界及启动 marker 均严格校验，原 marker 截止和总时间计算不变。首个 delta 为 `-1` 仍硬失败，超出结束时钟输出固定 `core_profile_sample_outside_clock`，不钳制、删除样本或放宽启动预算。

受控回归先复现原实现四项失败，再验证乱序节点归属、同时间戳稳定性、marker 跨界截取、总时间、不变的原输入及非法越界。26 项摘要测试通过；真实 ARM 原场景仍需后续 CI 验证。

### `703c1196e` 启动实测与宿主管道读取

[Linux Core19](https://github.com/wecode-ai/Wegent/actions/runs/38451605915/job/115486337893) 严格冷启动为 6524 毫秒，断言失败，后续兼容流程未执行。配置为 1113 毫秒、Core 启动到端点就绪 2739 毫秒、页面加载 1138 毫秒、页面加载完成到 surface-ready 1194 毫秒。renderer storage 恢复约 643 毫秒，宿主操作和实际响应写出只占约 10 毫秒。早期 bootstrap 到主模块为 22 毫秒。该结果不能归因于纯宿主存储 I/O，也不能由不同 CI 机器墙钟差证明代码回退。

[正式 ARM](https://github.com/wecode-ai/Wegent/actions/runs/38451602677/job/115483778017) 严格冷启动为 11802 毫秒，原 release、component-update、app-update 三流程通过。Core 启动到端点就绪 4004 毫秒，页面加载 1657 毫秒，后续 surface-ready 2355 毫秒。renderer storage 恢复约 1119 毫秒，宿主操作和实际响应写出约 10 毫秒；bootstrap 到主模块为 76 毫秒。跨平台 `<5s` 仍未达标，不预热、不扣时间、不放宽预算。

宿主管道原来用 `fs.createReadStream` 读取常驻继承 FD，阻塞文件读取会占用 Node 文件线程池。真实子进程在单线程池中复现握手写入排队死锁；新输入使用与 [Node 标准 PIPE/TCP stdin](https://github.com/nodejs/node/blob/v24.1.0/lib/internal/bootstrap/switches/is_main_thread.js) 相同的事件驱动 Socket，删除常驻文件读取。写入仍使用原 `autoClose=false` 文件流；输入按继承 FD 复用，活跃客户端 ref，停止/错误后 unref，关闭自己的 readline 和监听器，不关闭外部 FD。

相同真实子进程回归在原实现失败、新实现通过：不加 IPC 或其他保活句柄，两代客户端分别完成原 token/principal 握手、完整 79KB 响应，监听器恢复原数量、输入不被停止操作销毁，最后自然退出。Node 与 Electron 44.7.0 的 Node 模式各七项测试通过，无 GUI 或遗留子进程。四条受控阻塞读取另复现文件流响应等待约 255 毫秒、事件输入约 1 毫秒。这证明线程池争用机制，不能证明 CI 恢复等待全部源于此，也不能替代下一轮 Windows 继承 FD 和严格启动验证。

### `703c1196e` Windows 场景前置条件

[第 15 组](https://github.com/wecode-ai/Wegent/actions/runs/38451605915/job/115500677051) 的 `running-sidebar-state` mock 只处理 Responses，但场景未选择模型。两次真实请求使用 `kimi-k3` 的 `/v1/chat/completions`，用户消息正确包含该场景的 FIRST 标记，却落入通用 initial handler 的 TASK_PROMPT 断言。场景现在在首次发送前调用既有 `selectE2EModel`，为其 Responses mock 选择匹配模型；侧栏运行状态、迟到快照和虚拟化断言不变。

[第 16 组](https://github.com/wecode-ai/Wegent/actions/runs/38451605915/job/115500676931) 其余五场景通过，`workbench-mode` 在 835 毫秒启动失败，原因为 Home 迁移凭据保护拒绝。该 fixture 明确未设置 MCP 凭据存储模式，而 Windows 默认启用加密存储，`auto` 模式会被现有保护判为绑定 Home。隔离 fixture 现在在 TOML 根部显式设置 `mcp_oauth_credentials_store = "file"`，保留原合成认证、真实原生会话、数据库、文件身份、链接与恢复验证。真实 Executor 的受控元数据探针确认开启加密特性时，原隐式模式被拒绝、显式文件模式允许；产品保护与原超时均未修改。两处 fixture 的语法、格式及 lint 检查通过，完整 Windows 场景须在下一轮 CI 验证。

### 终端 SSE 生命周期与输入取证

[Windows 第 11 组](https://github.com/wecode-ai/Wegent/actions/runs/38451605915/job/115500677035) 未等到终端输入标记，原日志不能确定输入、PTY 写入或输出订阅哪一环丢失。审查发现 SSE 用 request `close` 注销响应订阅，而 [Node IncomingMessage 契约](https://nodejs.org/download/release/v18.20.8/docs/api/http.html#event-close_3) 从 v16 起将该事件定义为请求完成。真实 HTTP 回归在请求读取完成、响应仍开放时复现旧实现提前注销；修复使用 response 关闭、完成或错误以及请求中断，单次清理订阅。新回归确认请求完成后仍收到 live output，实际断开响应后注销；新增用例有界超时并统一清理自己的客户端和服务端。

两个终端测试文件共 12 项通过，格式与 lint 通过。仅既有 E2E control 标志开启时记录固定输入/输出阶段、字节数、匿名序号和订阅数量，不记录输入、输出、cwd、token 或原始错误。该回归证明 SSE 生命周期缺陷，尚不能证明本次 Windows 标记超时由它导致；保留原终端命令、完整 E2E 断言和预算，下一轮通过阶段日志继续定位。

### 后台设备刷新与执行会话映射

[Windows 第 10 组](https://github.com/wecode-ai/Wegent/actions/runs/38451605915/job/115500677231) 的真实模型请求成功，Executor 已完成回复，活动中有 DONE 内容，但执行弹窗仍为空。完整日志显示弹窗绑定 App 注册标识，实际流按原生设备标识刷新；设备状态遗漏两者的 runtime 映射。后台 `listDevices` 只返回过滤掉 App 注册的云设备，而前台查询已通过既有 `mergeKnownDevices` 将当前 App 注册合入本地设备的 route。后台现在复用同一合并逻辑，不新增请求、重试、独立 App 卡或 identity 兜底。

集成式单测将真实后台查询结果经过设备合并、会话 alias 注册和订阅，再送入原生 assistant 流；旧实现复现空会话，新实现收到回复。异 runtime 注册仍不共享会话，更新的 App 注册能读取同一原生内容。Hybrid 75 项、Provider 与会话缓存 303 项聚焦测试以及格式/lint 通过。原 Windows E2E 断言不改，完整场景仍须下一轮 CI 闭环。

正常 pre-push 发现共享设备合并 helper 将调用方的严格类型擦宽。合并与内部保留记录的函数现在以同一泛型保留输入类型，同时删除前台既有的返回强制转换，不新增过滤或兜底。包级 typecheck、设备与 Hybrid 83 项、runtime identity 6 项测试通过；首次 push 被 hook 拦下，未触发 CI。

### `f122a5911` 真实验证与剩余启动瓶颈

[Tests](https://github.com/wecode-ai/Wegent/actions/runs/38461246131)、Lint 与平台 E2E 全部通过。Wework 第一个分片的 Electron 1076 项和 renderer 3821 项、第二个分片的 renderer 3871 项通过；四项既有 skip 数量未增加，完整单测日志未再出现被产品捕获的启动断言错误。

[Linux Core19](https://github.com/wecode-ai/Wegent/actions/runs/38461246055/job/115519376285) 仍因严格冷启动 6341 毫秒失败：配置 594 毫秒、Core 到端点 3500 毫秒、页面加载 1071 毫秒、加载完成到界面就绪 875 毫秒。宿主存储操作与响应写出为 6 毫秒，renderer 恢复约 559 毫秒；不能把差值全部归因于宿主 I/O 或宣称管道改动已消除全部等待。真实阶段记录另显示未启用同步时，队列初始化消耗约 660 毫秒，其中打开数据库约 0.34 毫秒、PRAGMA 399 毫秒、建表 260 毫秒。这是下一项资源初始化优化的实际证据，尚不是已达到预算的结果。

[正式 ARM 包](https://github.com/wecode-ai/Wegent/actions/runs/38461261361/job/115516851688) 的严格冷启动为 7531 毫秒，仍失败；原 release、component-update、app-update 三流程通过。五份 CPU 摘要对应五个端点，缺失为零，Prune 通过，样本顺序修复已获得真实打包验证。配置 1444 毫秒、Core 到端点 2128 毫秒、页面加载 1213 毫秒、加载后界面就绪 1427 毫秒；宿主存储 7 毫秒而 renderer 恢复约 732 毫秒。两平台严格检查均先于旧 Smart app 阶段失败，不能声称本轮已验证旧版兼容。不同 CI 环境的墙钟差不能单独归因于任何一次改动；原 `<5s` 断言、真实就绪条件和 CPU 有效性检查均保留。

队列资源现在只在首次同步操作初始化，构造和未使用的关闭不创建目录或数据库；原事务、FULL/WAL、升级、持久化及异常保持。34 项 Node 与 34 项真实 Electron Node 模式测试通过，包括首次写入后重开恢复、启用同步时读取旧 pending、状态读取触发初始化和失败异常身份。renderer 插件启动会查询同步状态，该查询必须恢复旧队列并创建数据库；因此不能断言完整就绪后仍无数据库，也不能把 Core 端点前省下的初始化时间直接视为总启动收益。这项修改尚待下一提交的真实跨平台验证。

存储恢复差值尚无足够证据归因。沿用主 Electron renderer 的既有阶段记录，将固定 `rendererStorage.initialize` 拆为收到响应头、JSON 解码和同步存储替换；Core 仅在既有 CPU 诊断开启时记录请求体解析、宿主结果返回及 `res.end` 调用返回。后者不代表响应已送达或 flush 完成；日志不含内容、键、路径、token 或请求标识。32 项 renderer、9 项 Core 路由测试以及类型、lint、格式检查通过；原 await、同步替换、错误身份及就绪条件保留。新增诊断仍须下一轮真实 CI 给出阶段证据，不构成性能修复。

`267a908aa` 另完成一次隔离源代码 Electron 验证：构建测试专用 Executor，启动独立会话，snapshot 后等待实际 `desktop-workbench-surface`；工作台及输入框存在，无启动错误。新阶段实际记录恢复 289.4 毫秒，响应头等待 116.8 毫秒，响应体解码等待 172.3 毫秒，同步替换 0.1 毫秒。`response.json()` 的等待包含浏览器调度与响应体接收，不等于纯 JSON 解析 CPU，也不能外推到 CI。验证结束执行 stop 返回零，应用及所属会话进程均已退出，认证链接已移除；未保存截图或提交会话文件。这验证了真实启动及诊断接线，不替代完整跨平台 E2E、旧版兼容或严格冷启动预算。

本轮 Windows 原生构建仍使用 Git `2.55.0.windows.5`，registry 3 项、execution clone 1 项、workstore 15 项、长路径工作树 4 项全部通过，无失败或忽略。[Windows 第 11 组](https://github.com/wecode-ai/Wegent/actions/runs/38461246055/job/115533239020) 的原 workspace-attachments（含严格终端标记与拖拽）、automation-lifecycle、drawing-attachment 全部通过；这不单独证明旧标记超时唯一由 SSE 生命周期缺陷造成。[第 16 组](https://github.com/wecode-ai/Wegent/actions/runs/38461246055/job/115533239262) 六项原场景全部通过，包括 workbench-mode 的真实 Home 迁移与原生会话恢复，为明确文件存储的隔离 fixture 提供完整闭环。

[第 14 组](https://github.com/wecode-ai/Wegent/actions/runs/38461246055/job/115533239278) component-update 通过；实际暂存解包约 13.30 秒，未变更 Core 快照约 14.26 秒，彼此并行，43 秒是完整场景而非暂存阶段耗时。失败来自 native-window-startup 内部的启动恢复子 Electron 退出 1；原 execFile 错误未暴露具体原因，子目录错误制品又被清理。当前证据不能定位实际子进程根因，也不能归为旧组件暂存超时。后续只增加安全阶段诊断，保留原断言和预算，必须由下一轮实际错误证据继续定位。

启动恢复取证新增固定阶段、验证模式和白名单错误名称/代码，失败报告复制到结果顶层，避免 compact 删除子目录后失去证据。诊断落盘仅尽力执行，失败不阻止原退出，也不替换原 exec 错误；不持久化原 stderr、错误 stack、秘密 URL 或截图。8 项聚焦 Vitest 回归覆盖真实文件写失败、错误身份及实际 compact 保留报告，类型、lint、格式检查通过。新测试位于 CI 默认收集的 scripts 目录；原 E2E 断言、预算与重启流程不改，实际 Windows 子退出原因仍待下一轮诊断。

[Windows 第 15 组](https://github.com/wecode-ai/Wegent/actions/runs/38461246055/job/115533239076) 六个原场景全部通过，其中 running-sidebar-state 为 43 秒，为显式选择 Responses 模型的 fixture 修复提供实际闭环。

[Windows 第 19 组](https://github.com/wecode-ai/Wegent/actions/runs/38461246055/job/115533239029) 严格冷启动仍失败，为 6887 毫秒；配置 818 毫秒、Core 到端点 3737 毫秒、页面加载 860 毫秒、加载后界面就绪 1110 毫秒。管道启动、鉴权及 renderer 实际就绪，CPU 摘要一份对应一个端点、零缺失、Prune 通过；后续旧运行时、warm 和模板阶段未执行。本次 Windows 队列初始化仅 5.2 毫秒，不能投射 Linux 的 660 毫秒耗时。宿主存储为 4 毫秒而 renderer 恢复约 513.6 毫秒，模型初始化约 83 毫秒。CPU 3586 毫秒采样窗口中的最近 loader 栈归属为 CJS 1284 毫秒、ESM 812 毫秒，未知叶帧尚不能指向具体依赖；这些是采样权重，不是模块实际 CPU 或可扣除的启动时间。当前 CI 不包含后续队列 lazy 与更细存储诊断，不能据此宣称其收益。

[Windows 第 10 组](https://github.com/wecode-ai/Wegent/actions/runs/38461246055/job/115533239182) 七项原场景全部通过，包括 collaboration-shared-core 的实际执行会话回复，完整日志均无断言错误；后台 App 与 runtime 映射修复得到真实闭环。[第 13 组](https://github.com/wecode-ai/Wegent/actions/runs/38461246055/job/115533239053) 三项原场景也全部通过。

Windows 第 19 组的未知 CPU 叶帧无法由已清理的原始 profile 重新归因。下一轮摘要补充已安装的官方公开依赖和内置插件固定白名单，以及空 URL 叶帧最近的已知包或 loader 祖先；它记录栈归属，不等于叶帧实际模块 CPU。未知包仍使用匿名类别，不输出文件路径、动态包名或函数名，样本、原始 profile、端点边界及有效性规则均不改。36 项聚焦测试与格式、lint 检查通过；这项诊断不能证明性能提升。

[Windows 第 9 组](https://github.com/wecode-ai/Wegent/actions/runs/38461246055/job/115533239034) 六项通过，collaboration-local-group-coordinate 在首轮成员完成后未发起续轮。最后一次模型目录查询在 40.990 秒，46.009 秒队列领取将新续轮标为 RUNNER_MODEL_UNAVAILABLE，中间没有目录查询。源码先独立判断队列是否需要目录，再原子领取任务；两步之间成员完成可加入路由任务，导致领取时缺少目录而永久置为 waiting_runtime。

删除该非原子预检查。事务内选中的实际任务需要目录时返回专用 RunnerCatalogRequired，保持 queued、版本、payload 与绑定不变；释放事务后查询目录，再原子重选并验证。真实缺模型仍按原逻辑拒绝，空队列与旧无路由任务不查询目录，取消的任务不会复活。真实 SQLite 受控旧实现复现 waiting_runtime 错误；修复后 9 项路由测试全部通过，包括新增 3 项、原真实缺模型拒绝与独立连接并发单次领取，格式检查通过。原 E2E 不改，完整续轮须下一轮 Windows CI 验证。

### `8d1bff57b` Linux 完整验证

本轮正常 pre-push 的全部质量检查通过；Tests、Lint、平台 E2E、Auth 和两项策略均通过。Electron 1076 项、renderer 3835/3884 项通过，四项既有 skip 未增加，完整日志无被吞断言或未处理异常。

[Linux Core19](https://github.com/wecode-ai/Wegent/actions/runs/38470348069/job/115551477555) 完整原场景通过：严格冷启动 4722 毫秒、缓存重启 4350 毫秒，均未扣除采样开销。旧版运行时按需下载一次，旧 manifest 字节不变，缓存离线复用；Core 被终止后恢复为新 PID，Executor PID 保留，恢复后旧 Smart app 仍运行。四种模板通过，三份 CPU 摘要对应三个端点，零缺失，Prune 通过；临时文件已清理。Windows 与正式 ARM 尚待独立结果，不能宣称跨平台达标。

本次冷启动配置 477 毫秒、Core 到端点 1771 毫秒、页面加载 1215 毫秒、加载后就绪 919 毫秒。首次 outbox 初始化在端点之后，实际约 12.1 毫秒；不得把前轮 Linux 的 660 毫秒或全部墙钟差归为 lazy 收益。存储恢复 744.8 毫秒，其中响应头等待 292.3 毫秒、响应体等待 451.8 毫秒、同步替换 0.2 毫秒；Core 请求解析至宿主结果、res.end 调用返回共 9 毫秒，宿主初始化为 6 毫秒。response.json 等待并非纯解析 CPU，当前证据尚不能将其归因于网络或某个模块。新增公开包分类未显示 SDK/ajv 热点，匿名叶帧仍不能据采样权重认定具体优化对象。

[本轮正式 ARM](https://github.com/wecode-ai/Wegent/actions/runs/38470370291/job/115547715161) 严格冷启动为 17980 毫秒，仍失败；原发布、组件更新、应用更新三流程通过，五份 CPU 摘要对应五个端点、零缺失，Prune 通过。配置 2671 毫秒、Core 到端点 5122 毫秒、页面加载 3312 毫秒、加载后就绪 3534 毫秒，主 Electron ready 为 2320 毫秒。Core 端点处已有实际 resourceUsage：uptime 4639 毫秒，user/system 合计约 3070 毫秒；主进程整个启动 CPU 合计约 3220 毫秒。采样窗口 4481.7 毫秒不能当作实际 CPU。没有本任务并发构建或系统负载实证，不能归因于共享 runner。

ARM renderer 存储恢复约 1874 毫秒：响应头等待 1006 毫秒、响应体等待 867.6 毫秒、同步替换 0.1 毫秒；Core handler 至 res.end 返回约 79 毫秒，宿主存储约 17 毫秒。首次 outbox 初始化发生在端点后、约 28 毫秒。新的空 URL 祖先分类约 ESM 708.7 毫秒、Cordis 108 毫秒、CJS 20.9 毫秒，仍为栈采样权重；公开 SDK/ajv 无热点，不能据此修改供应商代码。renderer 实际 CPU 尚无观测，下一项仅补充现有阶段的固定 CPU 数值来区分计算与等待。

仅现有 CPU profile 开关开启时，主 Electron 在原页面加载开始、完成及界面就绪三个阶段采集对应窗口 renderer 的累计 CPU 毫秒和进程 ID。关闭开关不调用额外进程 API；进程缺失、数值无效或采集异常仅记录不可用，不改变 await、错误或就绪行为。只有同一 PID 的累计数值可作差，进程 CPU 可包括多线程，不从严格启动墙钟扣除。23 项聚焦测试、Electron 类型、lint 和格式检查通过。一次隔离真实 Electron 验证采到同一进程 CPU 71/630/1015 毫秒，实际工作台就绪；stop 返回零，应用与所属会话进程退出，认证链接移除，无截图或会话文件提交。这验证 API 接线，仍须下一轮正式包提供实际 renderer CPU 证据。

[Windows 第 9 组](https://github.com/wecode-ai/Wegent/actions/runs/38470348069/job/115563197070) 七个原场景全部通过；local-group-coordinate 49 秒，完成两轮三成员与负责人最终状态原断言，原子目录 admission 修复得到真实闭环。[第 14 组](https://github.com/wecode-ai/Wegent/actions/runs/38470348069/job/115563197045) 七场景全部通过，含真实恢复与重启；本轮无子错误报告，不能据通过倒推上轮未知退出 1 原因，保留安全诊断。

[Windows 第 7 组](https://github.com/wecode-ai/Wegent/actions/runs/38470348069/job/115563197149) 的 context-compaction 失败已有完整证据：任务与会话身份正确，实际请求包含场景初始提示，合法模型路由为 kimi-k3 的 Chat Completions；但场景只接管 Responses，首次发送前没有选择模型，请求落入通用 handler 后触发另一 TASK_PROMPT 断言。仅在首次发送前复用 selectE2EModel，保留所有提示、身份、压缩与预算断言。语法、格式和 lint 通过；现有 runner 单次真实 context-compaction 验证 64 秒通过、exit 0、无断言错误。finally 清理后所属进程为空，认证链接为零，没有遗留应用。完整 Windows 分片待下一轮验证。

本轮 [Windows 第 15 组](https://github.com/wecode-ai/Wegent/actions/runs/38470348069/job/115563197059) 其余五场景通过，running-conversation-history 的 performanceSnapshot 耗时约 5.48 秒，触发原 3000 毫秒断言；当时历史仍 loading、消息为零。该命令同步统计后还等待宿主 HeapProfiler.collectGarbage 和 Runtime.getHeapUsage，不能直接将测量总耗时归为消息渲染阻塞，也尚不能将全部差值归给 GC。仅在既有 E2E 开关内补充 snapshot 与 CDP attach/GC/heap/detach 固定阶段数值，保留原调用、参数、ownership、异常与预算。5 项聚焦回归、双端类型、lint 和格式检查通过，实际阻塞位置待新阶段证据。

[Windows 第 19 组](https://github.com/wecode-ai/Wegent/actions/runs/38470348069/job/115563197342) 严格冷启动 8623 毫秒失败，后续旧版阶段未执行；配置 1153 毫秒、Core 4071 毫秒、页面 1260 毫秒、加载后就绪 1786 毫秒。CPU 摘要一份对应一个端点、零缺失、Prune 通过。node-addon-native-custom-loader 为最大已知模块采样类别，约 1029 毫秒；官方 app-boot 经 node-addon-require-builtin 调用真实 profile 模块解析与 native 加载，缓存物化及完整性校验有明确合同，尚无 Wework 重复调用证据。不能据采样权重删除官方校验或宣称具体优化收益。

[Windows 第 16 组](https://github.com/wecode-ai/Wegent/actions/runs/38470348069/job/115563197171) 五场景通过，plugin-development 等待缓存 manifest 超时。真实链路为 bundled marketplace 初始化成功，随后 idle 环境重启的 reconciliation 因 taskkill 退出 128 失败，默认安装未执行；缺失 manifest 是继发结果。代码已具备任务终止工具失败后 child.try_wait 确认退出逻辑，旧日志没有实际 child 状态和原生错误类别，不能将任意 128 当作已退出成功。新增仅记录固定 stderr 类别、字节数和 exited/running/check-failed，原 stderr 不输出，进程树终止及原退出门槛不变。11 项生命周期与 4 项终止/诊断测试、格式、Clippy 通过；真实原生失败原因仍须下一轮取证，尚未证明行为已修。

进一步细分 native loader 采样仅使用官方包边界内六个固定操作名；记录最近祖先上下文，不等于 native require 的独占 CPU，不输出动态函数或路径。分类缓存仅在单次摘要内按实际访问节点懒求值，避免每个 sample 重复执行路径分类，保留原摘要字段与样本校验。49 节点、12 层共享祖先、2400 samples 的交替基准中，既有实现约 19.9 毫秒，增加分类但未缓存约 73.5 毫秒，缓存后约 2.4 毫秒，既有字段逐项相同。这只证明摘要计算开销下降，不替代严格冷启动结果；新的细分数据须下一轮 CI 验证。

### `4812ee602` 验证与启动等待取证

[Linux Core19](https://github.com/wecode-ai/Wegent/actions/runs/38480826547/job/115585933440) 完整原流程通过：严格冷启动 4687 毫秒、缓存重启 4409 毫秒。旧运行时下载一次、manifest 字节不变、离线缓存复用、Core 重启后旧 Smart app 恢复及四种模板全部通过。三份 CPU 摘要对应三个端点，零缺失，Prune 通过。Tests、Lint、平台 E2E、Auth 和策略通过；Electron 1100 项、renderer 两分片 3850/3884 项通过，四项既有 skip 未增加。Windows 产物原生兼容与网关构建已通过，其场景仍须完整结果。

[正式 ARM 包](https://github.com/wecode-ai/Wegent/actions/runs/38480832768/job/115582837952) 严格冷启动 22155 毫秒仍失败，原发布、组件更新和应用更新三流程通过。五份 CPU 摘要对应五个端点，零缺失，Prune 通过。Core 至端点墙钟约 7535 毫秒，端点处进程 CPU 合计约 4593 毫秒；同一 renderer 页面加载墙钟 3525 毫秒、CPU 增量 1722 毫秒，加载后至就绪墙钟 3782 毫秒、CPU 增量 1245 毫秒。存储响应头等待 1064 毫秒、响应体等待 1235.5 毫秒，而宿主存储为 52 毫秒。上述 CPU 包含多线程，差值尚不能归因于 App Nap、系统负载或某个模块，也不从严格预算扣除。

仅现有 CPU 诊断开关开启时，在六个固定主进程启动边界记录系统累计 CPU 总量、idle、CPU 数、可用内存及受支持平台的 1 分钟负载；不读取进程名或命令，不增加定时器。无效或失败只记不可用，关闭诊断或其他阶段不调用系统 API。18 项新增与 23 项既有聚焦测试、Electron 类型和 lint 通过。一次隔离真实 Electron 验证中六个边界均可用、工作台就绪；stop 返回零，所属进程为空，认证链接移除。系统负载包含此前构建，空闲内存也不等同内存压力，这些只是后续取证，尚非性能修复。

快捷短语现在复用既有 AppPreferencesProvider，删除多个输入框各自重复读取偏好及注册同类 listener 的逻辑；独立使用仍保留原有加载和事件行为，不增加全局缓存。真实 Provider 多消费者测试在旧实现复现重复读取（两项失败），修改后 6 项 hook 与 3 项 Provider 测试、renderer 类型和 lint 通过，包括事件优先于未完成初读及卸载清理。上述真实 Electron 工作台验证也覆盖修改后的启动。这不能证明 ARM 后续某次 395 毫秒偏好读取已消除，更不能宣称跨平台 `<5s` 已完成。

本轮 Windows [第 9 组](https://github.com/wecode-ai/Wegent/actions/runs/38480826547/job/115595955653)、[第 14 组](https://github.com/wecode-ai/Wegent/actions/runs/38480826547/job/115595955847)、[第 15 组](https://github.com/wecode-ai/Wegent/actions/runs/38480826547/job/115595955648) 完整日志分别证实 7、7、6 个原场景通过，包括两轮协作、真实启动恢复和 running-conversation-history。历史恢复原 3000 毫秒断言保留，未重跑；通过不能倒推上轮 5.48 秒的唯一原因。

[正式 macOS x64 构建](https://github.com/wecode-ai/Wegent/actions/runs/38480832768/job/115582837821) 在 Apple stapler validate 的既有三次尝试中均遇到 CloudKit NSURLErrorDomain -1005 连接中断，最终 xcrun 退出 68；尚未进入正式包 E2E。没有签名无效或票据被拒绝的证据，日志也不能区分前置已有票据检查与最终校验。源码已识别传输错误并在原次数后失败；不删除联网校验、不增加重试或另行重跑以获得绿色结果。外部票据服务连接故障仍是本轮构建的实际阻塞，不能宣称已修复。

最新 [Windows 第 19 组](https://github.com/wecode-ai/Wegent/actions/runs/38480826547/job/115595955883) 严格冷启动 7800 毫秒仍失败：配置 1030 毫秒、Core 到端点 3735 毫秒、页面加载 1167 毫秒、加载后就绪 1441 毫秒。Core 端点 uptime 3623 毫秒，累计 user/system CPU 合计 4296 毫秒；同一 renderer 页面 CPU 增量 1388 毫秒、随后 933 毫秒，均包含多线程。native loader 固定操作中未知归属约 996 毫秒采样，loadPrebuild 仅 13.7 毫秒、物化 4.8 毫秒、hash 1.3 毫秒，不能把未知部分归为这些操作。renderer 存储响应头/体等待 287.7/432.1 毫秒，宿主存储 6 毫秒、响应 7 毫秒；没有证据表明宿主存储是该等待的主因。CPU 一摘要/一端点/零缺失、Prune 和临时清理通过，旧版和缓存阶段因严格检查失败未执行。

最新 [Windows 第 7 组](https://github.com/wecode-ai/Wegent/actions/runs/38480826547/job/115595955634) 原 context-compaction 37 秒通过，明确 Responses 前置条件的修改获得实际 Windows 闭环；其他三个板关联/状态场景通过。新失败来自 task-status-sync 的初始模型请求未收到：已明确选择模型、Enter 提交、草稿清空且真实任务 running，正确路由和 MCP ready 已记录，Executor 的 turn/start 调用仅记录 request started，原请求等待已超时；该日志早于准备和写入边界，尚不能证明请求已写入 Codex。它不同于未提交请求的 fixture，尚无证据可修改原断言或等待预算；继续定位该调用链。

[Windows 第 16 组](https://github.com/wecode-ai/Wegent/actions/runs/38480826547/job/115595955599) 本轮 plugin-development 50 秒通过，但不倒推旧 taskkill 128 根因已修。新失败为 executor-stream-recovery 未收到请求：模型目录在真实 Enter 时仍为 isSelectionReady=false、modelCount=0，1619 毫秒后才就绪；生产提交函数按现有门槛拒绝提交，草稿保留、无任务和模型请求，与日志一致。原场景仅等待 editor 存在，未建立发送前模型前置条件。只复用 selectE2EModel 在 fill 前等待并选择场景要求的 Responses 模型，保留 Enter、原 partial、reload、completion、settled 和全部预算。原注册场景单次真实本地 E2E 49 秒通过，无断言错误；finally 清理 17 项，所属进程为空、认证链接为零、隔离应用已移除。未通过重跑或修改生产提交门槛取得通过。

为定位该请求等待，删除仅单调用的 prepare_request 空壳，复用现有日志与既有 VITE_WEWORK_E2E=true 开关，仅为 turn/start 记录准备、MCP 端点、状态锁、退役进程、pending 注册、stdin 锁、写入和响应的固定阶段及单调累计毫秒。其他方法不读取该环境开关，非 E2E 不记录；无请求参数、ID、模型、路径或错误原文，也不启用完整 stream debug。原 await 顺序、超时位置、响应及错误传递保持。两项 all-features 聚焦测试通过，真实 stdio 四种开关/成功/错误组合的返回一致、子进程全部 wait；Clippy、格式通过。此诊断用于下一轮实际边界证据，尚未修复第 7 组阻塞或跨平台启动预算。

### `3e8f0d115` 验证与 Electron 进程 CPU

本轮 Tests、Lint、Auth 与策略检查通过。Wework 两组完整日志共 8858 项通过：Electron 1118 项、renderer 3856/3884 项，四项既有 skip 未增加，无 AssertionError 或未处理错误。Windows 19 个桌面分片已完成：17 个成功，第 16、19 组失败；共享制品的原生兼容与网关构建通过。

[Linux Core19](https://github.com/wecode-ai/Wegent/actions/runs/38491922073/job/115621452335) 严格冷启动 5836 毫秒失败：配置 811 毫秒、Core 2783 毫秒、页面加载 773 毫秒、加载后就绪 1211 毫秒。Cookie 安装等待 724 毫秒，但实现已使用 Promise.all，并无串行重复工作证据。Core 端点实际 uptime 1992 毫秒、累计 CPU 1361 毫秒；同一 renderer 的加载与加载后 CPU 增量为 700/410 毫秒。后续旧版、缓存重启阶段未执行，清理和 Prune 通过。不能把前轮 4687 毫秒通过或两次墙钟差当作本轮代码因果证据。

[正式 ARM](https://github.com/wecode-ai/Wegent/actions/runs/38491931903/job/115618996358) 严格冷启动 10950 毫秒仍失败；原发布、组件更新、应用更新分别 33 秒、1 分 24 秒、1 分 27 秒通过。五份 CPU 摘要对应五个端点、零缺失，Prune 通过。系统三个 CPU 在各启动区间累计计时中约 98.6–100% 非 idle；这不识别消耗来源，不能归因于外部任务、App Nap 或 runner 环境，更不能扣除预算。Core 端点累计 CPU 1765 毫秒；同一 renderer 页面加载 2055 毫秒、CPU 920 毫秒，加载后就绪 2438 毫秒、CPU 614 毫秒。旧版后续阶段未执行，跨平台 `<5s` 尚未完成。

现有 renderer 数值不足以识别其他 Electron 进程的消耗。仅在既有 CPU profile 开关下，复用同一次 getAppMetrics 结果，补充全部 Electron 进程的安全 PID、累计 CPU 毫秒和 browser/renderer/gpu/utility/other 固定类别及合计，不读取进程名称、服务名称、命令或路径，不增加查询、计时器或等待。无效计数或任一进程数值缺失时，不输出部分合计。每次快照独立记录身份，进程退出或替换时不能直接对合计作差，Core/Executor 也不属于该 Electron 合计。

22 项新增与 23 项既有聚焦测试、Electron 类型、lint 和格式检查通过。单次隔离真实 Electron 验证达到工作台，三个原边界采集到五个进程，合计 2425/3409/4461 毫秒，与各安全记录相符。stop 返回零，所属进程为空、认证链接为零。函数级 renderer Profiler 未加入：当前打包粒度不能定位 React/i18n 具体热点，额外采样与构建接线尚无可行动证据价值。此次仅补充诊断，不宣称启动预算已修复。

启动页初始路径已等于第零阶段目标且速度为零，原 animateMorph 在首次 1150 毫秒目标变化前仍逐帧计算并重写三条相同 SVG 路径。删除这段重复帧，在首次实际目标变化时才启动原来的单一 spring 循环；后续变形、文案、恢复、超时及减少动态效果设置保留。执行真实 splash.js 的受控 RAF 回归在旧源码复现失败，修正后 23 项 startup-splash 测试通过，覆盖两帧 animationReady、初始单次绘制、实际变形和后续阶段不重复启动循环。原注册 native-window-startup E2E 单次 49 秒通过、无断言错误、清理 18 项临时文件；所属进程和认证链接均为零。此修改仅消除已证实的恒等重写，不能把此前 GPU CPU 总量归为这些帧，也不能据此宣布跨平台预算已达标。

[本轮 Windows 第 7 组](https://github.com/wecode-ai/Wegent/actions/runs/38491922073/job/115628798689) 五个原场景全部通过，原初始模型请求 10 秒预算不变；不能据此宣称前轮请求阻塞根因已修。第 9、14、15 组的 20 个原场景全部通过，历史恢复原 3000 毫秒断言保留。[第 16 组](https://github.com/wecode-ai/Wegent/actions/runs/38491922073/job/115628798861) 的 executor-stream-recovery 23 秒通过，明确模型前置条件获得 Windows 实际验证；其余四个场景通过，plugin-development 仍失败。原生日志证实 taskkill 退出 255 后 child_state=running，因此不能当作已退出成功。139 字节的 stderr 已被安全归类为 termination-failed，没有保留原文，不能推断具体 Reason。新增精确固定 Reason 分类仅改诊断，19 项聚焦终止测试与 Clippy 通过，非零退出和实际 child 状态门槛不变。

[本轮 Windows 第 19 组](https://github.com/wecode-ai/Wegent/actions/runs/38491922073/job/115628798831) 严格冷启动 8165 毫秒仍失败：配置 1147 毫秒、Core 到端点 3837 毫秒、页面加载 1148 毫秒、加载后就绪 1583 毫秒。Core 累计 user/system CPU 合计 4468 毫秒，renderer 加载及加载后 CPU 增量为 1383/994 毫秒。native loader 约 955 毫秒采样仍未知归属，不能归因于 loadPrebuild、物化或 hash。CPU 摘要与端点各一份、零缺失，Prune 和临时清理通过；后续旧版、缓存和模板场景未执行，跨平台 `<5s` 仍未达成。

连接器 clear 的现有 config/batchWrite 会首次启动 Codex app-server，随后无条件增加能力版本；下一次请求因此尝试退役刚启动的进程。实际第 16 组 clear 与 ensureStarted 时间重叠，idle-env-restart 在插件 reconciliation 请求之前，变化键仅为 WEGENT_CAPABILITY_REVISION。隔离实例源码未复制旧授权或技能，但没有启动前磁盘快照，因此不把现场 taskkill 255 的具体原生原因当作已证明。修复仅在成功且确认持久授权、MCP 项和托管技能均无变化时保留版本；真实撤权、未知配置状态、原配置 RPC 错误及可能部分删除仍失效，断云 clear 和原错误传递保留。受控真实 stdio 回归在旧无条件版本更新下启动三次（要求一次），修复后连续 clear/读取只启动一次并显式停止子进程。

连接器 10 项 all-features 聚焦测试、Clippy 和格式检查通过。原注册 plugin-development E2E 单次 64 秒通过，无断言错误；清理 32 项临时文件，所属测试进程、认证链接和隔离应用均为零。此本地结果覆盖连接器修复，真实 Windows 的原生失败仍需新一轮 CI 验证。

[本轮正式 macOS x64](https://github.com/wecode-ai/Wegent/actions/runs/38491931903/job/115618996489) 最终构建及上传成功，启用原自定义 notarization，原联网 ticket 校验完成；上轮 -1005 未复现。成功日志不区分已存在 ticket 校验与新 Accepted/staple 分支，因此不宣称新提交已 Accepted。该工作流仅 ARM 执行正式包 E2E，x64 对应步骤 skipped，不能用构建成功代替场景验证。未另行重跑、增加尝试或绕过校验。

插件清单 readInventory 的 readState 结果只用于 names 集合，但 readState.order 始终属于 manifest 已覆盖的 bundles/dependencies，故删除该读取及重复集合项，保留变更操作所需状态和顺序语义。真实磁盘 readFile spy 在旧实现复现同包读取两次；删除后每包只读一次、状态文件零次，该 fixture 总读取 9→5。两组相关测试 30 项、Electron 类型、lint 和格式通过。本地插件 E2E 构建早于此删除，不作为它的真实应用证据；后续 pre-push/CI 覆盖。原 CI 该阶段仅约 11/25/43 毫秒，不能声称此删除解决多秒启动超时。

### `9491003f4` 验证与首次模型读取并行

本轮 Tests、Lint、Auth、平台 E2E 和策略检查通过。Wework 两组完整日志共 8883 项通过：Electron 1143、renderer 3856/3884，四项既有 skip 未增加，无断言错误或未处理异常。Linux 桌面 35 分片中 34 成功，仅 [Core19](https://github.com/wecode-ai/Wegent/actions/runs/38501340313/job/115651119683) 严格冷启动 5897 毫秒失败，后续旧版、缓存及模板阶段未执行。页面加载及加载后同一主 renderer 的 CPU 增量为 1150/710 毫秒，browser 为 360/490、utility 为 130/210、第二 renderer 为 170/130；没有 GPU 记录，不凭进程类别认定第二 renderer 是启动页。

[正式 ARM](https://github.com/wecode-ai/Wegent/actions/runs/38501349527/job/115648903726) 严格冷启动 12081 毫秒失败，原发布、组件更新、应用更新三个场景通过。页面加载开始至实际就绪的 4552 毫秒内，相同五个 Electron PID 累计 CPU 增量合计 4507 毫秒，主 renderer 为 2410 毫秒。系统三核累计非 idle 约 98.5%，不能据此识别其余 CPU 消耗来源或扣除预算。artifact 上传的 ENTRYNOTSUPPORTED 是非阻塞 ZIP 警告，随后上传和 Prune 均成功，不作为进程清理失败。

[Windows 第 16 组](https://github.com/wecode-ai/Wegent/actions/runs/38501340313/job/115655648564) 五场景通过，执行流恢复 17 秒通过；plugin-development 初始 bundled upgrades 未就绪。日志链为自定义模型目录写入成功、显式 app-server restart、taskkill 退出 128 且 child_state=running、reconciliation 失败。本次失败 session 没有 connectors.clear，不能把无变化 clear 修复外推为此链已解决。278 字节 stderr 只保留固定 termination-failed 分类，尚不能判断具体原生 Reason。[Windows 第 19 组](https://github.com/wecode-ai/Wegent/actions/runs/38501340313/job/115655648655) 严格冷启动 14175 毫秒失败，旧版后续阶段未执行。

本轮 Linux renderer 存储恢复约 302 毫秒，随后模型宿主读取约 377 毫秒；宿主读取只依赖原生配置文件及安全存储，与 renderer 旧版 localStorage 恢复独立。因此仅提前发起宿主只读请求，迁移、运行时投影、版本校验、旧条目移除和发布仍等待原存储恢复。保存和文件选择入口同样等待恢复；恢复失败保留原启动错误界面，不发布未恢复目录。复用原初始化及 reload 代际，不新增缓存、RPC 或就绪条件。六项新增用例在旧实现受控失败；修改后迁移 12 项、adapter 9 项、偏好/存储 26 项共 47 项通过，renderer 类型、lint、格式与独立审查通过。此并行最多移除这两个独立操作的串行重叠，不代表跨平台五秒目标已达成；尤其不据此解释 Windows 新增偏好等待。

当前源码重新构建的原注册 dsh-runtime-upgrade E2E 单次运行，严格冷启动 10667 毫秒失败，未重跑；旧版兼容阶段被原断言阻断。真实 renderer 日志证实存储恢复与宿主读取同时开始，分别约 303/302.7 毫秒，随后迁移 0.1、runtime 14.6，总初始化 317.8 毫秒。此结果验证并行接线，不能当作严格启动或旧版兼容通过。原 finally 完成后所属进程为空，认证链接为零。

为定位 Windows 新偏好等待，沿用现 rendererStorage 诊断，仅为 preferences.get 增加固定 request 与 response-body 两阶段。保留原 fetch、JSON 解码、Provider 发布和错误对象，不输出 capability 参数或响应内容；未知请求不新增诊断。三项新增用例在旧实现受控失败，修改后 transport/startup-phase 共 30 项通过，renderer 类型、lint 和格式通过。该诊断晚于上述本地 E2E 构建，未据该包声称真实验证，下一轮 CI 才提供实际阶段数据。

本轮 Windows 19 分片最终 17 成功、仅第 16/19 组失败。第 18 组三个远程协作场景分别 4 分 33 秒、1 分 20 秒、1 分 22 秒通过，原断言不变，清理 65 项临时资源；没有遗漏其他失败分片。

原生终止失败后新增一次只读进程快照及零超时状态查询，仅记录目标/相关 PID、父 PID、固定 running/exited/查询失败类别和 Win32 数字错误码或退出码；句柄均释放，不记录名称、路径、命令或 stderr 原文。不改 taskkill 参数、终止、等待、重试或原错误返回。快照及后续查询不能排除 PID 复用，不据此单独认定原进程树身份。四项纯关系/错误回归、Clippy、格式通过；同一生产模块及真实 Windows 子进程回归在 x86_64-pc-windows-msvc 下通过 cargo check --tests，但本机未执行 Windows 原生 API。原生第五项已纳入现有 Windows producer 兼容测试步骤，实际运行结果待下一轮 CI。

最终复查补充：首轮 reload 完成后、注册原生事件订阅之前再确认恢复成功，恢复失败时 initializer 拒绝原错误且不启动事件轮询。三个失败边界用例明确断言零订阅，原四组共 47 项再次通过。上述真实应用构建先于此最后边界修正；该修正的本地证据为这些定向回归，不能把旧包结果当作最终源码完整应用验证。
