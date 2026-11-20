import { Columns3 } from 'lucide-react'
import { SearchableSelect } from '../controls/SearchableSelect'

export function ProjectBoardGroupPicker({
  fields,
  value,
  onChange,
  testIdPrefix = 'dingtalk-board-group',
  searchPlaceholder = '搜索表格字段',
  chooseLabel = '选择分组字段',
  emptyLabel = '没有匹配字段',
}: {
  fields: { id: string; name: string; type?: string }[]
  value: string
  onChange(fieldId: string): void
  testIdPrefix?: string
  searchPlaceholder?: string
  chooseLabel?: string
  emptyLabel?: string
}) {
  const selected = fields.find(field => field.id === value)
  const recommended = (name: string) => (/状态|负责人|优先级|所属/.test(name) ? 0 : 1)
  const options = [...fields]
    .sort((left, right) => recommended(left.name) - recommended(right.name))
    .map(field => ({
      value: field.id,
      label: field.name,
      description: field.type,
      testId: `${testIdPrefix}-option-${field.id}`,
    }))
  return (
    <SearchableSelect
      value={value}
      options={options}
      onChange={onChange}
      testId={`${testIdPrefix}-by`}
      menuTestId={`${testIdPrefix}-menu`}
      searchTestId={`${testIdPrefix}-search`}
      accessibleLabel={chooseLabel}
      searchPlaceholder={searchPlaceholder}
      emptyLabel={emptyLabel}
      className="project-board-compact-action min-w-32"
      triggerContent={
        <>
          <Columns3 aria-hidden="true" className="project-board-action-icon h-4 w-4" />
          <span className="project-board-action-label max-w-32 truncate">
            {selected?.name ?? chooseLabel}
          </span>
        </>
      }
    />
  )
}
