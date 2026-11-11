---
sidebar_position: 9
---

# 工作台应用

智能工作台与轻应用统一为 **工作台**，共用 DSH 的项目格式、安装、运行和数据管理。它们与用于编写代码的“代码工作台”是不同的产品对象。

## 创建和打开

桌面端从 **左侧栏 → 应用 → 工作台 → 我的** 进入，不需要打开实验性功能。市场需要云端连接；本机创建和运行不依赖市场。

- **创建工作台**：填写名称，选择 **轻量型** 或 **扩展型**。轻量型适合计算器、便签等小工具；扩展型适合组合 DSH 插件和服务。用途说明和保存位置可选，目录标识可在高级选项修改。未指定位置时使用文档目录下的 `WeworkSmartApps`。随后打开关联目录的开发对话。
- **创建 TODO 便签**：阅读原生安装确认中的名称和系统能力，接受后打开。取消确认不会安装或打开。
- **关联文件夹** / **导入工作台**：关联现有 DSH 源码目录，或导入安装包。安装时检查版本与能力；旧轻应用目录经明确导入转换为 DSH，不会继续运行旧引擎。
- **运行** / **打开**：启动或聚焦现有实例。默认使用独立窗口。列表显示安装和运行状态，失败会显示错误，已有列表不会因刷新失败消失。

## 打开方式和快捷打开

从工作台卡片的 **更多操作 → 工作台设置** 选择 **打开方式 → 独立窗口 / 主窗口标签页**。两种类型均支持这两种方式。选择立即保存；运行中的工作台会移动同一个页面，保留未保存的输入和当前页面状态。

**启动 Wework 时自动运行** 控制下次启动是否恢复该工作台。**关闭窗口后继续后台运行** 单独决定关闭按钮是否保留运行；**隐藏窗口并保持运行** 保留当前实例；**停止** 释放运行时，保留本机数据和已登记提醒。完全退出 Wework 会停止运行。

在设置的 **全局快捷键** 输入组合，例如 `CommandOrControl+Shift+T`，点击 **保存**。Wework 运行时，按键打开或聚焦目标；目标已聚焦时再次按下会隐藏。留空保存可清除。冲突或无效组合显示错误，不会覆盖其他应用的快捷键。

**创建桌面快捷方式** 在 macOS 生成绑定所属 Wework 实例和数据目录的 `.app` 启动入口，避免开发版与正式版互相打开；Windows 生成 `.url`，Linux 生成 `.desktop`。打开时可直接启动目标工作台，无需先打开主窗口。Windows 和 Linux 须已注册 Wework 协议。重新创建 macOS 快捷方式会清理该工作台原先生成的 `.webloc`；用户修改过的文件会保留。

**移除** 先确认，再停止实例、注销快捷键、取消提醒并删除应用拥有的数据和安装副本；关联的外部源码目录保留。取消确认不改变运行状态。

## 模型和开发

类型不决定是否需要模型。未使用 AI 的轻量工具可以直接运行；使用 AI 时可为每个安装分别绑定 Wework 模型。显式绑定的模型被删除或不可用时，需要重新选择。云端模型仍按当前登录用户的权限校验，独立窗口不要求主界面先打开。

**开发工作台** 继续编辑相同目录；**添加 DSH 插件** 适用于扩展型项目。开发预览支持 **验证**、**添加插件**、**刷新页面** 和 **重新加载 DSH**。导出前必须通过当前源码验证；修改源码会使旧验证过期。市场安装的工作台先 **复制为我的工作台** 再修改。**发布** 和 **管理范围** 仍使用原市场权限。

## 系统能力和提醒

安装清单声明所需能力，原生确认决定是否授予。通知、剪贴板、文件选择器和外部链接分别受能力限制；应用不能通过页面参数指定其他安装身份或任意文件路径。

数据按安装 ID 隔离。提醒由宿主持久化调度，隐藏或停止工作台不会取消；完全退出时暂停，重启后恢复并处理逾期提醒。系统通知还需要操作系统允许。

## 开发契约

AI 通过宿主提供的绝对路径 `WEWORK_CLI_PATH` 调用当前任务绑定的 CLI，不依赖裸 `wework` 的 PATH 查找，不修改用户启动器。缺少绑定或命令失败时应报告真实错误；不能宣称已安装或打开。

```sh
"$WEWORK_CLI_PATH" workbench create --project "/absolute/my-tool" --name my-tool --display-name "我的工具" --flavor lightweight --format json
cd "/absolute/my-tool"
node scripts/build.mjs
"$WEWORK_CLI_PATH" smart-app verify --project "/absolute/my-tool" --format json
"$WEWORK_CLI_PATH" workbench install --project "/absolute/my-tool" --format json
"$WEWORK_CLI_PATH" workbench launch --id INSTALLATION_ID --presentation window --format json
```

`smart-app verify` 检查包、构建和隔离 DSH 页面就绪；不会为待安装源码授予原生能力。系统 SDK 和业务操作应在真实安装确认后验证。

安装返回顶层 `id` 才是安装身份；`null` 表示取消，不继续启动。`plugin-manifest.json` 的 `flavor` 为 `lightweight` 或 `extended`，省略时为扩展型。打开方式保存在安装偏好中。

轻量型编辑根目录 `view.html` 和本地资源，保留生成的可信 DSH 桥接模块。页面运行在不透明源沙箱内，通过 `window.weworkWorkbench` 异步调用：

| API                                                                | 能力要求                                       |
| ------------------------------------------------------------------ | ---------------------------------------------- |
| `storage.get()` / `storage.set(value)`                             | 安装自己的 JSON，最大 1 MiB                    |
| `storage.commit({value, reminders?})`                              | 原子保存数据和提醒；提供提醒需 `notifications` |
| `notifications.show({title, body})`                                | `notifications`                                |
| `reminders.schedule({id,title,body,at})` / `list()` / `cancel(id)` | `notifications`                                |
| `clipboard.readText()` / `writeText(text)`                         | `clipboard.read` / `clipboard.write`           |
| `files.openText()` / `saveText({name,text})`                       | `files.read` / `files.write`，通过原生选择器   |
| `external.open(url)`                                               | `external.open`，HTTP(S) 或 `mailto:`          |
| `window.hide()` / `setAlwaysOnTop(boolean)`                        | 当前工作台窗口                                 |

保存完整提醒集合时，即使是 `[]` 也需要通知能力；省略则保留现有提醒。最多 100 项且 ID 唯一，新增时间必须在未来。更新数据和提醒时使用 `storage.commit`，避免只保存其中一半。

```mermaid
flowchart LR
  Entry[应用列表 / AI / CLI / 快捷方式] --> Host[统一宿主应用服务]
  Host --> Registry[DSH 安装与数据]
  Host --> Runtime[DSH 运行时]
  Runtime --> Light[轻量型沙箱页面]
  Runtime --> Extended[扩展型插件与服务]
  Host --> Surface[同一个页面实例]
  Surface --> Window[独立窗口]
  Surface --> Tab[主窗口标签页]
  Runtime --> Capabilities[安装身份与已授权系统能力]
```
