import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { VirtualTree } from '@wegent/collaboration/controls'
import { useTranslation } from '@/hooks/useTranslation'
const meta = { title: 'Controls/VirtualTree', component: VirtualTree } satisfies Meta<
  typeof VirtualTree
>
export default meta
type Story = StoryObj<Record<string, never>>
function Example({ empty = false, disabled = false, large = false, reveal = false }) {
  const { t } = useTranslation('componentCatalog')
  const [value, onValueChange] = useState<string | null>(null)
  const [expanded, onExpandedChange] = useState(['src'])
  const count = large ? 1000 : 6
  const items = empty
    ? []
    : [
        {
          value: 'src',
          label: 'src',
          children: Array.from({ length: count }, (_, i) => ({
            value: 'src/file-' + i,
            label: 'component-' + i + '.tsx',
            disabled: i === 2,
          })),
        },
        { value: 'docs', label: 'docs', children: [{ value: 'docs/readme', label: 'README.md' }] },
      ]
  return (
    <div className="max-w-lg space-y-3">
      <VirtualTree
        items={items}
        value={value}
        onValueChange={onValueChange}
        expanded={expanded}
        onExpandedChange={onExpandedChange}
        disabled={disabled}
        aria-label={t('tree')}
        data-testid="catalog-tree"
        viewportClassName="h-64 rounded-lg border border-border"
        scrollToValue={reveal ? 'src/file-900' : undefined}
        scrollAlign="center"
        rowHeight={44}
      />
      {empty && <p role="status">{t('empty')}</p>}
      <output>{value}</output>
    </div>
  )
}
export const Default: Story = { render: () => <Example /> }
export const Empty: Story = { render: () => <Example empty /> }
export const Disabled: Story = { render: () => <Example disabled /> }
export const ThousandItems: Story = { render: () => <Example large /> }
export const RevealDistantItem: Story = { render: () => <Example large reveal /> }
