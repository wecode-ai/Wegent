import { Cpu } from 'lucide-react'
import { ActionMenu } from '@/components/common/ActionMenu'
import { useTranslation } from '@/hooks/useTranslation'
import type { LocalHarnessModelOption } from '@/features/local-harness/localHarnessModels'
import type { LocalHarnessId } from '@/lib/local-harness'

interface WorkbenchHarnessModelSelectorProps {
  harnessId: LocalHarnessId
  models: LocalHarnessModelOption[]
  selectedModel: LocalHarnessModelOption | null
  onModelChange: (model: LocalHarnessModelOption | null) => void
}

export function WorkbenchHarnessModelSelector({
  harnessId,
  models,
  selectedModel,
  onModelChange,
}: WorkbenchHarnessModelSelectorProps) {
  const { t } = useTranslation('common')
  const defaultLabel = t('workbench.harness_model_unspecified', '不指定模型')
  const optionLabel = (model: LocalHarnessModelOption) =>
    `${model.label} · ${t(`workbench.harness_model_source_${model.source}`)}`

  return (
    <ActionMenu
      ariaLabel={t('workbench.harness_model_selector', '选择编码工具模型')}
      testId="workbench-harness-model-selector"
      icon={Cpu}
      triggerLabel={
        <span
          className="max-w-48 truncate"
          title={selectedModel ? optionLabel(selectedModel) : defaultLabel}
        >
          {selectedModel ? optionLabel(selectedModel) : defaultLabel}
        </span>
      }
      placement="bottom-end"
      triggerClassName="flex h-8 max-w-56 items-center gap-1.5 rounded-lg px-2 text-sm text-text-secondary opacity-90 hover:bg-muted hover:text-text-primary hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
      items={[
        {
          label: defaultLabel,
          testId: `workbench-harness-model-option-${harnessId}-native`,
          onSelect: () => onModelChange(null),
        },
        ...models.map((model, index) => ({
          label: optionLabel(model),
          testId: `workbench-harness-model-option-${harnessId}-${index}`,
          onSelect: () => onModelChange(model),
        })),
      ]}
    />
  )
}
