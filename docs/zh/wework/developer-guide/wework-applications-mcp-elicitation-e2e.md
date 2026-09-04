---
sidebar_position: 37
---

# 应用入口与 MCP Elicitation 桌面 E2E

本文定义 Wework“应用”入口和 MCP 业务表单的真实桌面端回归方案。测试复用现有桌面 runner 与 checkpoint，不新增本地专用脚本，也不使用浏览器 mock 替代 Electron、Executor 或 Codex。

## 覆盖范围

本方案覆盖两组独立风险：

1. “应用-站点”和“应用-小程序”是否把用户带入新的空白任务，并生成正确的结构化 Composer 草稿。
2. 完整访问模式下，MCP server 发起的 `elicitation/create` 是否仍能显示为 Wework 表单，并把用户答案原样送回 MCP runtime。

应用插件的稳定技术标识和用户可见名称如下：

| 应用类型 | 插件技术标识                     | 用户可见名称         |
| -------- | -------------------------------- | -------------------- |
| 站点     | `wegent-sites`                   | 快速建站             |
| 小程序   | `weibo-miniapp-h5-develop-agent` | 微博小程序H5开发助手 |

测试不得用可见名称替代技术标识。技术标识用于安装 API、Composer 节点属性和插件 URI；可见名称用于界面和草稿文本断言。

## Checkpoint 与真实边界

应用入口场景放入现有 `sites-plugin-auto-install` 插件 checkpoint：

```bash
pnpm --filter wework e2e:desktop:plugins -- --segment sites-plugin-auto-install
```

MCP 表单场景放入现有 `permission-modes` core checkpoint：

```bash
pnpm --filter wework e2e:desktop -- --segment permission-modes
```

两个 checkpoint 都必须由 GitHub CI 调用。新增的 MCP fixture 应在桌面 E2E 分类脚本中显式映射到 `core:permission-modes`，避免只修改 fixture 时触发无关桌面套件。

## 应用入口用例

### 公共前置条件

- 使用 Sites upstream 的固定站点 `E2E Product Site`，项目 ID 为 `prj_e2e_product`。
- 使用固定小程序 `E2E Mini Program`，项目 ID 为 `prj_e2e_mini`。
- 每次点击入口前记录 Composer 的 `standaloneChatKey`、`scopeKey`、当前项目 ID 和当前 runtime task。
- 点击后必须同时满足：`standaloneChatKey` 增加 1、`scopeKey` 改变、`currentRuntimeTask` 为 `null`、当前项目不变。
- 草稿必须做规范化后的完整相等断言，并额外验证结构化 chip 属性；仅断言包含某段文字不够。

### 管理站点环境变量

1. 打开 `E2E Product Site` 行末的更多菜单和“环境变量”。
2. 新增 `Plain` 变量 `E2E_API_BASE=https://api.example.test` 并保存。
3. 等待对话框显示保存成功，并断言请求经过真实 Backend 后写入 Sites upstream fixture。
4. 截图保存成功状态并关闭对话框。

### 管理站点协作者

1. 打开 `E2E Product Site` 行末的更多菜单和“管理协作者”。
2. 添加 `e2e-collaborator`，等待其出现在列表并断言 upstream fixture 已保存。
3. 移除同一协作者，等待其从列表消失并断言 upstream fixture 已清空。
4. 截图最终状态并关闭对话框。

### 站点列表“继续开发”

1. 打开“应用-站点”。
2. 点击 `E2E Product Site` 行的“继续开发”。
3. 等待新的空白任务 Composer 出现。
4. 断言可见草稿为：

```text
快速建站 E2E Product Site 请说出你要做的改动
```

5. 断言内部草稿为：

```text
[$快速建站](plugin://wegent-sites@wegent) [E2E Product Site](wegent-sites-project://prj_e2e_product) 请说出你要做的改动
```

6. 断言插件 chip 指向 `wegent-sites@wegent`，并断言链接 chip 的 provider、label 和 URL 分别为 `wegent-sites-project`、`E2E Product Site` 和 `wegent-sites-project://prj_e2e_product`。
7. 断言首次使用按需安装 `wegent-sites`，页面没有 `sites-create-error`。

### 创建“站点”

1. 返回“应用-站点”，打开创建菜单并点击“站点”。
2. 等待新的空白任务 Composer 出现。
3. 断言可见草稿为：

```text
快速建站 Build an internal website and validate it locally
```

4. 断言内部草稿为：

```text
[$快速建站](plugin://wegent-sites@wegent) Build an internal website and validate it locally
```

5. 断言插件 chip 的技术名称和 marketplace 分别为 `wegent-sites` 和 `wegent`。
6. 断言复用上一步已安装插件，不重复调用 ensure-installed。

### 创建“小程序”

1. 返回应用页，切换到“小程序”，打开创建菜单并点击“小程序”。
2. 等待新的空白任务 Composer 出现。
3. 断言可见草稿为：

