import type { Meta, StoryObj } from '@storybook/react-vite'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { HoverCard } from '@/components/ui/hover-card'
import { KeyboardShortcut } from '@/components/common/KeyboardShortcut'
import { CompositedSpinner } from '@/components/common/CompositedSpinner'
import { BetaBadge } from '@/components/common/BetaBadge'

const meta = {
  title: 'Controls/Feedback',
  component: Tooltip,
  parameters: {
    docs: {
      description: {
        component:
          'Tooltip supplements a label; HoverCard previews richer content. Loading needs adjacent readable text. / 提示补充标签，悬浮卡展示补充内容，加载图标需要相邻状态文字。',
      },
    },
  },
} satisfies Meta<typeof Tooltip>
export default meta
type Story = StoryObj<Record<string, never>>
export const Hint: Story = {
  render: function Example() {
    const { t } = useTranslation('componentCatalog')
    return (
      <Tooltip label={t('tooltip')} testId="catalog-tooltip">
        <Button data-testid="catalog-tooltip-trigger">{t('title')}</Button>
      </Tooltip>
    )
  },
}
export const Preview: Story = {
  render: function Example() {
    const { t } = useTranslation('componentCatalog')
    return (
      <HoverCard
        testId="catalog-hover-card"
        openOnFocus
        content={<p className="p-4">{t('details')}</p>}
      >
        <Button data-testid="catalog-hover-trigger">{t('hover')}</Button>
      </HoverCard>
    )
  },
}
export const Loading: Story = {
  render: function Example() {
    const { t } = useTranslation('componentCatalog')
    return (
      <p role="status" className="flex items-center gap-2">
        <CompositedSpinner className="h-4 w-4" />
        {t('loading')}
      </p>
    )
  },
}
export const Metadata: Story = {
  render: function Example() {
    const { t } = useTranslation('componentCatalog')
    return (
      <div className="flex items-center gap-4">
        <span>{t('shortcut')}</span>
        <KeyboardShortcut value="Command+Shift+Enter" />
        <BetaBadge testId="catalog-beta" />
      </div>
    )
  },
}
