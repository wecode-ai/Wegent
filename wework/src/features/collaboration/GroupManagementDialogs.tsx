import { useEffect, useRef, useState, type ReactNode } from 'react'
import { TemplateDialog } from '@wegent/collaboration/templates'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import type { ChatGroup, ChatGroupApi, ChatGroupMember } from '@/api/chatGroups'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { GroupMembersSettings } from './GroupMembersSettings'
import type { GroupSource } from './CollaborationGroupsSurface'

const fieldClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary focus-visible:ring-2 focus-visible:ring-focus'

export function CreateGroupOrThread({
  kind,
  sources,
  source,
  api,
  group,
  onClose,
  onCreated,
}: {
  kind: 'group' | 'thread'
  sources: GroupSource[]
  source?: GroupSource
  api: SharedWorkspaceApi | null
  group?: ChatGroup
  onClose(): void
  onCreated(source: GroupSource['store'], id: string): void
}) {
  const { t } = useTranslation('collaboration')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [store, setStore] = useState(
    source?.store ?? (sources.some(source => source.store === 'cloud') ? 'cloud' : 'local')
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <TemplateDialog
      title={t(kind === 'group' ? 'newGroup' : 'newThread')}
      description={t(kind === 'group' ? 'emptyHint' : 'threadDescription')}
      closeLabel={t('close')}
      onClose={onClose}
      busy={busy}
    >
      <form
        className="space-y-4"
        data-testid={`create-${kind}-dialog`}
        onSubmit={async event => {
          event.preventDefault()
          if (busy || !name.trim()) return
          setBusy(true)
          setError(null)
          try {
            if (kind === 'group') {
              const target = sources.find(source => source.store === store)
              if (!target) throw new Error(t('readOnly'))
              const result = await target.groups.create({ name: name.trim(), description })
              onCreated(store, result.group.id)
            } else {
              if (!api || !group || !source) throw new Error(t('readOnly'))
              const thread = await api.issues.create(group.id, {
                title: name.trim(),
                description,
              })
              onCreated(source.store, thread.id)
            }
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
          } finally {
            setBusy(false)
          }
        }}
      >
        <label className="block space-y-2 text-sm text-text-primary">
          <span>{t(kind === 'group' ? 'groupName' : 'threadTitle')}</span>
          <input
            autoFocus
            required
            maxLength={255}
            data-testid={`create-${kind}-name`}
            className={fieldClass}
            value={name}
            onChange={event => setName(event.target.value)}
          />
        </label>
        <label className="block space-y-2 text-sm text-text-primary">
          <span>{t(kind === 'group' ? 'groupDescription' : 'threadDescription')}</span>
          <textarea
            data-testid={`create-${kind}-description`}
            className={fieldClass}
            rows={3}
            value={description}
            onChange={event => setDescription(event.target.value)}
          />
        </label>
        {kind === 'group' && (
          <>
            <label className="block space-y-2 text-sm text-text-primary">
              <span>{t('storage')}</span>
              <select
                data-testid="create-group-store"
                className={fieldClass}
                value={store}
                onChange={event => setStore(event.target.value as GroupSource['store'])}
              >
                {sources.map(source => (
                  <option key={source.store} value={source.store}>
                    {t(source.store)}
                  </option>
                ))}
              </select>
            </label>
            {store === 'local' && <p className="text-xs text-text-muted">{t('localHint')}</p>}
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            data-testid="create-group-cancel"
            disabled={busy}
            onClick={onClose}
          >
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            data-testid={`create-${kind}-submit`}
            disabled={busy || !name.trim()}
          >
            {t('create')}
          </Button>
        </div>
      </form>
    </TemplateDialog>
  )
}

export function GroupSettings({
  group,
  members,
  groups,
  directory,
  shared,
  resources,
  onChanged,
}: {
  group: ChatGroup
  members: ChatGroupMember[]
  groups: ChatGroupApi
  directory: SharedWorkspaceApi['members']
  shared: boolean
  resources?: ReactNode
  onChanged(): void
}) {
  const { t } = useTranslation('collaboration')
  const [name, setName] = useState(group.name)
  const [description, setDescription] = useState(group.description)
  const previous = useRef(group)
  useEffect(() => {
    const source = previous.current
    setName(value => (value === source.name ? group.name : value))
    setDescription(value => (value === source.description ? group.description : value))
    previous.current = group
  }, [group])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const manage = group.role === 'Owner' || group.role === 'Maintainer'
  return (
    <div className="h-full overflow-y-auto p-6">
      <form
        className="max-w-xl space-y-5"
        onSubmit={async event => {
          event.preventDefault()
          if (!manage || busy) return
          setBusy(true)
          setError(null)
          try {
            await groups.update(group.id, {
              name,
              description,
              version: group.version,
              status: group.status,
            })
            onChanged()
          } catch (cause) {
            setError(String(cause))
          } finally {
            setBusy(false)
          }
        }}
      >
        <label className="block space-y-2 text-sm text-text-primary">
          <span>{t('groupName')}</span>
          <input
            data-testid="group-settings-name"
            className={fieldClass}
            required
            disabled={!manage}
            value={name}
            onChange={event => setName(event.target.value)}
          />
        </label>
        <label className="block space-y-2 text-sm text-text-primary">
          <span>{t('groupDescription')}</span>
          <textarea
            data-testid="group-settings-description"
            className={fieldClass}
            disabled={!manage}
            rows={3}
            value={description}
            onChange={event => setDescription(event.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {manage && (
          <Button
            data-testid="group-settings-save"
            type="submit"
            disabled={
              busy || !name.trim() || (name === group.name && description === group.description)
            }
          >
            {t('save')}
          </Button>
        )}
      </form>
      {resources && <div className="mt-8 max-w-4xl border-t border-border pt-6">{resources}</div>}
      <div className="mt-8 max-w-xl border-t border-border pt-6">
        <GroupMembersSettings
          group={group}
          members={members}
          groups={groups}
          directory={directory}
          shared={shared}
          onChanged={onChanged}
        />
      </div>
    </div>
  )
}
