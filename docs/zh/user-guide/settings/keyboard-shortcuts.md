---
sidebar_position: 5
---

# 键盘快捷键

Wework 桌面版在 Tauri 运行时提供本地键盘快捷键。快捷键配置只保存在当前设备，不写入 Backend，也不会随云端连接同步。

## 打开设置

在 Tauri 桌面版中，进入 **设置 → 个人 → 键盘快捷键** 可以查看和修改本机快捷键。每一行显示命令名称、说明、当前按键绑定，以及恢复默认或清除绑定的操作。

修改快捷键后，Wework 会立即刷新当前窗口中的快捷键监听。

## 默认快捷键

| 命令         | 默认按键                    | 说明                                           |
| ------------ | --------------------------- | ---------------------------------------------- |
| 切换底部面板 | `Command+J`                 | 显示或隐藏底部面板；底部面板打开时默认进入终端 |
| 打开设置     | `Command+,`                 | 打开设置页面                                   |
| 返回         | `Command+[` / Mouse Back    | 返回导航历史                                   |
| 前进         | `Command+]` / Mouse Forward | 前进导航历史                                   |
| 切换边栏     | `Command+B`                 | 显示或隐藏左侧边栏                             |
| 切换侧边面板 | `Alt+Command+B`             | 显示或隐藏右侧工作区面板                       |

当焦点在聊天输入框或终端内时，已注册的全局快捷键仍然生效；普通文本输入不会被拦截。

## 本地存储

用户修改后的快捷键覆盖项存储在本机 executor 的 runtime-work 目录：

```text
<WEGENT_EXECUTOR_HOME>/runtime-work/keybindings.json
```

未设置 `WEGENT_EXECUTOR_HOME` 时，默认路径位于：

```text
~/.wegent-executor/runtime-work/keybindings.json
```

文件内容是一个数组。每一项包含命令和用户覆盖的按键；`key` 为 `null` 表示清除该命令的绑定。

```json
[
  {
    "command": "openSettings",
    "key": "Command+,"
  },
  {
    "command": "openTerminal",
    "key": null
  }
]
```

Wework 内置默认快捷键不写入这个文件；只有用户修改、恢复或清除后的覆盖项会持久化。
