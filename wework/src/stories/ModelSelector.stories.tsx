import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ModelOptions, UnifiedModel } from '@wegent/chat-core/models'
import { ModelSelector } from '@wegent/collaboration/controls/ModelSelector'
import { createCollaborationTranslator } from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'

const meta = {
  title: 'Business/ModelSelector',
  component: ModelSelector,
  parameters: {
    docs: {
      description: {
        component:
          'Uses the production model catalog adapter and UI SDK popover, radio group and slider. The recovery entry remains visible for empty catalogs. / 生产模型选择器；空目录保留恢复入口。',
      },
    },
  },
} satisfies Meta<typeof ModelSelector>
export default meta
type Story = StoryObj<Record<string, never>>
const models: UnifiedModel[] = ['Standard', 'Advanced'].map(name => ({
  name,
  modelId: name,
  displayName: `Example ${name}`,
  type: 'runtime',
  provider: 'local',
  config: {
    weworkModelKind: 'codex-official',
    ui: {
      family: 'codex-official',
      reasoningEfforts: ['low', 'medium', 'high', 'ultra'],
      defaultReasoningEffort: 'medium',
    },
  },
}))
function Example({ empty = false, mobile = false }: { empty?: boolean; mobile?: boolean }) {
  const { i18n } = useTranslation()
  const t = createCollaborationTranslator(i18n.language === 'en' ? 'en' : 'zh-CN')
  const [model, setModel] = useState<UnifiedModel | null>(empty ? null : models[0])
  const [options, setOptions] = useState<ModelOptions>({ reasoning_effort: 'medium' })
  const [status, setStatus] = useState('')
  return (
    <div className="flex min-h-80 items-end gap-4">
      <ModelSelector
        translate={t}
        isMobile={mobile}
        models={empty ? [] : models}
        selectedModel={model}
        selectedModelOptions={options}
        disabled={false}
        onSelectModel={setModel}
        onSelectModelOption={(key, value) => setOptions(current => ({ ...current, [key]: value }))}
        onOpenModelSettings={() => setStatus('Settings entry selected')}
      />
      <output aria-live="polite">{status}</output>
    </div>
  )
}
export const Default: Story = { render: () => <Example /> }
export const Empty: Story = { render: () => <Example empty /> }
export const Mobile: Story = { render: () => <Example mobile /> }
