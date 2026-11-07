---
sidebar_position: 4
---

# 测试框架文档

本文档介绍 Wegent 项目的单元测试框架设置。

推送前检查默认使用 2 个 Jest worker 运行前端完整单元测试，避免并行 JSDOM 实例争抢资源导致超时。可通过 `FRONTEND_PRE_PUSH_TEST_WORKERS` 调整并发数；该设置不改变测试范围或超时限制。

## 概述

该项目为所有模块提供了全面的单元测试支持：

- **后端** (FastAPI): pytest + pytest-asyncio + pytest-cov + pytest-mock
- **执行器** (AI Agent 引擎): pytest + pytest-mock + pytest-asyncio
- **执行器管理器** (任务管理): pytest + pytest-mock + pytest-cov
- **共享模块** (工具库): pytest + pytest-cov
- **前端** (Next.js + React 19): Jest + @testing-library/react
- **Wework** (Electron + React): Vitest + @testing-library/react，以及 Node.js 测试运行器

## Wework 单元测试维护

使用 `pnpm --filter wework test <测试文件>` 运行相关测试。测试清理按参数化展开后的用例数统计，不以文件数或 `test()` 声明数代替，也不通过跳过用例、合并测试或改变发现规则减少数量。

优先保留任务创建与发送、权限和资源归属、持久化、故障恢复、状态机及升级回滚的行为覆盖。重复的输入、操作和断言可以删除；纯颜色、间距、图标和普通显示格式的独立测试可按维护需求裁剪。代码覆盖证据用于检查遗漏，不能单独证明两个用例的行为等价。清理后运行受影响的测试并核对断言，保留安全断言及独立的关键边界场景。

## 当前测试覆盖率

### 后端 (`backend/`)

- ✅ 核心安全：身份验证、JWT 令牌、password 哈希
- ✅ 配置管理
- ✅ 异常处理
- ✅ 用户服务和模型
- ✅ GitHub 仓库提供者
- ⏳ API 端点（占位符目录已存在）

### 执行器 (`executor/`)

- ✅ Agent 工厂
- ✅ 基础 agent 类
- ✅ 模拟 AI 客户端交互（Anthropic、OpenAI）

### 执行器管理器 (`executor_manager/`)

- ✅ 基础执行器类
- ✅ 任务调度器
- ✅ Docker 执行器和工具
- ✅ Docker 常量和配置

### 共享模块 (`shared/`)

- ✅ 加密工具
- ✅ 敏感数据脱敏（令牌、API 密钥等）

### 前端 (`frontend/`)

- ⏳ 组件测试（已建立基本设置）
- ⏳ Hook 测试
- ⏳ 工具函数测试

## 测试覆盖率目标

- **目标**：初期达到 40-60% 的代码覆盖率
- **优先级**：核心业务逻辑和关键路径
- **策略**：逐步提高覆盖率

## 后端测试

### 运行测试

```bash
cd backend
pytest                          # 运行所有测试
pytest tests/core/             # 仅运行核心测试
pytest --cov=app               # 运行并生成覆盖率报告
pytest -v                      # 详细输出
pytest -k test_security        # 运行特定测试模式
pytest -m unit                 # 仅运行单元测试
pytest -m integration          # 仅运行集成测试
```

### 测试结构

```
backend/tests/
├── conftest.py              # 全局测试 fixture（测试夹具）
├── core/                    # 核心基础设施测试
│   ├── test_security.py     # 身份验证和 JWT 测试
│   ├── test_config.py       # 配置测试
│   └── test_exceptions.py   # 异常处理器测试
├── services/                # 服务层测试
│   └── test_user_service.py # 用户服务测试
├── models/                  # 数据模型测试
│   └── test_user_model.py   # 用户模型测试
├── repository/              # 仓库集成测试
│   └── test_github_provider.py
└── api/                     # API 端点测试（占位符）
```

### 测试配置

后端使用 `pytest.ini` 进行配置，包含以下设置：

```ini
[pytest]
testpaths = tests
python_files = test_*.py
python_classes = Test*
python_functions = test_*
addopts =
    -v
    --strict-markers
    --cov=app
    --cov-report=term-missing
    --cov-report=html
    --cov-report=xml
asyncio_mode = auto
markers =
    unit: Unit tests
    integration: Integration tests
    slow: Slow running tests
```

### 关键 Fixture（测试夹具）

- `test_db`：SQLite 内存数据库会话（函数作用域）
- `test_settings`：带有覆盖值的测试设置
- `test_user`：测试用户实例
- `test_admin_user`：测试管理员用户实例
- `test_inactive_user`：非活动测试用户实例
- `test_token`：测试用户的有效 JWT 令牌
- `test_admin_token`：管理员用户的有效 JWT 令牌
- `test_client`：带有数据库覆盖的 FastAPI 测试客户端
- `mock_redis`：模拟的 Redis 客户端

## 执行器测试

### 运行测试