```text
微博小程序H5开发助手 创建并发布一个小程序
```

4. 断言内部草稿为：

```text
[$微博小程序H5开发助手](plugin://weibo-miniapp-h5-develop-agent@wegent) 创建并发布一个小程序
```

5. 断言插件 chip 的技术名称和 marketplace 分别为 `weibo-miniapp-h5-develop-agent` 和 `wegent`。
6. 断言首次使用按需安装小程序插件，页面没有安装错误。

## MCP Elicitation 用例

### Fixture

使用隔离的 stdio MCP server `mcp-elicitation-server.mjs`，暴露工具：

```text
wegent_sites_interactions.confirm_inner_site_access
```

收到 `tools/call` 后，fixture 保持调用未完成，并向 Codex 发送：

```json
{
  "method": "elicitation/create",
  "params": {
    "mode": "form",
    "message": "请选择内网访问范围",
    "requestedSchema": {
      "type": "object",
      "properties": {
        "audience": {
          "type": "string",
          "title": "访问范围",
          "enum": ["all", "owner"],
          "enumNames": ["所有人", "仅自己"]
        }
      },
      "required": ["audience"]
    }
  }
}
```

fixture 收到 Codex 响应后，先把原始结果写入当前 E2E result directory 的 JSONL 文件，再完成 `tools/call`。接受 `owner` 时工具返回唯一标记：

```text
E2E_MCP_ELICITATION_ACCEPTED:owner
```

### Codex 配置

基础隔离配置继续保留：

```toml
approval_policy = "never"
```

仅增加测试 MCP server：

```toml
[mcp_servers.wegent_sites_interactions]
command = "<当前 Node 可执行文件>"
args = ["<fixture 绝对路径>", "<证据文件绝对路径>"]
default_tools_approval_mode = "approve"
```

不能把基础配置改成 granular 来让测试通过。用户在 UI 中启用完整访问后，Executor 必须在 `thread/start`、`thread/resume`、`thread/fork` 和 `turn/start` 覆盖为 granular policy：关闭执行安全审批，同时保留 `mcp_elicitations: true`。

### 模型与协议步骤

固定模型场景必须按顺序处理三次请求：

1. 对固定提示返回 `tool_search`，查询 `confirm_inner_site_access`。
2. 从搜索结果中选择 namespace `wegent_sites_interactions`，调用 `confirm_inner_site_access`。
3. 只有在模型输入中同时出现该 tool call 的输出和 `E2E_MCP_ELICITATION_ACCEPTED:owner` 后，才返回最终完成文本。

真实链路为：

```text
真实模型请求
  → tool_search
  → MCP tools/call
  → elicitation/create
  → mcpServer/elicitation/request
  → Executor request_user_input
  → Wework 表单
  → 用户选择“仅自己”
  → MCP action=accept
  → 工具成功标记
  → 模型最终完成文本
```

### UI 与证据断言

场景在 `permission-modes` 已确认完整访问后、切换只读之前执行：

1. 发送固定测试提示，等待 `[data-testid="request-user-input-card"]`。
2. 断言卡片显示“访问范围”“所有人”“仅自己”，且不是普通 MCP tool approval 卡。
3. 表单出现时证据文件必须仍不存在，证明 Codex 没有提前自动 `decline`。
4. 点击 `request-user-input-option-audience-1`。单问题表单会自动提交，不再点击提交按钮。
5. 等待模型最终完成文本和 runtime task 空闲。
6. 展开 `final-processing-toggle`，等待 `request-user-input-summary` 显示“仅自己”。
7. 精确断言 fixture 证据：

```json
{
  "action": "accept",
  "content": {
    "audience": "owner"
  }
}
```

## 证据与失败定位

成功运行至少保留：

- 三个应用入口各自的新任务草稿截图。
- MCP 表单可见截图。
- MCP 提交摘要和最终完成截图。
- fixture 的原始 JSONL 回执。
- runner 自动保存的 UI snapshot、模型请求和 executor 日志。

典型失败含义：

| 失败位置                                | 优先检查                                                         |
| --------------------------------------- | ---------------------------------------------------------------- |
| 新任务 identity 未变化                  | `openInNewChat`、queued plugin trial 消费和 Workbench scope 切换 |
| 文本正确但 chip 属性错误                | 插件技术标识、marketplace 或结构化 Composer parser               |
| 等不到 MCP 表单，fixture 记录 `decline` | 完整访问的 runtime `approvalPolicy` 是否保留 `mcp_elicitations`  |
| 表单可见但 fixture 无 `accept`          | Executor 的 enum label 到稳定 enum value 映射与回复路由          |
| 模型未完成                              | MCP tool output 是否回到下一次模型输入，成功标记是否一致         |

测试结束时由现有 runner 终止 Electron、Executor、Codex 和 stdio MCP 子进程，并清理隔离 home。fixture 不得读取或写入用户的个人 Codex home。
