import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { RuntimePermissionMode } from '@wegent/chat-core/runtime-permission'
import { PermissionModeSelector } from '@wegent/collaboration/controls/PermissionModeSelector'
import { createCollaborationTranslator } from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'
const meta = {
  title: 'Business/PermissionModeSelector',
  component: PermissionModeSelector,
  parameters: {
    docs: {
      description: {
        component:
          'Selecting full access requires an explicit confirmation. The preview changes only local React state. / 完整访问必须明确确认；示例仅修改本地 React 状态。',
      },
    },
  },
} satisfies Meta<typeof PermissionModeSelector>
export default meta
type Story = StoryObj<Record<string, never>>
function Example({ disabled = false }: { disabled?: boolean }) {
  const { i18n } = useTranslation()
  const [value, setValue] = useState<RuntimePermissionMode>('read-only')
  return (
    <PermissionModeSelector
      translate={createCollaborationTranslator(i18n.language === 'en' ? 'en' : 'zh-CN')}
      value={value}
      onChange={setValue}
      disabled={disabled}
    />
  )
}
export const Default: Story = { render: () => <Example /> }
export const Disabled: Story = { render: () => <Example disabled /> }