```bash
cd executor
pytest tests/ --cov=agents
```

### 测试结构

```
executor/tests/
├── conftest.py              # 执行器特定的 fixture
└── agents/                  # Agent 测试
```

### 关键 Fixture

- `mock_anthropic_client`：模拟的 Anthropic API 客户端，用于测试 Claude 模型
- `mock_openai_client`：模拟的 OpenAI API 客户端，用于测试 GPT 模型
- `mock_callback_client`：模拟的回调 HTTP 客户端，用于 agent 响应
- `suppress_resource_warnings`：会话作用域的 fixture，用于抑制 ResourceWarning 消息
- `cleanup_logging`：会话作用域的 fixture，用于清理日志处理器并防止守护线程错误

## 执行器管理器测试

### 运行测试

```bash
cd executor_manager
pytest tests/ --cov=executors
```

### 关键 Fixture

- `mock_docker_client`：模拟的 Docker SDK 客户端，用于容器操作
- `mock_executor_config`：模拟执行器配置，包含镜像、CPU、内存和网络设置

### 测试结构

```
executor_manager/tests/
├── conftest.py              # 执行器管理器 fixture
└── executors/               # 执行器测试
    ├── test_base.py
    ├── test_dispatcher.py
    ├── test_docker_executor.py
    ├── test_docker_utils.py
    └── test_docker_constants.py
```

## 共享模块测试

### 运行测试

```bash
cd shared
pytest tests/ --cov=utils
```

### 测试结构

```
shared/tests/
└── utils/
    ├── test_crypto.py               # 加密/解密测试
    └── test_sensitive_data_masker.py # 敏感数据脱敏测试
```

### 已测试的关键功能

- **加密**：敏感数据的加密和解密（Git 令牌、API 密钥）
- **数据脱敏**：日志和输出中敏感信息的自动脱敏
  - GitHub 令牌（`github_pat_*`）
  - Anthropic API 密钥（`sk-ant-api03-*`）
  - OpenAI API 密钥
  - 通用 API 密钥和 secrets
  - 文件路径保护（无误报）
  - URL 保护（无误报）

## 前端测试

### 运行测试

```bash
# 从仓库根目录运行：
pnpm --filter wecode-ai-assistant test                  # 运行所有测试
pnpm --filter wecode-ai-assistant run test:watch        # 监视模式
pnpm --filter wecode-ai-assistant run test:coverage     # 生成覆盖率报告
```

### 测试结构

```
frontend/src/__tests__/
├── utils/                   # 工具函数测试
├── hooks/                   # React hooks 测试
└── components/              # 组件测试
```

## Wework 单元测试

单元测试聚焦任务状态与消息一致性、账号和权限边界、持久化、设备与运行时路由、
输入提交及失败恢复。不要为 CSS 类名、图标、文案排列、源码关键词、固定元数据
或诊断日志格式单独增加用例；混合场景只保留对实际业务结果有约束的断言。
遥测保留授权、拒绝收集、脱敏与账号隔离覆盖，不为统计标签和调试快照单独建测试。

从仓库根目录运行全部 Wework 单元测试：

```bash
pnpm --dir wework test
```

调试单个测试文件时，将文件路径或文件名传给测试脚本。以下两种形式等价，都会只
收集匹配的 Vitest 测试文件：

```bash
pnpm --dir wework test runtimePaneMessages.test.ts
pnpm --dir wework test -- runtimePaneMessages.test.ts
```

测试脚本会兼容性地移除参数开头的一个独立 `--`，再把其余文件过滤条件和 Vitest
选项原样传递给测试运行器。运行聚焦测试时，应确认输出中的 `Test Files` 数量符合
预期，避免误跑全量测试。

不依赖 DOM 的纯逻辑测试应在文件顶部声明 `// @vitest-environment node`。
这类测试不加载 `src/test/setup.dom.ts` 中的浏览器模拟、存储和插件 UI 初始化；
需要浏览器行为的测试保留默认 jsdom 环境。组件测试所需的插件 UI 辅助函数
从 `@/test/setup.dom` 导入。

Wework CI 执行测试但不再默认采集覆盖率，避免 Istanbul 插桩开销。
需要排查覆盖率时可定向执行 `pnpm --dir wework exec vitest run <测试文件> --coverage`。
完整 renderer push 检查每 15 秒输出当前 shard 的通过文件数，完整诊断仍保留在日志中。

运行中的 Executor 会并发写入 `tasks.sqlite`。直接写入该数据库的桌面 E2E fixture
应在独立连接上设置 `PRAGMA busy_timeout = 10000`，等待正常写事务释放锁。
锁等待仅作用于 fixture 数据库连接；业务断言与全局 UI 超时保持原有约束。

### 异步提问模型桩

