import type { LucideIcon } from 'lucide-react'
import { SearchableSelect } from '../controls/SearchableSelect'
import type { CollaborationTranslate } from '../i18n'
import type { TargetKind } from './automaticProcessing'

export function AutomaticProcessingTargetPicker({
  kind,
  kindLabel,
  icon: Icon,
  options,
  selectedId,
  onSelect,
  translate,
}: {
  kind: TargetKind
  kindLabel: string
  icon: LucideIcon
  options: { id: string; name: string }[]
  selectedId: string
  onSelect(id: string): void
  translate: CollaborationTranslate
}) {
  const selectedName =
    options.find(option => option.id === selectedId)?.name ?? translate('common.select', '请选择')
  return (
    <SearchableSelect
      value={selectedId}
      onChange={onSelect}
      testId="automatic-processing-target"
      menuTestId="automatic-processing-target-picker"
      searchTestId="automatic-processing-target-search"
      accessibleLabel={kindLabel}
      searchPlaceholder={translate('todo.search_processing_target', '搜索处理对象')}
      emptyLabel={translate('todo.no_matching_processing_target', '没有匹配的处理对象')}
      className="w-full py-2"
      triggerContent={
        <>
          <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate">{selectedName}</span>
            <span className="block text-xs text-text-secondary">{kindLabel}</span>
          </span>
        </>
      }
      options={options.map(option => ({
        value: option.id,
        label: option.name,
        testId: `automatic-processing-target-option-${kind}-${option.id}`,
        icon: <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />,
      }))}
    />
  )
}
