import { Cpu } from 'lucide-react'
import { ActionMenu } from '@/components/common/ActionMenu'
import { useTranslation } from '@/hooks/useTranslation'
import type { LocalHarnessId } from '@/lib/local-harness'

interface WorkbenchHarnessModelSelectorProps {
  harnessId: LocalHarnessId
  models: string[]
  selectedModel: string | null
  onModelChange: (model: string | null) => void
}

export function WorkbenchHarnessModelSelector({
  harnessId,
  models,
  selectedModel,
  onModelChange,
}: WorkbenchHarnessModelSelectorProps) {
  const { t } = useTranslation('common')
  const defaultLabel = t('workbench.harness_model_default', '默认模型')

  return (
    <ActionMenu
      ariaLabel={t('workbench.harness_model_selector', '选择运行工具模型')}
      testId="workbench-harness-model-selector"
      icon={Cpu}
      triggerLabel={
        <span className="max-w-48 truncate" title={selectedModel ?? defaultLabel}>
          {selectedModel ?? defaultLabel}
        </span>
      }
      placement="bottom-end"
      triggerClassName="flex h-8 max-w-56 items-center gap-1.5 rounded-lg px-2 text-sm text-text-secondary opacity-90 hover:bg-muted hover:text-text-primary hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
      items={[
        {
          label: defaultLabel,
          testId: `workbench-harness-model-option-${harnessId}-default`,
          onSelect: () => onModelChange(null),
        },
        ...models.map((model, index) => ({
          label: model,
          testId: `workbench-harness-model-option-${harnessId}-${index}`,
          onSelect: () => onModelChange(model),
        })),
      ]}
    />
  )
}