桌面 E2E 的异步提问模型桩仅将对应 `function_call_output` 回执之后、与预期答案
完全一致的用户消息识别为回答；答案文本复用共享解析器移除运行时包装上下文。
AGENTS.md 和环境上下文也可能通过 `role=user`
传入模型，不能通过扫描全部请求或子串匹配判断用户是否作答。

`desktop-async-input-fixture.test.mjs` 覆盖注入上下文、历史答案、工具输出和真实
回答；现有桌面异步提问场景在提示词中保留 `Complete` 干扰文本，并继续断言
作答前的等待消息和作答后的完成消息。

## Wework 桌面云设备测试

从仓库根目录运行云设备功能 E2E：

```bash
pnpm --filter wework e2e:desktop:cloud-features
```

该场景会启动真实后端、Redis、云设备 executor 和 Electron 应用，验证云项目任务、
Goal 自动续跑与未读状态、忙碌任务转 Goal，以及本地与云端模型协议矩阵。失败时应
使用命令输出中的 `wework/test-results/desktop-e2e/<run-id>/` 目录，对照前端、
后端和 executor 日志定位主链路问题。

## 持续集成

### GitHub Actions 工作流

测试与缓存工作流在以下情况下自动运行：

- `.github/workflows/test.yml` 响应面向 `main` 的 PR 和 merge queue。
- `.github/workflows/ci-cache-warmup.yml` 在相关依赖、源码或 CI 配置进入 `main`
  后预热共享缓存。

CI 会先运行 `.github/scripts/classify-ci-changes.sh`，根据改动路径决定需要执行的
模块任务。模块依赖也会纳入判断，例如修改 `shared/` 时会同时运行 Backend、
Executor Manager、Knowledge Engine、Shared 和 CLI 测试；修改
`packages/chat-core/` 时会同时运行 Frontend 与 Wework 检查。修改测试 workflow
或分类脚本本身时会运行全部模块，确保 CI 编排变更经过完整验证。

在 PR 上添加 `ci:all` 标签可以跳过路径分类，强制运行全部模块测试、平台 E2E、
Wework 浏览器和桌面 E2E，以及 Wework macOS 内存门禁，适合路径分类可能遗漏
影响面的改动。三个测试 workflow 都会响应标签事件；没有 `ci:all` 标签时仍按
改动路径决定测试范围。Wework macOS 内存门禁仅在带有 `ci:all` 标签的非 Draft PR 中运行；
普通 PR、定时任务和手动任务均不触发内存 E2E。

Windows 桌面构建由 `build-wework-windows-e2e` 共享 action 负责，主分支缓存预热与
PR 使用同一路径。只有 `main` 可以写入共享缓存；完整桌面包按源码输入、Node、
Rust 和 runner 镜像版本精确匹配，不使用前缀匹配。命中后直接验证并上传原始构建包，
保留生成时的构建身份；未命中时复用 pnpm、Codex、Electron、Executor 和 Backend
编译缓存后构建。这里只复用 E2E 构建，不产生升级兼容性证据。

Windows Core 使用 `.github/ci/wework-windows-checkpoint-durations.json` 中带有
Actions 来源链接的成功检查点耗时中位数，单独均衡串行分片；Linux 分组不变。
调度保留十个 runner 的预算、两个独占基准分片和全部检查点。包含未测量检查点的
分片整体保持原样，待有成功日志后更新耗时数据。失败和取消的检查点不计入基线；
共享 CLI、Electron 或对象存储准备的检查点一起调度，保持原有准备任务数量。
负载也计入带有 job 来源链接的条件准备耗时，避免冷构建对象存储的分片额外拖尾；
缓存命中后这部分成本可能降低。
估算负载不包含 runner 排队、公共初始化和清理时间，最终收益以完整 CI 实测为准。

功能分支不在普通 `push` 事件中运行重复 CI；创建 PR 后由 `pull_request` 事件验证。
同一 PR 或 `main` 上有更新提交时，旧的未完成运行会被取消。`test-summary` 和
`lint-summary` 始终存在，并验证所有被分类为必需的任务确实成功，未执行的无关模块
不会导致汇总任务误报失败。

CI 稳定性依赖以下约束：

- 桌面 E2E 的元素挂载等待和后续取值轮询各自使用共享步骤预算；挂载耗时不能让
  取值循环一次都不执行。保留实际值和精确匹配断言。
- 多窗口测试切回控制客户端后，必须显式恢复原生窗口焦点，再验证该窗口中的
  虚拟化内容。控制命令路由不代表窗口已在前台。
- 桌面进程清理同时观察退出事件与操作系统存活状态，始终检查整个进程组。
  超时必须保留 PID、退出状态和 Linux 内核进程状态，不能放宽清理断言。
- 平台 E2E 的 MySQL 服务必须为首次初始化保留启动宽限。健康检查的
  `start-period` 应覆盖共享 runner 上的冷启动，再通过检查间隔和重试次数判断失败；
  不要依赖重跑掩盖初始化超时。
