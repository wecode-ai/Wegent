import { SettingsGroup, SettingsPage, SettingsPageHeader } from '@/components/settings/settings-ui'
import { useTranslation } from '@/hooks/useTranslation'
import { revealLocalFile } from '@/lib/local-terminal'
import { openNativeDirectoryPicker } from '@/lib/native-directory-picker'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Loader2, Plus, RefreshCw, Upload } from 'lucide-react'
import { useState } from 'react'
import { HookEditorDialog } from './HookEditorDialog'
import { HookListItem } from './HookListItem'
import type { ResolvedHookPlugin } from './hooksTypes'
import { useHooksSettings } from './useHooksSettings'

export function HooksSettingsPage() {
  const { t } = useTranslation('hooks')
  const settings = useHooksSettings()
  const [editing, setEditing] = useState<ResolvedHookPlugin | null | undefined>(undefined)
  return (
    <SettingsPage data-testid="hooks-settings-page">
      <SettingsPageHeader
        title={t('title')}
        description={t('subtitle')}
        actions={
          <>
            <ControlButton
              variant="secondary"
              size="sm"
              type="button"
              data-testid="hooks-import-button"
              onClick={() =>
                void openNativeDirectoryPicker().then(async path => {
                  if (path) await settings.install(path)
                })
              }
            >
              <Upload className="h-4 w-4" />
              {t('import')}
            </ControlButton>
            <ControlButton
              variant="primary"
              size="sm"
              type="button"
              data-testid="hooks-add-button"
              onClick={() => setEditing(null)}
            >
              <Plus className="h-4 w-4" />
              {t('add')}
            </ControlButton>
          </>
        }
      />
      {settings.loading ? (
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('loading')}
        </div>
      ) : settings.error ? (
        <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive wework:bg-red-500/10 wework:text-red-500">
          {settings.error}
          <ControlButton
            variant="unstyled"
            type="button"
            className="ml-3"
            aria-label={t('retry', '重试')}
            onClick={() => void settings.reload()}
          >
            <RefreshCw className="inline h-4 w-4" />
          </ControlButton>
        </div>
      ) : settings.data.length === 0 ? (
        <div className="py-12 text-center text-sm text-text-secondary">{t('empty')}</div>
      ) : (
        <SettingsGroup>
          {settings.data.map(plugin => (
            <HookListItem
              key={plugin.manifest.id}
              plugin={plugin}
              onEnabled={enabled => settings.setEnabled(plugin.manifest.id, enabled)}
              onEdit={() => setEditing(plugin)}
              onDelete={() => settings.remove(plugin.manifest.id)}
              onReveal={async () => revealLocalFile(await settings.reveal(plugin.manifest.id))}
              onTest={handler => settings.test(plugin.manifest.id, handler)}
            />
          ))}
        </SettingsGroup>
      )}
      {editing !== undefined && (
        <HookEditorDialog
          plugin={editing ?? undefined}
          onClose={() => setEditing(undefined)}
          onSave={draft =>
            editing ? settings.update(editing.manifest.id, draft) : settings.create(draft)
          }
        />
      )}
    </SettingsPage>
  )
}
