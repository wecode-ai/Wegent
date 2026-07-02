import { Package } from 'lucide-react'
import type { SlashCommand } from './composerAutocomplete'
import { groupedSlashCommands } from './composerAutocomplete'

interface SlashCommandMenuProps {
  commands: SlashCommand[]
  selectedIndex: number
  className: string
  title: string
  noResultsLabel: string
  loadingSkills: boolean
  skillLoadError: boolean
  skillGroupLabel: string
  skillLoadingLabel: string
  skillLoadErrorLabel: string
  skillRetryLabel: string
  onSelectCommand: (command: SlashCommand) => void
  onHighlightCommand: (index: number) => void
  onRetrySkills: () => void
}

export function SlashCommandMenu({
  commands,
  selectedIndex,
  className,
  title,
  noResultsLabel,
  loadingSkills,
  skillLoadError,
  skillGroupLabel,
  skillLoadingLabel,
  skillLoadErrorLabel,
  skillRetryLabel,
  onSelectCommand,
  onHighlightCommand,
  onRetrySkills,
}: SlashCommandMenuProps) {
  let commandIndex = 0

  return (
    <div
      data-testid="slash-command-menu"
      role="listbox"
      aria-label={title}
      className={[
        'absolute bottom-[calc(100%+0.5rem)] z-popover max-h-64 overflow-y-auto rounded-xl border border-border bg-background px-1.5 py-1.5 text-text-primary shadow-[0_12px_34px_rgba(0,0,0,0.12)]',
        className,
      ].join(' ')}
    >
      {commands.length === 0 && !loadingSkills && !skillLoadError ? (
        <div className="px-2.5 py-2 text-[13px] leading-[18px] text-text-muted">
          {noResultsLabel}
        </div>
      ) : (
        groupedSlashCommands(commands).map(group => (
          <div key={group.label ?? 'commands'}>
            {group.label && (
              <div className="px-2 pb-1 pt-1.5 text-xs font-normal leading-4 text-text-muted">
                {group.label}
              </div>
            )}
            {group.commands.map(command => {
              const index = commandIndex
              commandIndex += 1
              const enabled = command.enabled !== false
              const Icon = command.Icon

              return (
                <button
                  key={command.id}
                  type="button"
                  data-testid={`slash-command-option-${command.testId}`}
                  aria-selected={index === selectedIndex}
                  role="option"
                  disabled={!enabled}
                  aria-disabled={!enabled}
                  onMouseEnter={() => {
                    if (enabled) onHighlightCommand(index)
                  }}
                  onPointerEnter={() => {
                    if (enabled) onHighlightCommand(index)
                  }}
                  onClick={() => {
                    if (enabled) onSelectCommand(command)
                  }}
                  className={[
                    'flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent',
                    index === selectedIndex ? 'bg-muted' : '',
                  ].join(' ')}
                >
                  <Icon className="h-4 w-4 shrink-0 text-text-secondary" />
                  <span className="flex min-w-0 flex-1 items-baseline gap-2">
                    <span className="shrink-0 truncate text-[13px] font-medium leading-5 text-text-primary">
                      {command.title}
                    </span>
                    {command.description && (
                      <span className="min-w-0 truncate text-[13px] font-normal leading-5 text-text-muted">
                        {command.description}
                      </span>
                    )}
                  </span>
                  {command.metaLabel && (
                    <span className="shrink-0 text-xs leading-5 text-text-muted">
                      {command.metaLabel}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        ))
      )}
      {loadingSkills && (
        <div>
          <div className="px-2 pb-1 pt-1.5 text-xs font-normal leading-4 text-text-muted">
            {skillGroupLabel}
          </div>
          <div className="px-2.5 py-2 text-[13px] leading-[18px] text-text-muted">
            {skillLoadingLabel}
          </div>
        </div>
      )}
      {skillLoadError && (
        <div>
          <div className="px-2 pb-1 pt-1.5 text-xs font-normal leading-4 text-text-muted">
            {skillGroupLabel}
          </div>
          <button
            type="button"
            data-testid="slash-command-skill-load-error"
            className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[13px] leading-5 text-text-muted hover:bg-muted"
            onClick={onRetrySkills}
          >
            <Package className="h-4 w-4 shrink-0 text-text-secondary" />
            <span className="min-w-0 flex-1 truncate">{skillLoadErrorLabel}</span>
            <span className="shrink-0 text-xs font-medium leading-5 text-text-secondary">
              {skillRetryLabel}
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