- `pull_request_target` 触发的 Repository Policy 必须从受信任的 base checkout
  运行策略脚本，但扫描目标应按 PR head 仓库和不可变的 head SHA 检出。不要依赖
  `refs/pull/<number>/merge`，因为 PR 同步提交时这个短生命周期引用可能被替换或删除；
  策略任务也不得执行 PR 提供的代码。
- 桌面 E2E 遇到异步独立渲染的最终文本和附属控件时，必须分别等待目标元素出现后再
  读取属性或断言状态。看到最终文本不代表折叠控件、时间线等关联 UI 已完成挂载。
- 桌面 E2E 触发导出、停用、重载、立即巡检、创建或归档等异步变更后，不能把成功提示、
  请求次数、按钮恢复可用或乐观更新后的当前 DOM 当作最终结果。测试必须从实际产物、
  持久化文件、已停止的服务、完成态文案，或重新读取后的后端/UI 状态中至少选择一个
  可独立验证的结果进行断言；如果测试环境没有真实结果的可观测边界，不要用 mock
  readback 伪造覆盖。
- 桌面 E2E 在页面重载、任务切换或注入 lifecycle/transcript 事件后，不能只等待侧栏、
  输入区或调试状态。在读取虚拟化 transcript 或断言文本出现次数前，必须通过页面快照
  等待预期会话文本实际呈现；随后仍要保留精确次数断言，不能用固定延迟或重跑掩盖丢失
  和重复消息。
- Wework 发布说明查询 GitHub 提交作者时会对瞬时 API 或 TLS 故障进行有限次数的
  指数退避重试。重试耗尽后发布任务仍必须失败，不能静默省略作者信息或生成不完整的
  发布说明。

### CI 缓存所有权

大型缓存由 `main` 分支统一预热。PR 和 merge queue 可以恢复 `main` 缓存，但不会
保存新的副本：

- Linux workspace `node_modules` 按 Node 版本和 `pnpm-lock.yaml` 建立一份共享缓存，
  供 Tests、Lint 和平台 E2E 使用。
- Wework 浏览器和桌面 E2E 使用发布到 GHCR 的依赖镜像。镜像标签由对应
  Dockerfile 的内容哈希决定；工作流只在该标签不存在时构建并发布镜像，后续任务
  直接在镜像容器中运行，不再逐任务安装 Node、pnpm、uv、Rust、Playwright 浏览器
  或桌面系统包。本地调试命令不会构建这些 CI 镜像。
- uv 只缓存下载和构建结果，不缓存项目 `.venv`。缓存 key 包含对应 `uv.lock`，
  按 Python 3.10、3.11、3.12 各维护一份共享缓存，保存前执行 CI prune。
- Playwright browser、Next.js build cache、本地 harness CLI 和桌面 Cargo target
  采用显式 restore/save；只有 `refs/heads/main` 可以 save。OpenCode、Claude Code
  和 Kimi Code 通过 `.github/claude-code-cli/package-lock.json` 共享一份锁定完整
  依赖图和包完整性的 npm 安装。
- Rust 单测、Windows check、发布、快照和 macOS 内存门禁通过 sccache 复用编译器
  输出。`main` 预热会在 `macos-14` 上执行与内存门禁一致的 Electron 桌面构建，
  非 `main` 任务以只读模式访问共享 sccache。sccache 临时无法安装时，任务会输出
  告警并直接编译，不会因为缓存优化不可用而失败。
- Wework Desktop Core E2E 继续使用 `main` 拥有的 Cargo target cache，因为它需要
  在多个桌面 job 之间复用同一套完整二进制产物。
- 平台 E2E、Release 和 Snapshot 的 Docker BuildKit cache 存放在对应 GHCR 镜像的
  build cache tag，不占用 GitHub Actions dependency cache 配额。
- 非 Wework E2E 的 Executor 和 Electron 系统依赖安装前先检查 runner 已安装的软件包；
  APT 下载缓存只有 `main` 写入，PR 只恢复。
- Linux 上的真实 Electron 更新传输探针同时隔离 Xvfb 和 D-Bus 会话，避免继承无效的
  会话总线地址干扰原生启动或退出。保留原有启动次数、生命周期断言和超时。
- 并发桌面检查点由父运行器先准备共享 X11 Unix socket 目录，再启动各自的 Xvfb，
  避免多个 X server 同时创建目录时发生 `EEXIST` 竞态。Redis 就绪失败保留最后输出、
  日志读取错误和进程状态，不延长就绪超时来掩盖启动问题。

`.github/workflows/ci-cache-warmup.yml` 在相关源码、依赖锁文件或缓存实现合入
`main` 后运行，并拒绝非 `main` 的手动预热。它只下载依赖或编译缓存，不重复执行
已经由 merge queue 验证过的测试。不要在 PR/merge-group 上新增大型自动保存缓存；需要增加缓存时，应采用
`actions/cache/restore` 和仅限 `main` 的 `actions/cache/save`，或使用已有共享
action。

