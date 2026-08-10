import { Bot, SquareTerminal } from 'lucide-react'
import { ActionMenu } from '@/components/common/ActionMenu'
import { ExperimentalBadge } from '@/features/experimental-features/ExperimentalBadge'
import { useTranslation } from '@/hooks/useTranslation'
import { localHarnessLabel, type LocalHarnessId } from '@/lib/local-harness'
import type { LocalHarnessDescriptor } from '@/lib/local-terminal'

interface WorkbenchHarnessSelectorProps {
  runtime: 'codex' | LocalHarnessId
  harnesses: LocalHarnessDescriptor[]
  enabledHarnesses: LocalHarnessId[]
  loading: boolean
  detectionFailed: boolean
  onRefresh: () => void
  onRuntimeChange: (runtime: 'codex' | LocalHarnessId) => void
}

export function WorkbenchHarnessSelector({
  runtime,
  harnesses,
  enabledHarnesses,
  loading,
  detectionFailed,
  onRefresh,
  onRuntimeChange,
}: WorkbenchHarnessSelectorProps) {
  const { t } = useTranslation('common')
  const selectedLabel = runtime === 'codex' ? 'Codex' : localHarnessLabel(runtime)

  return (
    <ActionMenu
      ariaLabel={t('workbench.harness_selector', '选择运行工具')}
      testId="workbench-harness-selector"
      icon={runtime === 'codex' ? Bot : SquareTerminal}
      triggerLabel={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="max-w-40 truncate">{selectedLabel}</span>
          {runtime !== 'codex' && (
            <ExperimentalBadge testId="workbench-harness-experimental-badge" />
          )}
        </span>
      }
      placement="bottom-end"
      onOpenChange={open => {
        if (open) onRefresh()
      }}
      triggerClassName="flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm text-text-secondary hover:bg-background/70 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
      items={[
        {
          label: 'Codex',
          icon: Bot,
          testId: 'workbench-harness-option-codex',
          onSelect: () => onRuntimeChange('codex'),
        },
        ...enabledHarnesses.map(harnessId => {
          const label = localHarnessLabel(harnessId)
          const installed = harnesses.some(harness => harness.id === harnessId && harness.installed)
          return {
            label: (
              <>
                <span className="min-w-0 flex-1 truncate">
                  {loading
                    ? t('workbench.harness_detecting', {
                        name: label,
                        defaultValue: `正在检测 ${label}`,
                      })
                    : detectionFailed
                      ? t('workbench.harness_detection_failed', {
                          name: label,
                          defaultValue: `${label}（检测失败）`,
                        })
                      : installed
                        ? label
                        : t('workbench.harness_unavailable', {
                            name: label,
                            defaultValue: `${label}（未安装）`,
                          })}
                </span>
                <ExperimentalBadge testId={`workbench-harness-option-${harnessId}-badge`} />
              </>
            ),
            icon: SquareTerminal,
            testId: `workbench-harness-option-${harnessId}`,
            disabled: loading || detectionFailed || !installed,
            onSelect: () => onRuntimeChange(harnessId),
          }
        }),
      ]}
    />
  )
}
