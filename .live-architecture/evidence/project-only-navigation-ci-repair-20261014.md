# 项目访客导航 CI 展开状态修复

用户要求处理 PR 检查失败。事务 `tx-092655cd0ba9` 基于 A00000014，修改回归 `arch://wegent/test/94f7802d`，不改变 UI 或 CP 权限规则。

## 失败证据

提交 `8ef243d2eab8d654438f035e64cb9236c0b45090` 的 [Core 10 检查](https://github.com/wecode-ai/Wegent/actions/runs/38577143551/job/115901214715) 中，新增 `collaboration-shared-core` 场景找不到项目按钮。其他检查已成功，汇总失败来自同一分片。

CI 产物 `collaboration-shared-core-01-all-workspaces.png` 显示项目访客的父空间原本已展开，直接邀请和公开读取两个项目均可见。`scenario-state.json` 显示测试无条件点击父空间箭头，随后本地空间和重复点击步骤中父空间仍存在、设置入口仍不可用，但展开状态被测试自身切换为折叠；最终项目按钮自然不在 DOM。失败后的 `ui-snapshot.json` 也保留该父空间标签和展开控制，但没有项目按钮。

多个导航源按完成顺序显示，先显示的父空间可能被现有 UI 自动展开。测试不应假设它一开始一定折叠。完整产物包含会话数据，仅留本地忽略目录，未提交。

## 修复与验证

删除测试的无条件 toggle。新增共享辅助函数读取必需的 `aria-expanded`，仅在 false 时点击，并等待真实 true 状态。每次切换本地后先断言父空间存在及权限拒绝，再明确展开、等待项目入口、打开真实项目。保留公开 Viewer 创建 403、父空间详情/成员/智能体/设备 404、私有兄弟项目隐藏与 404 的所有断言。

新增辅助函数回归覆盖初始 true（不点击）、false（点击一次），以及无展开状态时拒绝且不点击。保持现有 10 秒步骤超时，没有重试、跳过或放宽安全断言。本次未本地执行 E2E 或 ai:verify；新增真实场景仍由现有 GitHub CI checkpoint 执行。

实际验证：`pnpm --filter wework test scripts/workspace-project-creation.test.mjs` 共 11 项通过；修改的三个脚本经包内 Prettier 和 ESLint 检查；E2E helper 与模块 `node --check` 和 `git diff --check` 通过。生产实现未修改，远端 E2E 待新提交验证。
