import { Loader2, Plus, RefreshCw, Upload } from 'lucide-react'
import { useState } from 'react'
import { SettingsGroup, SettingsPage, SettingsPageHeader } from '@/components/settings/settings-ui'
import { useTranslation } from '@/hooks/useTranslation'
import { openNativeDirectoryPicker } from '@/lib/native-directory-picker'
import { revealLocalFile } from '@/lib/local-terminal'
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
            <button
              data-testid="hooks-import-button"
              className="inline-flex h-8 items-center gap-2 rounded-full bg-muted px-3 text-sm"
              onClick={() =>
                void openNativeDirectoryPicker().then(async path => {
                  if (path) await settings.install(path)
                })
              }
            >
              <Upload className="h-4 w-4" />
              {t('import')}
            </button>
            <button
              data-testid="hooks-add-button"
              className="inline-flex h-8 items-center gap-2 rounded-full bg-text-primary px-3 text-sm text-background"
              onClick={() => setEditing(null)}
            >
              <Plus className="h-4 w-4" />
              {t('add')}
            </button>
          </>
        }
      />
      {settings.loading ? (
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('loading')}
        </div>
      ) : settings.error ? (
        <div className="rounded-lg bg-red-500/10 p-3 text-sm text-red-500">
          {settings.error}
          <button className="ml-3" onClick={() => void settings.reload()}>
            <RefreshCw className="inline h-4 w-4" />
          </button>
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
