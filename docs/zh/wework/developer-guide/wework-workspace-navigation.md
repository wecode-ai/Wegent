---
sidebar_position: 41
---

# 工作区标签页导航

通知列表、系统通知、托盘和跨产品入口必须按目标类型选择标签页。
`navigateTo` 对内置任务、项目空间、智能体及已注册 DSH 路由派发共享导航事件，
由 `navigateWorkspaceTab` 选择目标，避免将当前项目空间标签改成任务标签。
路由类型由 `resolveWorkspaceTabKind` 统一解析，供导航与标签类型推断共用。

任务首先按设备 ID 和任务 ID 匹配已有会话标签；否则依次复用同类型的当前标签、
固定标签或其他标签，没有同类型标签时才创建。重复点击不增加标签。
设置页临时覆盖当前界面并保存返回位置；带 `workspaceTab` 的路由明确指定目标，
不再派发导航事件。登录等不属于工作区的路由保持页面导航。

## 回归验证

`notification-tab-navigation` 已接入桌面 checkpoint 和 GitHub Core 分片。
场景通过真实本地任务、执行器和 Electron 托盘完成以下验证，仅模型响应使用测试服务：

1. 在任务执行期间切到项目空间，通过托盘打开任务，复用原任务标签。
2. 返回项目空间后让任务完成，从通知列表打开任务，清除未读并显示完成内容。
3. 再次切到项目空间，通过系统通知打开同一任务，不增加标签。
4. 每次返回原项目空间标签，仍显示项目空间路由。

使用 `pnpm --filter wework e2e:desktop --segment notification-tab-navigation` 单独执行。
场景自行创建所需项目和任务，由共享 runner 清理隔离目录与进程。
单元测试另覆盖内置路由、已有目标会话、重复点击、设置页及明确指定标签的导航。

2026-10-24 本地验证：7 个聚焦 Vitest 文件共 99 条用例、TypeScript、ESLint、
格式检查及 CI 分类测试通过；上述 checkpoint 在隔离的 macOS Electron 中通过。
另用 `ai:verify` 验证不可用设备的任务通知：选择任务标签后仍可返回原项目空间。
临时证据保留在本地 `wework/test-results/`，不提交运行目录或会话文件。
