---
sidebar_position: 12
---

# 手机版错误提示

手机版使用统一错误入口：操作失败调用 `showErrorAlert`，页面、表单和任务中的持续错误使用
`ErrorNotice`。已有状态驱动的操作错误使用 `NativeErrorAlert`。不要自行增加错误弹窗样式。

## 平台行为

- 后台连接、设备发现和列表读取失败只在侧边栏头像显示重试标记，不弹窗，也不在其他页面
  重复提示。点击头像标记重试读取，重试期间保留标记，成功后移除；设置入口保持可用。
- 列表首次加载后由用户下拉、点击重试、切换设备或完成明确操作时更新。回到前台、Socket
  重连、任务事件和凭证续期不刷新列表。会话流式输出独立保持实时。
- iOS 弹窗使用 React Native `Alert` 对应的 UIKit 系统警告框；Android 使用系统原生警告框。
  外观、深浅色、文字缩放、按钮布局和读屏由系统处理。Android 最多三个按钮，按中立、取消、
  确认顺序传入；重试始终是明确的用户操作。
- 加载、表单、设置和会话中的持续失败放在原位置，使用中性背景、错误图标和简短说明。
  不遮挡输入框，不使用限时消失的 Snackbar 承载必须处理的错误。
- 保留已有内容、草稿和重试操作。一次失败不应阻断无关页面，也不应自动重复提交任务。
- 默认不显示原始异常、URL、HTTP JSON 或堆栈。错误分类复用 PC 的 `parseChatError`；未知错误
  不推测原因。技术信息通过“复制详情”显式获取，复制前隐藏令牌、密码和 URL 中的认证信息。

## 开发入口

```tsx
showErrorAlert(cause, { title: '无法打开文件' })

<ErrorNotice
  error={error}
  title="无法读取文件夹"
  testID="folder-error"
  onRetry={reloadFolder}
/>
```

传入原始错误；不要在各页面中重复解析或拼接异常。重试必须调用原操作，不得把“刷新列表”
作为所有失败的通用恢复方式。只有本来就有的恢复动作才应显示重试按钮。

修改提示时运行错误文案、原生按钮行为、上下文提示和来源边界的单元/组件测试，再执行 Mobile
类型检查和 iOS、Android 导出。来源边界测试防止绕过统一 Alert 入口或重新输出原始错误。
测试不代表已在真机验证视觉效果；真机验证应另行记录平台、系统版本和实际操作。

平台依据：[Apple Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts)、
[Apple Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback)、
[Apple Writing](https://developer.apple.com/design/human-interface-guidelines/writing)、
[Material Dialogs](https://m3.material.io/components/dialogs/guidelines)、
[Material Snackbar](https://m3.material.io/components/snackbar/overview)。
