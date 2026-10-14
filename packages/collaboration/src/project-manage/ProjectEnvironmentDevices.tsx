// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationTranslate } from '../i18n'
import {
  executionEnvironmentStatuses,
  executionEnvironmentStatusLabel,
} from '../execution-environment/status'
import type {
  CollaborationExecutionEnvironment,
  CollaborationExecutionEnvironmentDeviceState,
} from '../types'

interface Props {
  testIdPrefix: string
  translate: CollaborationTranslate
  isWorkspaceScope: boolean
  requireWorkspaceSharing: boolean
  canManage: boolean
  saving: boolean
  loading: boolean
  error: string
  pickerLoading: boolean
  pickerError: string
  onRetry(): void
  onRetryPicker(): void
  assignedItems: CollaborationExecutionEnvironment[]
  visibleAssignedItems: CollaborationExecutionEnvironment[]
  candidates: CollaborationExecutionEnvironment[]
  workspaceDeviceIds: Set<number> | undefined
  deviceStates: Record<string, CollaborationExecutionEnvironmentDeviceState>
  initializingDeviceId: number | null
  configurationDirty: boolean
  statusFilter: 'all' | CollaborationExecutionEnvironment['status']
  onStatusFilterChange(value: 'all' | CollaborationExecutionEnvironment['status']): void
  pickerOpen: boolean
  onTogglePicker(): void
  onManageDevices?(): void
  addEnvironment(environment: CollaborationExecutionEnvironment): Promise<void>
  removeEnvironment(environment: CollaborationExecutionEnvironment): Promise<void>
  createEnvironmentOnDevice(environment: CollaborationExecutionEnvironment): Promise<void>
}

