import { SelectContent, SelectItem, SelectRoot, SelectTrigger } from '../controls/SelectParts'
import { ProjectViewLabel } from './ProjectViewLabel'
import type {
  CollaborationProjectView,
  CollaborationProjectViewOption,
} from './projectViewNavigation'

export function ProjectViewMenu<View extends CollaborationProjectView>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: CollaborationProjectViewOption<View>[]
  value: View
  onChange(view: View): void
}) {
  return (
    <SelectRoot
      value={value}
      onValueChange={next => {
        if (next) onChange(next)
      }}
    >
      <SelectTrigger data-testid="collaboration-compact-trigger" aria-label={label}>
        {label}
      </SelectTrigger>
      <SelectContent data-testid="collaboration-compact-menu" data-embedded-browser-occlusion>
        {options.map(option => (
          <SelectItem
            key={option.id}
            value={option.id}
            label={option.label}
            data-testid={option.testId}
            aria-current={option.id === value ? 'page' : undefined}
          >
            <ProjectViewLabel option={option} selected={option.id === value} />
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  )
}
