# Exam 组件开发经验

## 代码规范

- 使用 `styled-jsx global` 时需注意作用域，复杂样式建议单独 CSS 文件
- 组件 props 使用 memo 缓存，避免父组件频繁更新导致子组件重渲染

## 常见陷阱

### Markdown 渲染样式覆盖

- **问题**：`EnhancedMarkdown` 组件会给列表添加内联样式（如 `list-style-type: decimal`），覆盖自定义 CSS
- **解决**：使用 `ReactMarkdown` 配合自定义 `components` 属性，传入带 className 的组件
- **示例**：
  ```tsx
  const customComponents: Components = {
    ol: ({ children }) => <ol className="custom-ol">{children}</ol>,
  }
  ```

### Grid 布局中多段落排列

- **问题**：列表项内多个 `<p>` 元素在 Grid 布局中可能横向排列
- **解决**：使用 `grid-template-columns: auto 1fr` + `grid-column: 2` 让所有段落纵向堆叠
- **注意**：设置 `row-gap: 0` 消除段落间多余间距

### styled-jsx global 作用域

- **问题**：全局样式可能不生效或被其他样式覆盖
- **解决**：复杂组件样式使用单独 CSS 文件，通过 className 精确选择

## 有效模式

### 防止频繁重渲染

- 场景：父组件有定时器每秒更新状态
- 做法：
  1. 子组件用 `memo` 包裹
  2. 将 `customComponents` 定义在组件外部
  3. 父组件用 `useMemo` 缓存传递给子组件的数据
- 效果：只有数据真正变化时子组件才重新渲染

### 有序列表任务卡片样式

- 场景：考试题目任务列表（带数字圆圈）
- 做法：
  1. `counter-reset` / `counter-increment` 生成序号
  2. `::before` 伪元素显示红色圆圈数字
  3. Grid 布局：第一列序号，第二列内容
  4. `row-gap: 0` 确保段落紧贴，列表项间用 `margin-bottom` 控制间距
- 效果：与原型一致的视觉呈现

## 检查清单

- [ ] CSS 样式是否被内联样式覆盖？考虑使用单独 CSS 文件
- [ ] 组件是否会被父组件频繁更新影响？考虑使用 memo
- [ ] Markdown 自定义渲染是否正确应用 className？
- [ ] Grid 布局中多元素是否正确纵向排列？

---

最后更新：2026-03-18
