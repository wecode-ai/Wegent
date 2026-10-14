# Issue 打开后未读未清除：修复与验证

用户目标：修复协作 Issue 打开后仍显示未读。本次不再调查用户已自行定位的加载超时。

事务：`tx-ba53fbb4cd2c`，起点 `A00000004`，已通过检查并合入架构修订 `A00000007`，合入后校验通过。读取项目与协作界面的既有模型；新增记录 `arch://wegent/ui/issue-read-e27a` 和 `arch://wegent/test/issue-read-e27a`。

并行的恢复事务先合入了 `A00000006`，检查报告两项非阻塞 stale-read 提醒。已重新检查当前项目存储、详情 API 路由和看板 `replaceIssue` 调用；本次未改变其权限或存储契约，针对当前代码的测试通过。检查结果没有阻塞冲突并允许合入。AI rebase 被工具拒绝（该操作要求 human 身份）；没有冒用 human 身份，保留起点历史，按工具允许的合入路径整合。

## 根因和实现

桌面 `TaskActivityView` 调用 `useIssueActivityScroll` 时没有传入 Issue 身份、已读游标或已读回调，详情因此无法持久化读取状态。普通 `IssueChatMessage` 已有逐条动态序号，负责人特殊动态缺少序号。原共享逻辑也依赖存在消息元素，不能处理只有创建记录的空讨论。

桌面现在在对应 Issue、客户端及版本的快照成功返回后，使用项目所属的云端或本地 API 保存可见动态序号，并经 `onTaskUpdated` 更新已有详情/看板状态。共享逻辑允许可见空讨论保存序号 0，重新检查可见的新消息或内容版本，在成功后才确认游标，并按请求和 Issue 隔离状态。失败由宿主报告，保留状态等待可见性事件重试。

没有修改数据库表、清洗数据、修改权限不变量、提交部署或操作用户窗口。

## 测试计划和实际结果

| 场景 | 测试前提与操作 | 预期及实际结果 |
| --- | --- | --- |
| 云端/本地空讨论 | 未读 Issue、空快照、详情可见；等待订阅完成 | 各自的 API 写入序号 0，回传已读对象；单元测试通过 |
| 订阅失败/隐藏详情 | 保持加载或拒绝订阅；空详情高度为 0 | 不写已读；单元测试通过 |
| 动态可见性 | 一条消息可见，另一条在屏幕外；再滚动使其可见 | 先读第一条，再推进到第二条；单元测试通过 |
| 读取失败与恢复 | 首次已读 API 拒绝，再触发滚动 | 首次保留状态，第二次成功并清除错误；单元测试通过 |
| 新动态与内容版本 | 在视口内增加消息；改变内容版本而保持序号 | 自动保存新的游标或内容读取；单元测试通过 |
| 并发和导航 | 同一读取未返回时再次滚动；切换 Issue 后返回旧请求 | 去重且隔离 Issue 读取状态；单元测试通过 |
| 服务端持久化 | 现有 API 测试创建未读成员、保存游标和遗留元数据 | 3 个针对性后端测试通过 |
| 桌面 CI 回归 | 另一成员创建空 Issue，打开/关闭/重开；评论深链到可见评论 | 已加入现有 notification checkpoint；语法检查通过，本次未运行 E2E |

最终测试：Wework 2 文件 **141 通过**，共享协作 3 文件 **77 通过**，后端 **3 通过**，共 **221 通过**。Wework 与共享协作 TypeScript 检查、Wework ESLint、改动代码 Prettier 检查、E2E 场景语法检查通过。

可复现命令：

```bash
pnpm --filter wework test src/features/todo/TaskActivityView.test.tsx src/features/todo/TodoEditor.test.tsx
pnpm --filter @wegent/collaboration test src/issue-detail/useIssueActivityScroll.test.tsx src/issue-detail/IssueActivityPanel.test.tsx src/workspace-controller/useCollaborationWorkspaceController.test.ts
cd backend
uv run pytest tests/api/test_deliveries_api.py -k "unread or mark_loop_item_read" --assert=plain --tb=line --show-capture=no
```

日志保存在本地忽略目录 `.pids/issue-unread-*.log`。初次桌面测试暴露新增初始化分支调用 jsdom 未实现的 `scrollTo`（75 个断言通过，21 个未捕获错误）；初始定位现在使用原生 `scrollTop` 和已有滚动工具，最终运行无未捕获错误。初次 lint 暴露 effect 内同步更新状态；改为根据已返回快照的身份和版本推导加载成功，最终 lint 通过。没有放宽超时、跳过断言或通过盲目重跑掩盖失败。

按照仓库策略，未运行 E2E 或 `ai:verify`，也未验证用户实际 Electron 窗口。本次证据确认实现与针对性测试；不宣称已部署或用户窗口已运行确认。
