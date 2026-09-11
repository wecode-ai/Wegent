import { Check, GitBranch, LockKeyhole, Pencil, Search, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AITableApi } from '@/api/aitable'
import type { DwsApi, DwsAuthStatus } from '@/api/dws'
import type {
  CloudLoopItem,
  CloudProject,
  CloudProjectMember,
  CloudUserSearchItem,
} from '@/api/deliveries'
import { ActionMenu } from '@/components/common/ActionMenu'
import { Tooltip } from '@/components/ui/tooltip'
import { createWeworkDeliverySharedWorkspaceApi } from '@/features/collaboration/weworkSharedWorkspaceApi'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { track } from '@/telemetry/client'
import type {
  ProjectManageApi,
  ProjectManageExtensionContext,
  ProjectManageHost,
  SharedProjectManageWorkspaceApi,
} from '@wegent/collaboration/project-manage'
import {
  ProjectManageView,
  createSharedWorkspaceProjectManageApi,
} from '@wegent/collaboration/project-manage'
import type { BoardCardDisplaySettings } from './CloudTodoBoardCard'
import { waitForDwsAuthentication } from './dwsAuth'
import { parseDingTalkAITableLink } from './projectProviderConfig'

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>
type CloudManageWorkspaceApi = SharedProjectManageWorkspaceApi

function configText(project: CloudProject, key: string): string {
  const value = (project.provider_config as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

function AITableProviderSettings({
  aitableApi,
  dwsApi,
  project,
  updateProject,
  reportError,
}: {
  aitableApi?: AITableApi
  dwsApi?: DwsApi
  project: CloudProject
  updateProject: ProjectManageExtensionContext<CloudProject>['updateProject']
  reportError: ProjectManageExtensionContext<CloudProject>['reportError']
}) {
  const [aitableUrl, setAITableUrl] = useState(() => configText(project, 'source_url'))
  const [dwsStatus, setDwsStatus] = useState<DwsAuthStatus | null>(null)
  const [aitableBusy, setAITableBusy] = useState(false)
  const [aitableSaved, setAITableSaved] = useState(false)
  const aitableLink = parseDingTalkAITableLink(aitableUrl)

  useEffect(() => {
    if (!aitableApi) return
    void aitableApi.configureProject(project).catch(cause => reportError(cause, '加载字段失败'))
  }, [aitableApi, project, reportError])

  useEffect(() => {
    if (!dwsApi) return
    void dwsApi
      .authStatus()
      .then(setDwsStatus)
      .catch(() => setDwsStatus(null))
  }, [dwsApi])

  async function saveAITable() {
    if (!aitableLink || aitableBusy) return
    setAITableBusy(true)
    setAITableSaved(false)
    try {
      await updateProject({
        provider_config: {
          base_id: aitableLink.baseId,
          table_id: aitableLink.tableId,
          source_url: aitableLink.url,
          ...(aitableLink.viewId ? { view_id: aitableLink.viewId } : {}),
        },
      })
      setAITableSaved(true)
    } catch (cause) {
      reportError(cause, '保存钉钉多维表格配置失败')
    } finally {
      setAITableBusy(false)
    }
  }

  return (
    <section className="border-t border-border py-6" data-testid="aitable-provider-settings">
      <h2 className="text-heading-md font-semibold">钉钉多维表格</h2>
      <p className="mt-1 text-sm text-text-muted">配置看板使用的数据源。</p>
      <div className="mt-4 space-y-3 rounded-xl bg-muted p-3">
        <input
          data-testid="aitable-manage-url"
          value={aitableUrl}
          onChange={event => {
            setAITableUrl(event.target.value)
            setAITableSaved(false)
          }}
          className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none"
          placeholder="粘贴钉钉多维表格链接"
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-muted">
            {dwsStatus?.authenticated ? '钉钉已连接' : '尚未连接钉钉'}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="aitable-dws-login"
              disabled={!dwsApi || aitableBusy}
              onClick={() => {
                if (!dwsApi) return
                setAITableBusy(true)
                void dwsApi
                  .login()
                  .then(() => waitForDwsAuthentication(dwsApi))
                  .then(setDwsStatus)
                  .catch(cause => reportError(cause, '连接钉钉失败'))
                  .finally(() => setAITableBusy(false))
              }}
              className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm"
            >
              {aitableBusy ? '等待浏览器授权…' : '连接钉钉'}
            </button>
            <button
              type="button"
              data-testid="aitable-manage-save"
              disabled={!aitableLink || aitableBusy}
              onClick={() => void saveAITable()}
              className="h-8 rounded-lg bg-text-primary px-2.5 text-sm text-background disabled:opacity-40"
            >
              {aitableSaved ? '已保存' : '保存连接'}
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

export function CloudProjectManageView({
  api,
  aitableApi,
  dwsApi,
  project,
  boardCardDisplay,
  onProjectUpdated,
}: {
  api: CloudManageWorkspaceApi
  aitableApi?: AITableApi
  dwsApi?: DwsApi
  project: CloudProject
  boardCardDisplay?: BoardCardDisplaySettings
  onProjectUpdated?: (project: CloudProject) => void
}) {
  const { t } = useTranslation('common')
  const manageApi = useMemo<
    ProjectManageApi<CloudProject, CloudProjectMember, CloudLoopItem, CloudUserSearchItem>
  >(
    () =>
      createSharedWorkspaceProjectManageApi(api) as ProjectManageApi<
        CloudProject,
        CloudProjectMember,
        CloudLoopItem,
        CloudUserSearchItem
      >,
    [api]
  )
  const host = useMemo<ProjectManageHost>(
    () => ({
      icons: {
        Check,
        GitBranch,
        LockKeyhole,
        Pencil,
        Search,
        Trash2,
        X,
      },
      translate: (key, fallback, options) => t(key, fallback, options),
      confirm: message => window.confirm(message),
      trackCompleted: action =>
        track('feature_action_completed', { domain: 'project_space', action }),
      trackFailed: () => track('operation_failed', { operation: 'project_space_action' }),
      renderTooltip: ({ label, align, children }) => (
        <Tooltip label={label} align={align}>
          {children}
        </Tooltip>
      ),
      renderActionMenu: options => <ActionMenu {...options} />,
    }),
    [t]
  )
  const renderProviderSettings = useMemo(
    () =>
      project.task_provider === 'dingtalk_aitable'
        ? ({
            updateProject,
            reportError,
          }: ProjectManageExtensionContext<CloudProject>): ReactNode => (
            <AITableProviderSettings
              aitableApi={aitableApi}
              dwsApi={dwsApi}
              project={project}
              updateProject={updateProject}
              reportError={reportError}
            />
          )
        : undefined,
    [aitableApi, dwsApi, project]
  )

  return (
    <ProjectManageView
      api={manageApi}
      host={host}
      project={project}
      boardCardDisplay={boardCardDisplay}
      renderProviderSettings={renderProviderSettings}
      onProjectUpdated={onProjectUpdated}
    />
  )
}

export function LocalProjectManageView({
  api,
  ...props
}: Omit<Parameters<typeof CloudProjectManageView>[0], 'api'> & { api: DeliveryApi }) {
  const workspaceApi = useMemo(() => createWeworkDeliverySharedWorkspaceApi(api), [api])
  return <CloudProjectManageView {...props} api={workspaceApi} />
}
