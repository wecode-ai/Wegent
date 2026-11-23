import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Resizable, ResizablePanel, ResizableHandle } from '@wegent/collaboration/controls'
import { useTranslation } from '@/hooks/useTranslation'

const meta = { title: 'Controls/Resizable', component: Resizable } satisfies Meta<typeof Resizable>
export default meta
type Story = StoryObj<Record<string, never>>

function Example({ vertical = false, disabled = false, controlled = false }) {
  const { t } = useTranslation('componentCatalog')
  const [layout, setLayout] = useState([35, 65])
  const [savedLayout, setSavedLayout] = useState([35, 65])
  return (
    <div className="max-w-2xl space-y-3">
      <Resizable
        orientation={vertical ? 'vertical' : 'horizontal'}
        disabled={disabled}
        defaultLayout={controlled ? undefined : [35, 65]}
        layout={controlled ? layout : undefined}
        onLayoutChange={controlled ? setLayout : undefined}
        onLayoutCommit={next => setSavedLayout([...next])}
        className="h-64 overflow-hidden rounded-lg border border-border"
        data-testid="catalog-resizable"
      >
        <ResizablePanel minSize={20} className="overflow-auto p-4">
          {t('tree')}
        </ResizablePanel>
        <ResizableHandle aria-label={t('resizePanels')} data-testid="catalog-resizable-handle" />
        <ResizablePanel minSize={30} className="overflow-auto p-4">
          {t('description')}
        </ResizablePanel>
      </Resizable>
      {controlled && (
        <output data-testid="catalog-resizable-saved">
          {t('savedLayout')}: {savedLayout.map(size => size.toFixed(1)).join(' / ')}
        </output>
      )}
    </div>
  )
}
export const Horizontal: Story = { render: () => <Example /> }
export const Vertical: Story = { render: () => <Example vertical /> }
export const Disabled: Story = { render: () => <Example disabled /> }
export const ControlledCommit: Story = { render: () => <Example controlled /> }