export function ProjectEnvironmentDevices({
  testIdPrefix,
  translate,
  isWorkspaceScope,
  requireWorkspaceSharing,
  canManage,
  saving,
  loading,
  error,
  pickerLoading,
  pickerError,
  onRetry,
  onRetryPicker,
  assignedItems,
  visibleAssignedItems,
  candidates,
  workspaceDeviceIds,
  deviceStates,
  initializingDeviceId,
  configurationDirty,
  statusFilter,
  onStatusFilterChange,
  pickerOpen,
  onTogglePicker,
  onManageDevices,
  addEnvironment,
  removeEnvironment,
  createEnvironmentOnDevice,
}: Props) {
  return (
    <div className="space-y-3" data-testid={`${testIdPrefix}-environments`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-medium">
              {translate(
                isWorkspaceScope
                  ? 'todo.configured_workspace_execution_environments'
                  : 'todo.project_available_environments',
                isWorkspaceScope ? '共享环境' : '项目可用环境'
              )}
            </h2>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {assignedItems.length > 1 ? (
            <label className="flex items-center gap-2 text-xs text-text-secondary">
              {translate('todo.execution_environment_status_filter', '状态')}
              <select
                className="h-8 rounded-lg border border-border bg-background px-2 text-sm text-text-primary"
                data-testid={`${testIdPrefix}-status-filter`}
                value={statusFilter}
                onChange={event => onStatusFilterChange(event.target.value as typeof statusFilter)}
              >
                <option value="all">
                  {translate('todo.execution_environment_all_statuses', '全部')}
                </option>
                {executionEnvironmentStatuses.map(status => (
                  <option key={status} value={status}>
                    {executionEnvironmentStatusLabel(status, translate)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {canManage ? (
            <button
              type="button"
              className={
                assignedItems.length === 0
                  ? 'collaboration-primary-button'
                  : 'collaboration-secondary-button'
              }
              data-testid={`${testIdPrefix}-add`}
              disabled={loading || saving}
              onClick={onTogglePicker}
            >
              {pickerOpen
                ? translate('common.cancel', '取消')
                : `＋ ${translate('todo.add_execution_device', '添加设备')}`}
            </button>
          ) : null}
        </div>
      </div>

      <div className="pt-3">
        {error ? (
          <div
            className="mb-3 flex items-center gap-3 text-sm text-text-secondary"
            data-testid={`${testIdPrefix}s-error`}
            role="alert"
          >
            <span>{error}</span>
            <button
              type="button"
              className="collaboration-link-button"
              data-testid={`${testIdPrefix}-retry`}
              onClick={onRetry}
              disabled={loading}
            >
              {translate('common.retry', '重试')}
            </button>
          </div>
        ) : null}
        {loading ? (
          <EnvironmentListSkeleton testId={`${testIdPrefix}-loading`} translate={translate} />
        ) : assignedItems.length === 0 && error ? null : assignedItems.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-3">
            <p className="text-sm font-medium">
              {translate(
                isWorkspaceScope
                  ? 'todo.no_workspace_execution_environments'
                  : 'todo.no_project_execution_environments',
                '尚未添加运行设备'
              )}
            </p>
            <p className="mt-0.5 text-xs text-text-muted">
              {translate(
                'todo.execution_environment_empty_hint',
                '通过「添加设备」选择可以运行任务的设备。'
              )}
            </p>
            {pickerOpen &&
            !pickerLoading &&
            !pickerError &&
            candidates.length === 0 &&
            canManage &&
            onManageDevices ? (
              <button
                className="collaboration-secondary-button mt-3"
                data-testid={`${testIdPrefix}-manage-devices`}
                type="button"
                onClick={onManageDevices}
              >
                {translate('todo.manage_execution_devices', '添加或启动设备')}
              </button>
            ) : null}
          </div>
        ) : visibleAssignedItems.length === 0 ? (
          <p className="text-sm text-text-muted" role="status">
            {translate('todo.execution_environment_no_matches', '没有符合当前状态的执行环境')}
          </p>
        ) : (
          <div className="rounded-lg border border-border">
            {visibleAssignedItems.map((environment, index) => {
              const deviceKey = environment.device_key ?? String(environment.device_id ?? '')
              const deviceState = deviceStates[deviceKey]
              const isPreparingDevice = initializingDeviceId === environment.device_id
              const instanceStatus = isPreparingDevice
                ? 'preparing'
                : deviceState?.status === 'ready'
                  ? 'ready'
                  : deviceState?.status === 'error'
                    ? 'error'
                    : 'uninitialized'
              return (
                <div
                  className={`flex flex-wrap items-center gap-3 px-4 py-3 ${
                    index > 0 ? 'border-t border-border' : ''
                  }`}
                  data-testid={`${testIdPrefix}-${environment.device_id}`}
                  data-preparation-state={instanceStatus}
                  key={environment.id}
                >
                  <span className="min-w-40 flex-1">
                    <span className="block truncate text-sm font-medium">{environment.name}</span>
                    <span className="block text-xs text-text-muted">
                      {environment.kind === 'cloud_host'
                        ? translate('todo.cloud_host', '云主机')
                        : translate('todo.local_device', '本地设备')}
                      {isWorkspaceScope || workspaceDeviceIds ? (
                        <>
                          {' · '}
                          {isWorkspaceScope ||
                          (environment.device_id != null &&
                            workspaceDeviceIds?.has(environment.device_id))
                            ? translate('todo.workspace_shared', '空间共享')
                            : translate('todo.project_direct', '项目直接添加')}
                        </>
                      ) : null}
                      {' · '}
                      {executionEnvironmentStatusLabel(environment.status, translate)}
                    </span>
                  </span>
                  {instanceStatus === 'preparing' || instanceStatus === 'error' ? (
                    <span className="text-xs text-text-secondary" role="status">
                      {instanceStatus === 'preparing'
                        ? translate('todo.execution_environment_preparing', '正在准备项目目录')
                        : translate(
                            'todo.execution_environment_initialization_error',
                            '项目准备失败'
                          )}
                    </span>
                  ) : null}
                  {canManage && environment.status === 'online' ? (
                    <details
                      className="relative"
                      data-testid={`${testIdPrefix}-actions-${environment.device_id}`}
                    >
                      <summary
                        className="collaboration-link-button flex cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden"
                        data-testid={`${testIdPrefix}-actions-toggle-${environment.device_id}`}
                      >
                        {translate('common.more', '更多')}
                      </summary>
                      <div className="absolute right-0 z-10 mt-1 whitespace-nowrap rounded-lg border border-border bg-background p-2 shadow-sm">
                        <button
                          type="button"
                          className="collaboration-link-button px-2"
                          data-testid={`${testIdPrefix}-initialize-${environment.device_id}`}
                          disabled={saving || configurationDirty}
                          onClick={() => void createEnvironmentOnDevice(environment)}
                        >
                          {translate(
                            'todo.execution_environment_prepare_ahead',
                            '提前准备项目目录'
                          )}
                        </button>
                      </div>
                    </details>
                  ) : null}
                  {canManage ? (
                    <button
                      type="button"
                      className="text-sm text-text-secondary hover:text-text-primary"
                      data-testid={`${testIdPrefix}-remove-${environment.device_id}`}
                      disabled={saving}
                      onClick={() => void removeEnvironment(environment)}
                    >
                      {translate('common.remove', '移除')}
                    </button>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {canManage ? (
        <div>
          {pickerOpen ? (
            <div
              className="mt-3 overflow-hidden rounded-lg border border-border"
              data-testid={`${testIdPrefix}-picker`}
            >
              <div className="border-b border-border bg-muted px-4 py-3">
                <h3 className="text-sm font-medium">
                  {translate('todo.select_execution_device', '选择在线设备')}
                </h3>
                <p className="mt-0.5 text-xs text-text-muted">
                  {isWorkspaceScope
                    ? translate(
                        'todo.select_workspace_environment',
                        '从我的资源中选择设备，授权给这个空间共享使用。'
                      )
                    : translate(
                        'todo.select_project_environment',
                        '从我的资源或空间共享资源中选择设备，授权给这个项目使用。'
                      )}
                </p>
              </div>
              {pickerError ? (
                <div
                  className="flex items-center gap-3 px-4 py-3 text-sm text-text-secondary"
                  data-testid={`${testIdPrefix}-picker-error`}
                  role="alert"
                >
                  <span>{pickerError}</span>
                  <button
                    type="button"
                    className="collaboration-link-button"
                    data-testid={`${testIdPrefix}-picker-retry`}
                    onClick={onRetryPicker}
                  >
                    {translate('common.retry', '重试')}
                  </button>
                </div>
              ) : null}
              {pickerLoading && candidates.length === 0 ? (
                <EnvironmentListSkeleton
                  testId={`${testIdPrefix}-picker-loading`}
                  translate={translate}
                />
              ) : candidates.length === 0 && pickerError ? null : candidates.length === 0 ? (
                <div className="px-4 py-5">
                  <p className="text-sm text-text-muted" role="status">
                    {translate(
                      'todo.no_available_execution_environments',
                      '没有可添加的在线执行环境'
                    )}
                  </p>
                  {canManage && onManageDevices ? (
                    <button
                      className="collaboration-secondary-button mt-3"
                      data-testid={`${testIdPrefix}-manage-devices-picker`}
                      type="button"
                      onClick={onManageDevices}
                    >
                      {translate('todo.manage_execution_devices', '添加或启动设备')}
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {candidates.map(environment => {
                    const isShared =
                      environment.device_id != null &&
                      Boolean(workspaceDeviceIds?.has(environment.device_id))
                    const sharingUnknown = requireWorkspaceSharing && !workspaceDeviceIds
                    const needsSharing = requireWorkspaceSharing && !sharingUnknown && !isShared
                    const sharingHintId = `${testIdPrefix}-share-hint-${environment.device_id}`
                    return (
                      <div className="flex items-center gap-4 px-4 py-3" key={environment.id}>
                        <span className="min-w-40 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {environment.name}
                          </span>
                          <span className="block text-xs text-text-muted">
                            {environment.kind === 'cloud_host'
                              ? translate('todo.cloud_host', '云主机')
                              : translate('todo.local_device', '本地设备')}
                            {' · '}
                            {executionEnvironmentStatusLabel(environment.status, translate)}
                            {' · '}
                            {isShared
                              ? translate('todo.workspace_shared', '空间共享')
                              : translate('todo.personal_resource', '我的资源')}
                          </span>
                          {needsSharing ? (
                            <span
                              className="mt-1 block text-xs text-text-muted"
                              id={sharingHintId}
                              data-testid={sharingHintId}
                            >
                              {translate(
                                'todo.execution_environment_share_scope_hint',
                                '共享后，空间成员可为其他项目授权使用；仍使用此环境的账号和额度。'
                              )}
                            </span>
                          ) : null}
                        </span>
                        <button
                          type="button"
                          className="collaboration-link-button"
                          data-testid={`${testIdPrefix}-candidate-${environment.device_id}`}
                          disabled={saving || sharingUnknown}
                          aria-describedby={needsSharing ? sharingHintId : undefined}
                          onClick={() => void addEnvironment(environment)}
                        >
                          {sharingUnknown
                            ? pickerError
                              ? translate(
                                  'todo.execution_environment_sharing_unknown',
                                  '共享状态未确认'
                                )
                              : translate(
                                  'todo.execution_environment_checking_sharing',
                                  '正在检查共享状态'
                                )
                            : needsSharing
                              ? translate('todo.execution_environment_share_and_add', '共享并添加')
                              : `＋ ${translate('common.add', '添加')}`}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function EnvironmentListSkeleton({
  testId,
  translate,
}: {
  testId: string
  translate: CollaborationTranslate
}) {
  return (
    <div
      data-testid={testId}
      role="status"
      aria-busy="true"
      aria-label={translate('common.loading', '加载中…')}
      className="space-y-4 rounded-lg border border-border px-4 py-3 motion-safe:animate-pulse"
    >
      {[0, 1].map(row => (
        <div key={row} className="flex items-center justify-between gap-4" aria-hidden="true">
          <div className="space-y-2">
            <div className="h-4 w-32 rounded bg-muted" />
            <div className="h-3 w-48 max-w-full rounded bg-muted" />
          </div>
          <div className="h-4 w-10 rounded bg-muted" />
        </div>
      ))}
    </div>
  )
}
