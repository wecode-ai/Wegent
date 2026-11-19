import {
  CollapsibleRoot,
  CollapsibleTrigger,
  CollapsiblePanel,
} from '@wegent/collaboration/controls/Collapsible'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { TaskDescriptionEditor } from '@/features/todo/TaskDescriptionEditor'

const description = `## 任务描述

选中文字查看格式工具栏；输入 / 插入块；输入 : 后继续键入 emoji 名称。

[项目文档](https://example.com/project)

- 保留中文输入法的组合输入
- 点击块旁边的拖动手柄，打开颜色菜单

| 工作项 | 状态 |
| --- | --- |
| 组件统一 | 进行中 |
| 交互验证 | 待检查 |`

const meta = {
  title: 'Business/TaskDescriptionEditor',
  component: TaskDescriptionEditor,
  parameters: {
    docs: {
      description: {
        component:
          '真实 BlockNote 编辑器，普通 UI 由 UI SDK 组件与弹层行为提供。支持选区格式、链接编辑、斜杠、emoji、块菜单、文件面板和表格操作。',
      },
    },
  },
} satisfies Meta<typeof TaskDescriptionEditor>
export default meta
type Story = StoryObj<Record<string, never>>

function Example({
  disabled = false,
  initialValue = description,
}: {
  disabled?: boolean
  initialValue?: string
}) {
  const [value, setValue] = useState(initialValue)
  return (
    <div className="max-w-3xl space-y-4">
      <TaskDescriptionEditor
        value={value}
        onChange={setValue}
        disabled={disabled}
        testId="storybook-task-description"
        ariaLabel="任务描述"
        className="min-h-72"
      />
      <CollapsibleRoot>
        <CollapsibleTrigger data-testid="catalog-editor-markdown-toggle">
          Markdown
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <pre
            className="whitespace-pre-wrap text-xs"
            data-testid="storybook-task-description-markdown"
          >
            {value}
          </pre>
        </CollapsiblePanel>
      </CollapsibleRoot>
    </div>
  )
}

export const Editable: Story = { render: () => <Example /> }
export const Empty: Story = { render: () => <Example initialValue="" /> }
export const ReadOnly: Story = { render: () => <Example disabled /> }