### 写入 GitHub Actions 输出

写入 `$GITHUB_OUTPUT` 时，每一行必须是 `name=value` 格式。不要把会输出进度或诊断
信息的命令替换结果直接写入该文件；先只提取所需的值，再写入输出。例如，解析
Playwright 版本时：

```bash
version="$(pnpm exec playwright --version | sed -n 's/^Version //p')"
echo "version=$version" >> "$GITHUB_OUTPUT"
```

这样包管理器的供应链检查或其他辅助日志不会使工作流输出格式失效。

### 工作流任务

常规 PR 测试必须覆盖各模块测试，不能用 E2E 任务代替：

1. **test-backend**：使用 Python 3.11 和 `uv run pytest` 运行 Backend 测试。
2. **test-executor**：运行 Rust Executor 的 `cargo fmt --check`、
   `cargo test --all-features` 和 Clippy。该任务把 `CARGO_TARGET_DIR` 设置到 runner
   临时目录，避免共享构建目录污染或占满工作区。
3. **test-executor-manager**、**test-shared** 和 **test-knowledge-engine**：使用
   `uv run pytest` 运行对应 Python 模块测试。
4. **test-frontend**：运行 Chat Core 与 Frontend 单元测试。
5. **test-wework**：使用 Vitest 运行 Wework 单元测试并生成覆盖率。
6. **test-wegent-cli** 与 **test-wegent-cli-integration**：分别运行 CLI 单元测试，
   以及依赖 MySQL、Redis 和真实 Backend 的集成测试。
7. **test-summary**：始终运行并依赖以上所有任务；任何模块测试失败时，汇总任务必须失败。

E2E 使用独立 workflow：`.github/workflows/e2e-tests.yml` 覆盖产品端到端流程，
`.github/workflows/wework-e2e.yml` 覆盖 Wework 流程。它们提供额外的跨模块验证，
不会替代 `.github/workflows/test.yml` 中的模块测试。平台 E2E 只在 Backend、
Frontend、Executor、Executor Manager、Shared、Chat Shell、Chat Core、Docker
或相关构建配置变化时运行，因此 Wework-only PR 不会再启动无关的平台 E2E。
Draft PR 跳过昂贵的 E2E，转为 Ready for review 后再运行。

完整的平台 E2E 每天 UTC 02:00 定时运行；完整 Wework E2E 每天 UTC 04:00 定时
运行。定时任务与 PR、merge queue 使用不同的 concurrency group，互相不会取消。

### Wework 共享 Release 回归

`.github/workflows/wework-release-e2e.yml` 在相关仓库内 PR 中运行真实 GitHub
回归，也支持手动触发。测试使用仅有 `Contents: write` 的 Actions token，创建
独立标签和草稿 Release，执行发版工作流中的实际共享 Release 初始化命令，
验证传入较旧的 `RELEASE_SHA` 时，已有 Release 的目标、元数据和附件不变，
并在成功或失败后清理测试资源。Fork PR 不运行需要写权限的这项测试。

共享 `wework-updater` 的标题和说明只在首次创建时设置。后续发版上传依赖和
更新清单，不重新指定该 Release 的目标提交；否则旧提交与 main 的 workflow
差异可能触发额外的 `Workflows: write` 权限检查并返回 403。

可在已登录 GitHub CLI 的环境中运行：

```bash
GH_REPO=wecode-ai/Wegent bash .github/scripts/test-wework-shared-release.sh
```

### 覆盖率报告

覆盖率报告会自动上传到 Codecov（如果已配置）。

## Mock（模拟）策略

### 外部 API

- **GitHub/GitLab/Gitee**：使用 `httpx-mock` 或 `pytest-mock` 进行模拟
- **Anthropic/OpenAI**：模拟 SDK 客户端
- **Redis**：使用 `fakeredis` 或 mock

### 数据库

- **测试数据库**：SQLite 内存数据库
- **隔离**：每个测试获得一个新的事务
- **清理**：每个测试后自动回滚

### Docker

- 模拟 `docker.from_env()` 和容器操作

## 最佳实践

### 编写测试

1. **每个测试一个断言**：每个测试应验证一个特定的行为
2. **描述性名称**：使用清晰、描述性的测试函数名称来说明正在测试什么
3. **AAA 模式**：安排（Arrange）、执行（Act）、断言（Assert）- 清晰地组织测试结构
4. **模拟外部依赖**：永远不要调用真实的外部服务（API、数据库等）
5. **使用 fixture**：通过 fixture 共享常见的测试设置以减少重复
6. **测试边界情况**：包含错误条件、边界值和异常输入的测试
7. **保持测试独立**：每个测试应该能够独立运行，不依赖其他测试

### 安全测试最佳实践

该项目在 `backend/tests/core/test_security.py` 中包含了全面的安全测试示例：

