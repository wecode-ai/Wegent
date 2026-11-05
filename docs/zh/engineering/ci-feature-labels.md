---
sidebar_position: 35
---

# PR 功能 CI 标签

PR 的 Lint、类型检查、单测和插件 SDK 检查继续按改动路径自动运行。
重型 E2E 根据功能标签选择场景，在现有共享构建、平台分片和桌面 runner 中执行。
`Platform E2E Summary` 和 `Wework E2E Summary` 同时验证标签覆盖与实际 job 结果。

## 选择标签

| 标签               | 功能范围                                         |
| ------------------ | ------------------------------------------------ |
| `ci:chat`          | 输入、消息、流式展示、语音、交互回答             |
| `ci:agents`        | 智能体、机器人、模型、Shell、Skill 配置与目录    |
| `ci:collaboration` | 项目、Issue、看板、派发、成员、评论与交付物      |
| `ci:workspace`     | 工作区、文件、附件、预览、产物、Git 与 worktree  |
| `ci:runtime`       | 执行、队列、终端、取消、恢复、Goal 与历史        |
| `ci:devices`       | 注册、身份、连接、远程设备与设备生命周期         |
| `ci:plugins`       | 市场、安装、卸载、更新、连接器、授权、MCP 与 SDK |
| `ci:knowledge`     | 导入、文档协议、转换、索引、检索                 |
| `ci:automation`    | 自动执行、订阅、回调、通知指令与 AI Card         |
| `ci:stand-in`      | 分身、来源连接、确认、个人任务与项目协调         |
| `ci:browser`       | 内嵌浏览器、标注、Computer Use 与 Harness App    |
| `ci:desktop`       | 窗口、启动、托盘、菜单、代理与宿主状态           |
| `ci:auth`          | 登录、身份、共享访问、权限与安全隔离             |
| `ci:release`       | 更新与发布相关完整功能回归                       |
| `ci:all`           | 全部登记的功能、原有平台和专项回归               |

多个功能标签取场景并集。同一模式下的同一 checkpoint 只调度一次；
本地与 Cloud 中同名的场景仍分别运行。必需标签保留原分类器识别的客户端范围，
避免仅修改桌面时额外启动 Web 服务，或仅修改 Web 时启动整套桌面环境。
原分类器已有精确桌面选择时，保留该最小集合；只有原先的宽范围选择才按功能包裁剪。
额外添加非必需功能标签或平台标签可显式扩大范围。首版不裁剪场景内部断言。

`ci:windows` 增加所选功能已有的 Windows Core 场景，不代表 Cloud/Plugins 的 Windows 全覆盖。
仅当所选功能的并集中没有 Windows Core 场景时，此标签才会导致计划检查失败。
`ci:macos` 增加现有 macOS Inspector 验证，不代表任意功能的 macOS 等价覆盖。
路径判定原本必需的 macOS Inspector 仍保留。`ci:memory` 标签可被接受，但单独添加不会选择内存专项；
只有 `ci:all` 或 CI 策略变更触发的自动全量 PR 计划会选择该专项。

## PR 操作流程

1. 提交 PR。基础检查自动运行，E2E 计划在 Actions Summary 列出必需标签、选中功能和计划哈希。
2. 添加建议的功能标签，也可添加更多标签扩大验证；`ci:all` 覆盖全部功能要求。
3. 缺标签、拼错 `ci:*` 标签或请求了不存在的平台覆盖时，昂贵任务不启动，两个 E2E Summary 失败。
4. 添加或删除 `ci:*` 标签会取消旧计划并计算当前计划。新提交重新识别必测功能。
5. Summary 完成前再次读取 PR，验证 head、目标分支和 CI 标签仍匹配。旧提交或删标签前的结果不能替代当前计划。

业务标签不会取消代码验证，也不会发布同名的 E2E Summary 成功结果。
基础 Lint/单测工作流保留其现有标签事件行为。

纯文档改动不需要功能标签。协作权限契约文档仍要求权限及协作验证。
未知业务代码、锁文件保守要求显式 `ci:all`。公共 CI 策略、工作流及选择器变更自动执行全量验证，
包括所有模块单测、原生认证 SDK、平台与桌面 E2E，以及全量 PR 的内存专项和 Windows/macOS 检查。
这避免首次启用依赖尚未创建的标签或贡献者的标签写权限；它仍要求实际全量测试通过。
公共策略路径统一维护在 `.github/scripts/lib/ci-policy-paths.sh`，由模块、SDK 分类器和功能计划器共享。
同一文件也记录已知的构建、缓存和调度工具由哪些 CI 使用。这些工具的改动只触发对应的模块或 E2E 套件。
首版也会保守处理测试注册文件的变更；只有补齐精确依赖证据与契约检查后，才可收窄这些规则。

记录的 base SHA 用于解释本次 diff。主分支向前推进不会单独使同一 head 的测试失败；
最新主分支集成仍由分支保护和 merge queue 检查负责。merge queue 保留平台全量验证，
桌面部分按合并组的产品 diff 选择，继续排除原有 Windows/macOS 专项。

## 清单与执行

`.github/ci/features.json` 显式登记每个前端 spec 的功能与 Playwright project，
以及 Core、Cloud、Plugins 的 checkpoint 归属。
`.github/scripts/ci-feature-policy.mjs` 登记路径最低要求和工作流内的独立集成命令。

新增 spec 或桌面场景必须更新清单。计划器对缺失的文件、未知 project、无归属的场景、
重复 spec 归属直接报错，不会静默忽略新覆盖。桌面分片继续由原分类器提供，
功能选择只过滤其现有矩阵。平台功能包按 spec 分配到主干现有的最多八个分片，provider 测试保持单 worker。
只有 provider 测试的分片先运行既有 setup，继续遵守其原有 `--no-deps` 约束。

附件存储与复制、MySQL 并发、知识库、钉钉文档协议、订阅和通知验证均有独立功能归属，
并留在原有物理分片上。第一版继续复用这些 job 已有的完整服务准备，不另建每功能一套服务。
定时、手动及全量计划保留原完整矩阵和 Playwright 分片参数。

`ci:release` 不发布安装包，不授予升级兼容性资格。
真实源包到目标包的升级、回滚、迁移及哈希证据仍由现有发布维护合同和发布验证器负责；
本变更不修改它们。内存专项仅由显式 `ci:all` 或公共 CI 策略改动的全量 PR 触发，
不因定时运行或单独添加 `ci:release` 而增加。

## 启用与维护

合并后 `CI Feature Labels` 工作流创建或更新这些标签，不删除其他标签。
也可在主分支手动运行该工作流。它仅有标签写权限，不处理 PR 提交的代码。
Fork PR 的 E2E 只需读取 PR 元数据，无需标签写入或新的外部服务。
外部贡献者没有标签写权限时，由维护者添加功能标签。引入本机制前已打开的 PR 应同步最新主分支，
使其被验证的 head 同时包含新的计划器、工作流和场景清单。

分支保护应要求现有 `Platform E2E Summary` 与 `Wework E2E Summary`。
首个包含选择器改动的 PR 自动运行全量验证，标签同步在合并后执行。

本地聚焦验证：

```bash
node --test .github/scripts/ci-feature-plan.test.mjs
bash .github/scripts/test-classify-ci-changes.sh
```

这些命令验证计划、覆盖与工作流契约，不执行产品 E2E。
CI 仍执行被选中的真实集成测试，不增加自动重试或放宽业务断言。
