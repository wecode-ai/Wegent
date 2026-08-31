# 浏览器标注重写计划

更新日期：2026-08-31

关联需求：`WEWORKC2FA61-470`

## 目标

参考 ChatGPT Desktop 的职责拆分，完整替换 Wework 内置浏览器原有的页面注入式
标注主流程。重写采用 E2E-first：先建立真实 Electron、真实内置浏览器和 CI
checkpoint，再删除旧实现并根据失败证据完成产品代码。

```text
BrowserAnnotationController（主进程状态唯一来源）
  ├── Annotation Preload（命中、锚点、高亮、页面变化监听）
  ├── Annotation Overlay（独立评论与设计编辑器）
  ├── Renderer Projection（工具栏与 Composer 上下文）
  └── Screenshot Pipeline（页面区域截图）
```

## 删除项

- 删除 `window.__WEWORK_BROWSER_ANNOTATION__` 全局注入 API。
- 删除 100ms `getSnapshot()` 轮询。
- 删除挂载在被标注网页里的评论和设计编辑器。
- 删除旧 inline-style baseline/replay 双轨逻辑。
- 删除没有真实消费者的 `inspectId`、`ref`、`matchConfidence` 字段。
- 不保留新旧实现 fallback。

## E2E-first 交付

新增 `browser-annotation` 组合入口以及三个可独立执行、由 CI 调用的 checkpoint：

| Checkpoint                   | 当前验证范围                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `browser-annotation-core`    | 全页蓝色批注层、Element 选择、连续两次打开独立 Overlay、创建、编辑、删除、Marker、Composer 上下文、页面点击阻断 |
| `browser-annotation-anchors` | DOM 节点替换后的语义重绑、同 URL 刷新恢复、open ShadowRoot 选择                                                 |
| `browser-annotation-design`  | computed style 基线、颜色调整、Original View、截图、节点替换后的设计重放                                        |

统一场景文件：

```text
wework/e2e/desktop/scenarios/embedded-browser-annotation.scenario.mjs
```

Fixture 均由场景本地 HTTP server 提供，不依赖公网资源。场景只用页面
`evaluate` 读取断言值；创建、编辑、删除、切换 Original View 等产品状态全部走
真实 UI 或产品 capability。

## 实现步骤

### 1. 主进程状态与生命周期

- 新增 `BrowserAnnotationController`，以 browser label、page session 和规范化 URL
  管理评论、编号、编辑、删除、未解析锚点和 Original View。
- 主进程只向页面运行时发送最小 DTO，不发送截图、评论正文和时间戳。
- 页面运行时每完成一次渲染发布 `runtimeRevision`，供 Renderer 和 E2E 观察真实
  完成态，禁止用固定延时掩盖竞态。

### 2. 隔离的页面运行时

- 使用专用 sandboxed preload 处理命中测试、锚点解析、Marker 和设计样式。
- Marker 和选择框挂载到隔离 ShadowRoot。
- Anchor 保存稳定 selector、语义名称、文本、元素路径、矩形、fixed/sticky 和
  滚动容器信息。
- selector 失效时按语义、文本、标签和位置评分；证据不足或候选接近时不误绑。
- MutationObserver 忽略标注自身的 root、属性和样式节点，只对页面真实变化重绘。

### 3. ChatGPT 风格独立 Overlay

- 使用无边框透明 Electron 子窗口承载编辑卡，不污染网页 DOM。
- 采用紧凑深色卡片、圆角、选中元素 chip、评论输入、设计开关、保存/取消/删除
  操作。
- 设计模式展示从目标元素 computed style 读取的值，并支持颜色、字体、背景、
  边框、尺寸和间距等已声明属性。

### 4. Renderer 与 Composer

- 保留现有工具栏、右键入口和稳定 `data-testid`。
- Renderer 只消费主进程投影状态，不持有第二份评论真相。
- Composer 上下文由主进程评论转换生成，包含 URL、selector、语义、文本、
  rect、设计修改和截图。

### 5. CI 与验证

- 标注相关源码变化必须命中三个 checkpoint。
- 每个 checkpoint 建立自己的最小前置条件，支持单独运行。
- 证据截图只写入已忽略的 `wework/test-results/`，不得提交仓库。
- 提交前执行 TypeScript 检查、相关单元测试、三个真实桌面 E2E 和截图目视审查。
- push 负责运行仓库全量 pre-push 检查，不在本地重复跑全量回归。

## 当前边界

本次交付完整替换现有 Element 标注产品主流程。ChatGPT 编译产物中还能识别到
Region anchor；Wework 当前产品没有对应入口和数据消费链，因此 Region、跨 iframe
内部元素、多选文本范围不在本 PR 中伪造实现。如后续确认产品要开放这些入口，
应各自新增独立 E2E checkpoint 后再实现。

## 完成标准

- 旧注入脚本及其测试删除，代码只有一条标注主路径。
- 三个 checkpoint 均被 GitHub CI 调用。
- Core、Anchor、Design 的强断言通过，无 retry、skip 或弱化断言。
- 核心交互截图逐张目视检查，布局和操作密度与 ChatGPT 参考一致。
- `git diff --check` 通过，证据截图未进入 Git 索引。
- 拉取最新 `main`、解决冲突、push 并创建 PR；持续跟进 CI 和 review 问题。
