---
sidebar_position: 1
---

# 修复前复现

代码基准：`a451b8183`。环境：Wework Vitest/jsdom，真实 React 创建对话框，接口使用单元测试夹具。

1. 在普通 `CloudTodoWorkspace` 点击 `cloud-project-add`。
2. 检查 `collaboration-project-create-add-collaborator`。
3. 修复前稳定失败：该节点不存在。普通入口没有传入 `resourceSetup`，共享对话框跳过整个协作者区域。

复现命令：

```text
pnpm --filter wework test src/features/todo/CloudTodoWorkspace.test.tsx -t "opens the cloud project creation flow"
```

另一个已复现的问题：共享 controller 在 `configure` 失败后重试时再次调用 `target.create`；并发提交也调用两次。新增的 recovery 测试在修复前均失败。

这些证据来自组件和 controller 测试，不代表已经执行真实云端或 Electron 验收。

# Before-fix evidence

At `a451b8183`, the ordinary creation component test consistently failed because the collaborator trigger was absent. Its shared dialog received no resource setup. Controller tests also reproduced duplicate project creation after configuration failure and concurrent submission. These are unit-test observations, not live-server verification.
