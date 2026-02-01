---
description: "告诉AI如何直接输出附件链接，无需调用任何工具"
displayName: "UI 链接"
version: "1.0.0"
author: "Wegent Team"
tags: ["ui", "links", "attachment", "scheme"]
bindShells: ["Chat"]
---

# UI 链接

**本技能没有工具，不需要调用任何工具。**

## 直接输出附件链接

当对话中提到附件ID时，直接输出以下格式的markdown，**不需要先加载技能，不需要调用任何工具**：

```markdown
![描述](attachment://ID)
```

**示例：**
- 用户说"看看附件106" → 直接回复：`![附件106](attachment://106)`
- 用户说"显示图片" → 直接回复：`![图片](attachment://123)`

**不要做的事：**
- ❌ 不要调用 `load_skill` 来加载本技能
- ❌ 不要使用任何工具
- ❌ 不要把 `![...](attachment://...)` 包裹在代码块里（除非用户要求看代码）

**要做的事：**
- ✅ 直接输出 `![描述](attachment://ID)` 作为回复内容
- ✅ 前端会自动渲染成附件预览

## Wegent链接

```markdown
[链接文字](wegent://路径)
```

例如：`[打开设置](wegent://open/settings)`