- Password 哈希和验证（bcrypt）
- JWT 令牌创建和验证
- 令牌过期处理
- 使用有效/无效凭据的用户身份验证
- 非活动用户检测
- 基于角色的访问控制（管理员与普通用户）

安全功能的测试模式示例：

```python
@pytest.mark.unit
class TestPasswordHashing:
    """Test password hashing and verification functions"""

    def test_verify_password_with_correct_password(self):
        """Test password verification with correct password"""
        password = "testpassword123"
        hashed = get_password_hash(password)
        assert verify_password(password, hashed) is True

    def test_verify_password_with_incorrect_password(self):
        """Test password verification with incorrect password"""
        password = "testpassword123"
        hashed = get_password_hash(password)
        assert verify_password("wrongpassword", hashed) is False
```

### 测试组织

```python
@pytest.mark.unit
class TestFeatureName:
    """Test feature description"""

    def test_success_case(self):
        """Test successful operation"""
        # Arrange（安排）
        data = {"key": "value"}

        # Act（执行）
        result = function_under_test(data)

        # Assert（断言）
        assert result == expected_value

    def test_error_case(self):
        """Test error handling"""
        with pytest.raises(ExpectedException):
            function_under_test(invalid_data)
```

### 使用测试标记

测试标记有助于分类和选择性运行测试：

```bash
# 仅运行单元测试
pytest -m unit

# 仅运行集成测试
pytest -m integration

# 运行慢速测试
pytest -m slow

# 跳过慢速测试
pytest -m "not slow"
```

### 异步测试

```python
@pytest.mark.asyncio
async def test_async_function():
    """Test asynchronous function"""
    result = await async_function()
    assert result is not None
```

后端的 `pytest.ini` 包含 `asyncio_mode = auto`，可自动检测并运行异步测试。

## 添加新测试

### 后端

1. 在相应的 `tests/` 子目录中创建测试文件（例如，`tests/services/test_new_service.py`）
2. 从 `conftest.py` 导入必要的 fixture
3. 使用 `@pytest.mark.unit` 或 `@pytest.mark.integration` 对测试进行分类
4. 遵循 AAA（安排-执行-断言）模式
5. 编写具有描述性名称的测试类和方法
6. 在提交前本地运行测试：`pytest tests/ -v`
7. 确保覆盖率得到维持或提高：`pytest --cov=app --cov-report=term-missing`

### 前端

1. 在 `src/__tests__/` 中创建与源代码结构匹配的测试文件
2. 使用 `@testing-library/react` 进行组件测试
3. 模拟 API 调用和外部依赖
4. 确保测试通过：`pnpm --filter wecode-ai-assistant test`

## 调试测试

### 后端

```bash
# 运行特定测试并输出详细信息
pytest tests/core/test_security.py::TestPasswordHashing::test_verify_password_with_correct_password -v

# 在失败时进入调试器
pytest --pdb

# 显示 print 语句
pytest -s
```

### 前端

```bash
# 在监视模式下运行测试
pnpm --filter wecode-ai-assistant run test:watch

# 调试特定测试文件
pnpm --filter wecode-ai-assistant test -- src/__tests__/utils/test_example.test.ts
```

## 配置文件

### 后端

- `backend/pytest.ini`：pytest 配置，包含覆盖率设置和测试标记
  - 启用详细输出、严格标记和自动异步模式
  - 配置终端、HTML 和 XML 格式的覆盖率报告
  - 定义自定义标记：`unit`、`integration`、`slow`

### 执行器/执行器管理器/共享模块

- `pytest.ini`：模块特定的 pytest 配置
- 与后端类似的设置，但具有模块特定的覆盖率目标

### 前端

- `frontend/jest.config.ts`：Jest 配置
- `frontend/jest.setup.js`：测试环境设置

## 未来改进

- [ ] 将覆盖率提高到 70-80%
- [ ] 为 API 端点添加集成测试（当前为占位符）
- [ ] 为关键用户流程添加 E2E 测试
- [ ] 性能/负载测试
- [ ] 使用 `mutmut` 进行变异测试
- [ ] 添加更多前端组件测试
- [ ] 实现数据库迁移测试
- [ ] 为 WebSocket 连接和实时功能添加测试

## 故障排除

### 常见问题

**测试中的导入错误：**

- 确保您从正确的目录运行 pytest
- 检查模块是否已安装：`uv sync`

**数据库错误：**

- 测试使用 SQLite 内存数据库，无需设置
- 检查 fixture 是否正确导入

**前端测试失败：**

- 确保已安装 Node.js 20+
- 在仓库根目录运行 `pnpm install --frozen-lockfile` 以安装确切的依赖版本
- 清除 Jest 缓存：`pnpm --filter wecode-ai-assistant exec jest --clearCache`

## 资源

