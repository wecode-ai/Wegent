import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { DeleteIconButton } from '@wegent/collaboration/controls/DeleteIconButton'

const meta = {
  title: 'Controls/DeleteIconButton',
  component: DeleteIconButton,
  args: { 'aria-label': '删除 / Delete' },
  parameters: {
    docs: {
      description: {
        component:
          'One deletion icon action for settings, lists, cards and toolbars. The component owns color, size, loading and disabled states; business callbacks stay with the caller. / 设置、列表、卡片与工具栏共用删除操作组件，统一颜色、尺寸、加载与禁用态。',
      },
    },
  },
} satisfies Meta<typeof DeleteIconButton>
export default meta
type Story = StoryObj<typeof meta>

export const StateMatrix: Story = {
  render: function Example() {
    const { t } = useTranslation('componentCatalog')
    const [count, setCount] = useState(0)
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-6">
          {[
            { key: 'normal', disabled: false, pending: false },
            { key: 'disabled', disabled: true, pending: false },
            { key: 'pending', disabled: false, pending: true },
          ].map(state => (
            <div key={state.key} className="flex items-center gap-2">
              <span>{t(state.key)}</span>
              <DeleteIconButton
                aria-label={t('remove')}
                data-testid={`catalog-delete-${state.key}`}
                disabled={state.disabled}
                pending={state.pending}
                onClick={() => setCount(previous => previous + 1)}
              />
            </div>
          ))}
          <DeleteIconButton
            aria-label={t('remove')}
            data-testid="catalog-delete-compact"
            density="compact"
            onClick={() => setCount(previous => previous + 1)}
          />
        </div>
        <output data-testid="catalog-delete-result">{count}</output>
      </div>
    )
  },
}
