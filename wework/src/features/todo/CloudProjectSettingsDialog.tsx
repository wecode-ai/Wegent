import { useEffect, useState } from 'react'
import { CircleUserRound, Search, Trash2 } from 'lucide-react'
import type { CloudProject, CloudProjectMember, CloudUserSearchItem } from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { CloudTodoModal } from './CloudTodoModal'

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>

interface CloudProjectSettingsDialogProps {
  api: DeliveryApi
  project: CloudProject
  onClose: () => void
}

export function CloudProjectSettingsDialog({
  api,
  project,
  onClose,
}: CloudProjectSettingsDialogProps) {
  const [members, setMembers] = useState<CloudProjectMember[]>([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CloudUserSearchItem[]>([])
  const [role, setRole] = useState<CloudProjectMember['role']>('Developer')
  const [savingUserId, setSavingUserId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void api
      .listCloudProjectMembers(project.id)
      .then(value => active && setMembers(value))
      .catch(cause => active && setError(cause instanceof Error ? cause.message : '加载成员失败'))
    return () => {
      active = false
    }
  }, [api, project.id])

  useEffect(() => {
    let active = true
    const normalized = query.trim()
    if (!normalized) {
      return () => {
        active = false
      }
    }
    const timer = window.setTimeout(() => {
      void api
        .searchCloudProjectUsers(normalized)
        .then(response => {
          if (!active) return
          const existing = new Set(members.map(member => member.user_id))
          setResults(response.users.filter(user => !existing.has(user.id)))
        })
        .catch(cause => active && setError(cause instanceof Error ? cause.message : '搜索失败'))
    }, 250)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [api, members, query])
  const visibleResults = query.trim() ? results : []

  async function addMember(user: CloudUserSearchItem) {
    if (savingUserId !== null) return
    setSavingUserId(user.id)
    setError(null)
    try {
      const member = await api.addCloudProjectMember(project.id, user.id, role)
      setMembers(current => [...current, member])
      setResults(current => current.filter(result => result.id !== user.id))
      setQuery('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '添加成员失败')
    } finally {
      setSavingUserId(null)
    }
  }

  async function updateMember(
    member: CloudProjectMember,
    nextRole: Exclude<CloudProjectMember['role'], 'Owner'>
  ) {
    setError(null)
    try {
      const updated = await api.updateCloudProjectMember(project.id, member.user_id, nextRole)
      setMembers(current =>
        current.map(existing => (existing.user_id === updated.user_id ? updated : existing))
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '更新成员失败')
    }
  }

  async function removeMember(member: CloudProjectMember) {
    if (!window.confirm(`从项目中移除“${member.user_name}”？`)) return
    setError(null)
    try {
      await api.removeCloudProjectMember(project.id, member.user_id)
      setMembers(current => current.filter(existing => existing.user_id !== member.user_id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '移除成员失败')
    }
  }

  return (
    <CloudTodoModal title="项目成员" onClose={onClose}>
      <div className="max-h-[520px] overflow-y-auto p-5">
        <p className="text-sm font-medium">{project.name}</p>
        <p className="mt-1 text-xs text-text-muted">
          成员只能访问被授权的云项目、任务、共享文件和交付。
        </p>

        <div className="mt-5 space-y-1">
          {members.map(member => (
            <div
              key={member.user_id}
              className="flex h-11 items-center rounded-md px-2 hover:bg-hover"
              data-testid={`cloud-project-member-${member.user_id}`}
            >
              <CircleUserRound className="h-4 w-4 text-text-muted" />
              <span className="ml-3 min-w-0 flex-1">
                <span className="block truncate text-sm">{member.user_name}</span>
                <span className="block truncate text-xs text-text-muted">{member.email}</span>
              </span>
              {member.role === 'Owner' ? (
                <span className="text-xs text-text-muted">Owner</span>
              ) : (
                <>
                  <select
                    data-testid={`cloud-project-member-role-${member.user_id}`}
                    value={member.role}
                    onChange={event =>
                      void updateMember(
                        member,
                        event.target.value as Exclude<CloudProjectMember['role'], 'Owner'>
                      )
                    }
                    className="h-7 rounded-md border border-border bg-background px-1 text-xs outline-none"
                  >
                    <option value="Maintainer">Maintainer</option>
                    <option value="Developer">Developer</option>
                    <option value="Reporter">Reporter</option>
                  </select>
                  <button
                    type="button"
                    data-testid={`cloud-project-member-remove-${member.user_id}`}
                    onClick={() => void removeMember(member)}
                    className="ml-1 flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-destructive"
                    aria-label={`移除 ${member.user_name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>

        <div className="mt-6 border-t border-border pt-4">
          <p className="text-xs font-medium text-text-secondary">添加成员</p>
          <div className="mt-2 flex gap-2">
            <label className="flex h-9 min-w-0 flex-1 items-center rounded-md border border-border px-3 focus-within:border-focus">
              <Search className="h-4 w-4 text-text-muted" />
              <input
                data-testid="cloud-member-search"
                value={query}
                onChange={event => setQuery(event.target.value)}
                className="ml-2 min-w-0 flex-1 bg-transparent text-sm outline-none"
                placeholder="搜索用户名或邮箱"
              />
            </label>
            <select
              data-testid="cloud-member-role"
              value={role}
              onChange={event => setRole(event.target.value as CloudProjectMember['role'])}
              className="h-9 rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-focus"
            >
              <option value="Maintainer">Maintainer</option>
              <option value="Developer">Developer</option>
              <option value="Reporter">Reporter</option>
            </select>
          </div>
          {visibleResults.length > 0 && (
            <div className="mt-2 rounded-md border border-border p-1">
              {visibleResults.map(user => (
                <button
                  key={user.id}
                  type="button"
                  data-testid={`cloud-member-result-${user.id}`}
                  disabled={savingUserId !== null}
                  onClick={() => void addMember(user)}
                  className="flex h-10 w-full items-center rounded-md px-2 text-left hover:bg-hover disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{user.user_name}</span>
                    <span className="block truncate text-xs text-text-muted">{user.email}</span>
                  </span>
                  <span className="text-xs text-text-muted">
                    {savingUserId === user.id ? '添加中…' : '添加'}
                  </span>
                </button>
              ))}
            </div>
          )}
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </div>
      </div>
    </CloudTodoModal>
  )
}
