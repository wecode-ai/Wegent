import { Listbox, ListboxItem } from '@ui-sdk/react/listbox'
import { controlOption } from '../controls/recipes'
import { Package } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button as ControlButton } from '../markdown/Button'
import type { SlashCommand } from './composerAutocomplete'
import { groupedSlashCommands } from './composerAutocomplete'

export interface SlashCommandMenuProps<T extends SlashCommand> {
  renderAppIcon(command: T): ReactNode
  commands: T[]
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
  onSelectCommand: (command: T) => void
  onHighlightCommand: (index: number) => void
  onRetrySkills: () => void
}

export function SlashCommandMenu<T extends SlashCommand>({
  renderAppIcon,
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
}: SlashCommandMenuProps<T>) {
  const groups = groupedSlashCommands(commands)

  return (
    <div
      onPointerDownCapture={event => event.preventDefault()}
      data-testid="slash-command-menu"
      aria-label={title}
      className={['max-h-64 overflow-y-auto', className].join(' ')}
    >
      {commands.length === 0 && !loadingSkills && !skillLoadError ? (
        <div className="px-2.5 py-2 text-sm leading-[18px] text-text-muted">{noResultsLabel}</div>
      ) : (
        <Listbox
          aria-label={title}
          value={String(selectedIndex)}
          onValueChange={next => {
            if (next !== null) onHighlightCommand(Number(next))
          }}
          onMouseDown={event => event.preventDefault()}
        >
          {groups.map((group, groupIndex) => (
            <div key={group.label ?? 'commands'}>
              {group.label && (
                <div className="px-2 pb-1 pt-1.5 text-xs font-normal leading-4 text-text-muted">
                  {group.label}
                </div>
              )}
              {group.commands.map((command, itemIndex) => {
                const index =
                  groups
                    .slice(0, groupIndex)
                    .reduce((count, previous) => count + previous.commands.length, 0) + itemIndex
                const enabled = command.enabled !== false
                const Icon = command.Icon
                const TrailingIcon = command.trailingIcon

                return (
                  <ListboxItem
                    key={command.id}
                    render={<button type="button" disabled={!enabled} />}
                    value={String(index)}
                    data-testid={`slash-command-option-${command.testId}`}
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
                    className={[controlOption, index === selectedIndex ? 'bg-muted' : ''].join(' ')}
                  >
                    {command.app ? (
                      renderAppIcon(command)
                    ) : command.iconUrl ? (
                      <span
                        className={[
                          'plugin-icon-slot h-6 w-6 rounded-md',
                          command.iconContrastPad ? 'plugin-icon-slot--contrast-pad' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        <img src={command.iconUrl} alt="" />
                      </span>
                    ) : (
                      <Icon className="h-4 w-4 shrink-0 text-text-secondary" />
                    )}
                    <span className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
                      <span className="max-w-full shrink-0 truncate text-sm font-normal leading-5 text-text-primary">
                        {command.title}
                      </span>
                      {command.description && (
                        <span className="min-w-0 truncate text-sm font-normal leading-5 text-text-muted">
                          {command.description}
                        </span>
                      )}
                    </span>
                    {command.metaLabel && (
                      <span className="shrink-0 text-xs leading-5 text-text-muted">
                        {command.metaLabel}
                      </span>
                    )}
                    {TrailingIcon && <TrailingIcon className="h-4 w-4 shrink-0 text-text-muted" />}
                  </ListboxItem>
                )
              })}
            </div>
          ))}
        </Listbox>
      )}
      {loadingSkills && (
        <div>
          <div className="px-2 pb-1 pt-1.5 text-xs font-normal leading-4 text-text-muted">
            {skillGroupLabel}
          </div>
          <div className="px-2.5 py-2 text-sm leading-[18px] text-text-muted">
            {skillLoadingLabel}
          </div>
        </div>
      )}
      {skillLoadError && (
        <div>
          <div className="px-2 pb-1 pt-1.5 text-xs font-normal leading-4 text-text-muted">
            {skillGroupLabel}
          </div>
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="slash-command-skill-load-error"
            className="flex h-8 max-md:min-h-11 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm leading-5 text-text-muted hover:bg-muted"
            onClick={onRetrySkills}
          >
            <Package className="h-4 w-4 shrink-0 text-text-secondary" />
            <span className="min-w-0 flex-1 truncate">{skillLoadErrorLabel}</span>
            <span className="shrink-0 text-xs font-medium leading-5 text-text-secondary">
              {skillRetryLabel}
            </span>
          </ControlButton>
        </div>
      )}
    </div>
  )
}
