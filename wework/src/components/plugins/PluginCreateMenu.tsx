import { ActionMenu } from '@/components/common/ActionMenu'
import { useTranslation } from '@/hooks/useTranslation'
import { Circle, Plug, Plus, Upload } from 'lucide-react'

export function PluginCreateMenu({
  isOpen,
  onOpenChange,
  onCreatePlugin,
  onImportPlugin,
  onAddMarket,
  onRecordSkill,
  buttonTestId = 'plugins-create-button',
  compact = false,
}: {
  isOpen: boolean
  onOpenChange(open: boolean): void
  onCreatePlugin?(): void
  onImportPlugin?(): void
  onAddMarket?(): void
  onRecordSkill?(): void
  buttonTestId?: string
  compact?: boolean
}) {
  const { t } = useTranslation('common')
  const options = [
    [
      onCreatePlugin,
      Plug,
      'plugins-create-plugin-option',
      t('workbench.plugins_create_plugin', '创建插件'),
    ],
    [
      onImportPlugin,
      Upload,
      'plugins-import-plugin-option',
      t('workbench.plugins_import_plugin', '导入插件'),
    ],
    [
      onAddMarket,
      Plus,
      'plugins-add-market-option',
      t('workbench.plugins_add_market', '添加插件市场'),
    ],
    [
      onRecordSkill,
      Circle,
      'plugins-record-skill-option',
      t('workbench.plugins_record_skill', '录制技能'),
    ],
  ] as const
  return (
    <ActionMenu
      open={isOpen}
      onOpenChange={onOpenChange}
      testId={buttonTestId}
      menuTestId="plugins-create-menu"
      ariaLabel={t('workbench.plugins_create', '创建')}
      triggerLabel={compact ? undefined : t('workbench.plugins_create', '创建')}
      icon={Plus}
      items={options.flatMap(([action, icon, testId, label]) =>
        action
          ? [
              {
                icon,
                testId,
                label,
                onSelect: action,
              },
            ]
          : []
      )}
    />
  )
}