- [pytest 文档](https://docs.pytest.org/)
- [Testing Library](https://testing-library.com/)
- [Jest 文档](https://jestjs.io/)
- [GitHub Actions](https://docs.github.com/en/actions)

## E2E 资源复用与分片分配

平台 E2E 先查询按内容哈希命名的 GHCR 镜像，只在镜像不存在时启动 Buildx 构建器并发布镜像。命中镜像时不下载 BuildKit，避免不必要的 Docker Hub 网络依赖。知识库测试使用 `gcr.io/etcd-development/etcd:v3.5.16` 官方镜像，以避开原 Quay 下载链路出现的 502。

Milvus 和 etcd 由 shard 4 的知识库测试入口按需启动，复用现有容器网络与 MinIO；其他分片不启动这两个服务。启动顺序显式检查 etcd `/health` 和 MinIO `/minio/health/ready`，再启动 Milvus 并等待真实 `/healthz` 响应，总启动预算保持 180 秒。容器退出立即失败，测试失败保留原退出码；所有路径都保存容器状态、健康检查配置与历史、完整日志并清理容器。诊断制品为 `knowledge-provider-lifecycle-e2e`。这避免了 [40609610685](https://github.com/wecode-ai/Wegent/actions/runs/40609610685) 中服务在 checkout 前失败、后续步骤无法保存健康检查详情的问题；四个 runner 与两个知识库测试入口保持不变。

平台 E2E 保持四个既有分片，S3 上传测试复用 shard 2 的 MySQL、Redis 和 MinIO，媒体托管测试复用 shard 3 的相同服务。测试入口、断言和证据制品保持不变；Redis 使用独立逻辑库，媒体校验工具预装在共享镜像中。复制测试在 shard 3 按需启动专用副本和 broker，结束或失败时保存日志并删除容器，不在其他分片常驻。副本的健康探针通过 TCP 认证执行 `SELECT 1`，避免把初始化期间仅监听 Unix socket 的临时实例误判为就绪。知识远程索引测试移至 shard 4。

该分配参考成功运行 [40548056927](https://github.com/wecode-ai/Wegent/actions/runs/40548056927) 和 [40547828678](https://github.com/wecode-ai/Wegent/actions/runs/40547828678)：shard 1 的知识索引步骤耗时 149–164 秒，复制步骤耗时 20–26 秒，媒体测试耗时 24–26 秒，S3 测试约 6 秒。移走 shard 1 的额外步骤，并在现有较轻分片承载附件测试；不增加机器，不以增加并行 job 缩短墙钟时间。后续按实际测试步骤耗时与累计 runner 时间复核分配，不计排队时间。

平台 E2E 的普通标签事件不运行测试分类，仅 `ci:all` 标签触发完整回归。桌面 Plugins 的选中场景在一个 job 内依次运行，保留每个场景的独立初始化与失败结果。macOS 共享 job 显示为 `Wework Desktop macOS E2E`：Inspector 按受影响路径自动运行，memory 步骤仍仅对带 `ci:all` 的 PR 执行；定时运行和手动运行不会自动执行 memory 步骤。

首次集成运行 [40558717377](https://github.com/wecode-ai/Wegent/actions/runs/40558717377) 中，五个测试 job 的累计 runner 执行时间为 44 分 20 秒，两次七个 job 的基线分别为 48 分 18 秒与 51 分 53 秒，均从 job 首个步骤开始计时、排除排队。该轮 Provider-native 的逻辑分片 1 用时 120 秒，逻辑分片 3 基本为空，因此将它们分别交给物理 shard 3 与 shard 1；其他 Provider-native 分片不变，普通浏览器分片和各机器的用户身份也不变。矩阵契约检查保证仍只有四个物理分片，所有四个 Provider-native 逻辑分片恰好执行一次。

插件安装或卸载尚未结束时，后台设备补同步与显式刷新对账共用前台操作的 busy 状态，不能把过程中可见的 pending 记录当成缺包而触发第二次全量下发。前台操作结束后，真正未完成的设备同步仍会恢复。组件回归覆盖“安装请求挂起时收到 pending 目录”和“请求结束后恢复补同步”；原多 Runtime 隔离 E2E 的逐设备一次下发断言保持不变。

插件重装与旧卸载清理并发时，更新快照可能在重装回执持久化前推进设备版本水位。单插件同步只有在成功回执被更新水位取代、且设备安装记录仍未确认时才重新同步最新期望状态，最多三次；持续冲突返回 `plugin_write_conflict`，设备执行失败不会立即重试。`test_plugin_sync_recording.py` 使用真实数据库记录和版本水位覆盖收敛、持续冲突、设备失败及更新回执已确认四条路径；桌面 `plugin-write-coordination` 保留重装响应必须包含已安装设备状态的断言。

Windows 桌面运行器在创建普通测试账户前准备 1920×1080 显示模式，并检查工作区至少为 1440×960，避免默认 1024×768 显示器把 Electron 主窗口压缩到紧凑布局。目录发布故障注入通过不共享删除权限的原生目录句柄占用待发布目录；占用子文件不能证明其父目录重命名必定失败。回归运行 [42033008185](https://github.com/wecode-ai/Wegent/actions/runs/42033008185) 保存了紧凑布局和错误目录占用假设的失败证据。Claude 配置发布同时覆盖超过 Windows `MAX_PATH` 的隔离目录；历史搜索组件回归验证原生滚动事件到达前，虚拟列表已读到搜索写入的新偏移。

分身列表和独立预览的操作确认场景共用 `shell-command-response.mjs`，直接工具调用与 `code_mode` 都必须保留相同的单次提权确认参数。[42048584579](https://github.com/wecode-ai/Wegent/actions/runs/42048584579) 的独立预览夹具仅识别直接 shell 工具，协议回归用 `code_mode` 输入精确复现了相同异常。公共工具生成逻辑覆盖两种场景，未知工具声明仍直接失败，并保存工具 schema、请求类型和输入角色诊断，不保存请求正文或认证头。

同轮 Windows 日志还记录了两个后续问题。项目详情请求晚于切换任务标签返回时，更新所属协作标签的标题与路由，只有它仍为当前标签时才同步地址栏；已关闭的标签不恢复。标签页组件测试覆盖后台完成、重新选择和关闭后的迟到回调，通知导航 E2E 保留完整路由断言。缓存历史搜索的基线必须取自底部布局完成后、分页不再加载的同一份快照；不能把仍为 `loadingMoreBefore=true` 的中间态与搜索后的已完成分页比较，原有消息与分页一致性断言保持不变。

后续运行 [42061132998](https://github.com/wecode-ai/Wegent/actions/runs/42061132998) 的执行器重启日志显示，历史丢失事件在 RPC 协议协商完成前交付，导致唯一一次恢复请求失败。事件 HTTP 入口在事件连接认证后检查 RPC 就绪状态，未就绪时返回 503 并关闭该连接；已有 SSE 重连机制携带原序号重新读取执行器日志，不能提前消费恢复事件。协议测试覆盖未就绪时不交付事件、就绪后从原游标恢复。人工交互日志同时证明，忽略标记已写入但归档尚未保存时刷新页面会丢失历史；忽略操作必须先在历史锁内保存归档，再写处理标记。组件测试阻塞历史锁，验证归档提交前不会抑制问题。Windows 目录占用夹具使用 PowerShell 原生格式化构造扩展路径前缀，避免 `String.Concat` 重载绑定失败。

异步项目回调还必须在调用时读取当前标签状态，不能依赖启动请求时闭包中的标签列表和活动标签。回归保留旧回调后切换或关闭标签，验证它不会改变当前任务 URL 或重建已关闭标签。插件成功回执被取代后，再次下发若抛出异常，必须返回明确的失败响应并停止本次循环，不能复用旧成功响应；数据库回归验证只发起两次调用并返回 `plugin_device_sync_failed`。

指派回执的控件与活动时间必须在同一次 DOM 读取中比较。[42072191562](https://github.com/wecode-ai/Wegent/actions/runs/42072191562) 的 Windows 日志记录了两次读取分别发生于 17:42:02.912 与 .977，期间 Issue 状态更新使版本绑定的控件回执重新加载，第二次读到空文本；随后页面快照中的两处接收时间一致。该断言现在等待两个回执在同一份快照中加载，再精确比较时间。协议测试同时覆盖版本刷新中间态与真实时间不一致，后者必须仍然失败。

分身 Beta 按钮开放后，项目头部仍按可用宽度切换完整页签和紧凑下拉导航。
[CI 42196630424](https://github.com/wecode-ai/Wegent/actions/runs/42196630424)
的 Cloud 第 1 分片中，`plugin-source-continuation-evidence.json` 与
`plugin-detail-resilience-evidence.json` 均记录找不到 `collaboration-tab-manage`；
`plugin-detail-resilience-healthy-before-fault.png` 显示真实页面处于“执行环境”，
顶部已使用“项目设置”下拉框。`ProjectViewSwitcher` 在紧凑模式只渲染
`collaboration-project-view-select`，因此两处固定页签点击改为复用
`selectCollaborationProjectView`，兼容两种真实导航形态。故障前健康基线、插件绑定
持久化、故障注入、权限和恢复断言全部保留，不扩大超时或跳过场景。

长对话切换的原断言和等待窗口保持不变。[CI 42199573796](https://github.com/wecode-ai/Wegent/actions/runs/42199573796/job/127832839476)
在 520 条进度消息的初始正文处超时；执行器历史已包含正文，渲染器的 CPU 采样
`conversation-switching-initial.cpuprofile` 经对应构建的 source map 定位到
`MessageList` 布局回调反复读取共享页脚高度，累计约 1.9 秒同步布局开销。
页脚测量改为由滚动控制器提交和尺寸观察触发，虚拟行更新继续执行原定位逻辑。
组件回归验证 520 次行更新不会重复测量页脚，同时保留尺寸变化和页脚移除、重新挂载时的高度更新。
