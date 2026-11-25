import { TabsList, TabsRoot, TabsTab } from '../controls/Tabs'

export function IssueHomeModeTabs({
  id,
  taskMode,
  taskAvailable,
  disabled,
  onChange,
  translate: t,
}: {
  id: string
  taskMode: boolean
  taskAvailable: boolean
  disabled: boolean
  onChange(task: boolean): void
  translate(key: string): string
}) {
  return (
    <TabsRoot
      value={String(taskMode)}
      onValueChange={next => {
        if (next !== null) onChange(next === 'true')
      }}
      render={<div className="contents" />}
    >
      <TabsList aria-label={t('issue_creation.entry_mode')} className="flex items-center gap-5">
        {[false, ...(taskAvailable ? [true] : [])].map(mode => (
          <TabsTab
            value={String(mode)}
            key={String(mode)}
            type="button"
            id={`${id}-${mode ? 'task' : 'record'}-tab`}
            aria-controls={`${id}-${mode ? 'task' : 'record'}-panel`}
            data-testid={mode ? 'personal-home-new-issue' : 'personal-home-record-mode'}
            disabled={disabled}
            className={`min-h-11 border-b-2 pb-1 text-base transition-colors keyboard:focus-visible:rounded-sm keyboard:focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-[color-mix(in_srgb,rgb(var(--color-focus-ring))_80%,rgb(var(--color-text-primary))_20%)] md:min-h-8 ${taskMode === mode ? 'border-text-primary font-medium text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
          >
            {t(mode ? 'issue_creation.create_task' : 'issue_creation.record_mode')}
          </TabsTab>
        ))}
      </TabsList>
    </TabsRoot>
  )
}
