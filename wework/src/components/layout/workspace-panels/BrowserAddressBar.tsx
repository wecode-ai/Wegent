import { useTranslation } from '@/hooks/useTranslation'
import { browserAddressAction } from '@/lib/browser-url'
import { searchEmbeddedBrowserHistory } from '@/lib/embedded-browser-history'
import { cn } from '@/lib/utils'
import { useAsyncOptions } from '@ui-sdk/react/async-options'
import {
  Autocomplete,
  AutocompleteContent,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
} from '@ui-sdk/react/autocomplete'
import {
  controlFieldAppearance,
  controlFieldDensity,
  controlInput,
  controlOption,
  controlPopup,
} from '@wegent/collaboration/controls/recipes'
import { useCollaborationPortalTheme } from '@wegent/collaboration/theme'
import { ArrowUpRight, Globe, Search } from 'lucide-react'
import { useRef, useState, type Ref } from 'react'

interface BrowserAddressBarProps {
  active: boolean
  address: string
  historyAvailable: boolean
  inputRef: Ref<HTMLInputElement>
  onChange: (address: string) => void
  onFocus: () => void
  onBlur: () => void
  onNavigate: (address: string) => void
}

export function BrowserAddressBar({
  active,
  address,
  historyAvailable,
  inputRef,
  onChange,
  onFocus,
  onBlur,
  onNavigate,
}: BrowserAddressBarProps) {
  const { t } = useTranslation('common')
  const theme = useCollaborationPortalTheme()
  const [open, setOpen] = useState(false)
  const selectedUrl = useRef<string | null>(null)
  const history = useAsyncOptions(
    text => searchEmbeddedBrowserHistory(text, { maxResults: 8, distinctUrls: true }),
    { minLength: 1, debounce: 150 }
  )
  const query = address.trim()
  const action = browserAddressAction(query)
  const entries =
    historyAvailable && history.query === query && history.status === 'idle' ? history.items : []
  const ActionIcon = action.kind === 'search' ? Search : ArrowUpRight

  function submit(text: string) {
    const url = selectedUrl.current ?? browserAddressAction(text).url
    selectedUrl.current = null
    setOpen(false)
    onNavigate(url)
  }

  return (
    <form
      className="min-w-0 flex-1"
      onSubmit={event => {
        event.preventDefault()
        const input = event.currentTarget.elements.namedItem('url')
        submit(input instanceof HTMLInputElement ? input.value : address)
      }}
    >
      <Autocomplete
        name="url"
        value={address}
        open={active && open && Boolean(query)}
        filter={false}
        autoHighlight
        submitOnSelect
        onValueChange={(text, { reason, item }) => {
          selectedUrl.current = item?.value ?? null
          onChange(text)
          if (historyAvailable && reason === 'input-change') history.setQuery(text.trim())
        }}
        onOpenChange={(next, { reason }) => {
          setOpen(next)
          if (!next) history.setQuery('')
          else if (historyAvailable && reason !== 'input-change') history.setQuery(query)
        }}
        onSubmit={(text, { event }) => {
          event?.preventDefault()
          submit(text)
        }}
      >
        <AutocompleteInput
          ref={inputRef}
          data-testid="workspace-browser-url-input"
          aria-label={t('workbench.browser_url_placeholder')}
          placeholder={t('workbench.browser_url_placeholder')}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onFocus={onFocus}
          onBlur={event => {
            // Window deactivation can emit blur while this field retains DOM focus.
            if (event.currentTarget.ownerDocument.activeElement !== event.currentTarget) onBlur()
          }}
          className={cn(
            controlInput,
            controlFieldAppearance.plain,
            controlFieldDensity.compact,
            'w-full transition-colors placeholder:text-text-muted focus:bg-muted keyboard:focus-visible:ring-0 [@media(forced-colors:none)]:focus-visible:outline-transparent'
          )}
        />
        <AutocompleteContent
          {...theme}
          data-testid="workspace-browser-address-suggestions"
          data-embedded-browser-occlusion
          sideOffset={4}
          collisionPadding={8}
          className={cn(theme.className, controlPopup, 'w-[var(--anchor-width)]')}
        >
          <AutocompleteList>
            <AutocompleteItem
              data-testid="workspace-browser-address-submit"
              value={action.url}
              label={action.url}
              className={controlOption}
            >
              <ActionIcon className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{query}</span>
              <span className="shrink-0 text-xs text-text-secondary">
                {t(
                  action.kind === 'search'
                    ? 'workbench.browser_search_web'
                    : 'workbench.browser_visit_address'
                )}
              </span>
            </AutocompleteItem>
            {entries
              .filter(entry => entry.url !== action.url)
              .map(entry => (
                <AutocompleteItem
                  key={entry.url}
                  data-testid="workspace-browser-address-history-option"
                  data-url={entry.url}
                  value={entry.url}
                  label={entry.url}
                  title={entry.url}
                  className={controlOption}
                >
                  <Globe className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
                  {entry.title && <span className="max-w-[55%] truncate">{entry.title}</span>}
                  <span className={cn('min-w-0 truncate', entry.title && 'text-text-secondary')}>
                    {entry.url}
                  </span>
                </AutocompleteItem>
              ))}
            {action.alternateHostUrl &&
              !entries.some(entry => entry.url === action.alternateHostUrl) && (
                <AutocompleteItem
                  data-testid="workspace-browser-address-host-option"
                  value={action.alternateHostUrl}
                  label={action.alternateHostUrl}
                  className={controlOption}
                >
                  <ArrowUpRight
                    className="h-4 w-4 shrink-0 text-text-secondary"
                    aria-hidden="true"
                  />
                  <span className="truncate">{action.alternateHostUrl}</span>
                </AutocompleteItem>
              )}
          </AutocompleteList>
        </AutocompleteContent>
      </Autocomplete>
    </form>
  )
}
