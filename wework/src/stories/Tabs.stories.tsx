import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { TabsRoot, TabsList, TabsTab, TabsPanel } from '@wegent/collaboration/controls'
import { useTranslation } from '@/hooks/useTranslation'
const meta = { title: 'Controls/Tabs', component: TabsRoot } satisfies Meta<typeof TabsRoot>
export default meta
type Story = StoryObj<Record<string, never>>
function Example({ disabled = false }) {
  const { t } = useTranslation('componentCatalog')
  const [value, setValue] = useState('person')
  return (
    <TabsRoot
      value={value}
      onValueChange={next => {
        if (next !== null) setValue(next)
      }}
      className="max-w-lg"
    >
      <TabsList aria-label={t('choose')}>
        <TabsTab value="person" data-testid="catalog-person-tab">
          {t('person')}
        </TabsTab>
        <TabsTab value="project" disabled={disabled} data-testid="catalog-project-tab">
          {t('project')}
        </TabsTab>
      </TabsList>
      <TabsPanel value="person" className="p-4">
        {t('person')}
      </TabsPanel>
      <TabsPanel value="project" className="p-4">
        {t('project')}
      </TabsPanel>
    </TabsRoot>
  )
}
export const Default: Story = { render: () => <Example /> }
export const Disabled: Story = { render: () => <Example disabled /> }
