import {
  Box,
  CheckCircle2,
  CirclePlus,
  Download,
  ExternalLink,
  FolderOpen,
  Loader2,
  PackageCheck,
  Play,
  Upload,
} from 'lucide-react'
import { ActionMenu } from '@/components/common/ActionMenu'
import { SmartAppRemoveLocalDialog } from './SmartAppRemoveLocalDialog'
import { SmartAppsSectionNav } from '@/components/smart-apps/SmartAppsSectionNav'
import { ApplicationContextToolbar } from '@/components/sites/ApplicationContextToolbar'
import { Button } from '@/components/ui/button'
import { HarnessAppInstallDialog } from '@/features/harness-apps/HarnessAppInstallDialog'
import { SmartAppDevelopmentDialog } from '@/features/harness-apps/SmartAppDevelopmentDialog'
import { SmartAppPluginDialog } from '@/features/harness-apps/SmartAppPluginDialog'
import type { OwnedFilter, MarketplaceSort } from './smartAppsMarketplaceTypes'
import { formatBytes, formatUpdatedAt } from './smartAppsMarketplaceHelpers'
import type { useSmartAppsMarketplaceModel } from './useSmartAppsMarketplaceModel'
import { SmartAppCard, EmptyState, SmartAppDetails } from './SmartAppsMarketplaceCards'
import { SmartAppShareDialog } from './SmartAppsMarketplaceAccess'
import { SmartAppPublishDialog } from './SmartAppPublishDialog'
export function SmartAppsMarketplaceView(model: ReturnType<typeof useSmartAppsMarketplaceModel>) {
  const {
    api,
    mode,
    t,
    i18n,
    query,
    setQuery,
    source,
    setSource,
    tag,
    setTag,
    marketplaceSort,
    setMarketplaceSort,
    ownedFilter,
    setOwnedFilter,
    busy,
    exportNotice,
    setExportNotice,
    accessNotice,
    setAccessNotice,
    setPendingInstall,
    setModelKey,
    publishItem,
    setPublishItem,
    publishInstallation,
    setPublishInstallation,
    shareItem,
    setShareItem,
    creating,
    createError,
    developmentDialog,
    setDevelopmentDialog,
    copyInstallation,
    setCopyInstallation,
    importing,
    pendingDelete,
    setPendingDelete,
    pluginInstallation,
    setPluginInstallation,
    targetInstallItem,
    targetLookupError,
    targetLookupPending,
    setTargetLookupRevision,
    items,
    localReady,
    localError,
    tags,
    loading,
    error,
    loadError,
    refresh,
    currentPendingInstall,
    currentSelected,
    navigateFromSmartApps,
    changeModel,
    hasSelectedModel,
    modelOptions,
    openInstalledApp,
    startInstalledApp,
    installModelKey,
    ownedCards,
    visibleOwnedCards,
    visibleMarketplaceItems,
    hasItems,
    localState,
    selectDetails,
    closeDetails,
    withCurrentInstallation,
    download,
    install,
    addPluginToInstallation,
    createSmartApp,
    copySmartApp,
    linkSmartAppDirectory,
    chooseCreatedPackage,
    dropCreatedPackage,
    availableUpdate,
    runtimeStateLabel,
    localActions,
    deleteLocalInstallation,
  } = model
  return (
    <section
      data-testid={mode === 'owned' ? 'smart-apps-owned-page' : 'smart-apps-marketplace-page'}
      onDragOver={mode === 'owned' ? event => event.preventDefault() : undefined}
      onDrop={mode === 'owned' ? event => void dropCreatedPackage(event) : undefined}
    >
      <header className="mb-3 flex justify-end md:absolute md:right-8 md:top-4 md:mb-0">
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            data-testid="smart-apps-created-create"
            onClick={() => setDevelopmentDialog('create')}
          >
            <CirclePlus className="h-4 w-4" />
            {creating
              ? t('workbench.smart_apps_preparing', '正在准备…')
              : t('workbench.smart_apps_create', '创建工作台')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="smart-apps-link-directory"
            disabled={importing}
            onClick={() => void linkSmartAppDirectory()}
          >
            <FolderOpen className="h-4 w-4" />
            {t('workbench.smart_apps_link_directory', '关联文件夹')}
          </Button>
          <Button
            size="sm"
            data-testid="smart-apps-import-button"
            disabled={importing}
            onClick={() => void chooseCreatedPackage()}
          >
            {importing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {importing
              ? t('workbench.smart_apps_importing', '导入中…')
              : t('workbench.smart_apps_import_app', '导入发布包')}
          </Button>
        </div>
      </header>

      <ApplicationContextToolbar
        leading={
          <SmartAppsSectionNav
            active={mode === 'owned' ? 'owned' : 'marketplace'}
            onNavigate={navigateFromSmartApps}
          />
        }
        searchLabel={t('workbench.smart_apps_search', '搜索工作台')}
        searchPlaceholder={t('workbench.smart_apps_search', '搜索工作台')}
        searchTestId={
          mode === 'owned' ? 'smart-apps-owned-search' : 'smart-apps-marketplace-search'
        }
        value={query}
        onValueChange={setQuery}
        trailing={
          mode === 'marketplace' ? (
            <>
              <select
                data-testid="smart-apps-marketplace-source"
                value={source}
                className="h-full min-w-32 rounded-lg border border-border/50 bg-background px-3 text-sm outline-none keyboard:focus:border-focus keyboard:focus:ring-2 keyboard:focus:ring-focus/15"
                onChange={event => setSource(event.target.value as typeof source)}
              >
                <option value="all">{t('workbench.smart_apps_source_all', '全部来源')}</option>
                <option value="official">
                  {t('workbench.smart_apps_source_official', '官方工作台')}
                </option>
                <option value="public">
                  {t('workbench.smart_apps_source_public', '全员应用')}
                </option>
                <option value="shared">
                  {t('workbench.smart_apps_source_shared', '分享给我')}
                </option>
              </select>
              <select
                data-testid="smart-apps-marketplace-tag"
                value={tag}
                className="h-full min-w-32 rounded-lg border border-border/50 bg-background px-3 text-sm outline-none keyboard:focus:border-focus keyboard:focus:ring-2 keyboard:focus:ring-focus/15"
                onChange={event => setTag(event.target.value)}
              >
                <option value="">{t('workbench.smart_apps_tag_all', '全部标签')}</option>
                {tags.map(item => (
                  <option key={item.id} value={item.id}>
                    {i18n.language.startsWith('zh') ? item.name_zh : item.name_en}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <div
              className="flex h-full items-center rounded-lg border border-border/50 bg-surface/40 p-0.5"
              data-testid="smart-apps-owned-filters"
            >
              {(
                [
                  ['all', t('workbench.smart_apps_filter_all', '全部'), ownedCards.length],
                  [
                    'created',
                    t('workbench.smart_apps_filter_created', '我创建/导入的'),
                    ownedCards.filter(card => card.category === 'created').length,
                  ],
                  [
                    'installed',
                    t('workbench.smart_apps_filter_installed', '我安装的'),
                    ownedCards.filter(card => card.category === 'installed').length,
                  ],
                ] as Array<[OwnedFilter, string, number]>
              ).map(([value, label, count]) => (
                <button
                  key={value}
                  type="button"
                  data-testid={`smart-apps-owned-filter-${value}`}
                  aria-pressed={ownedFilter === value}
                  className={`h-full rounded-md px-3 text-sm transition-colors ${
                    ownedFilter === value
                      ? 'bg-background font-medium text-text-primary shadow-sm'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                  onClick={() => setOwnedFilter(value)}
                >
                  {label} <span className="ml-1 text-xs text-text-muted">{count}</span>
                </button>
              ))}
            </div>
          )
        }
      />

      {!loading && hasItems ? (
        <div className="mt-4 flex min-h-8 items-center justify-between gap-4 text-xs text-text-muted">
          <span>
            {t('workbench.smart_apps_result_count', '共 {{count}} 个工作台').replace(
              '{{count}}',
              String(mode === 'owned' ? visibleOwnedCards.length : items.length)
            )}
          </span>
          {mode === 'marketplace' ? (
            <select
              data-testid="smart-apps-marketplace-sort"
              value={marketplaceSort}
              aria-label={t('workbench.smart_apps_sort_label', '排序方式')}
              className="h-8 rounded-lg border border-transparent bg-transparent px-2 text-sm text-text-primary outline-none hover:bg-muted keyboard:focus:border-focus keyboard:focus:ring-2 keyboard:focus:ring-focus/15"
              onChange={event => setMarketplaceSort(event.target.value as MarketplaceSort)}
            >
              <option value="recommended">
                {t('workbench.smart_apps_sort_recommended', '推荐排序')}
              </option>
              <option value="updated">{t('workbench.smart_apps_sort_updated', '最近更新')}</option>
            </select>
          ) : null}
        </div>
      ) : null}

      {createError || error ? (
        <div
          role="alert"
          className="mt-4 flex items-center justify-between gap-3 rounded-lg bg-danger/10 p-3 text-sm text-danger"
        >
          <span>{createError ?? error}</span>
          {loadError ? (
            <Button
              size="sm"
              variant="outline"
              data-testid="smart-apps-load-retry"
              className="h-11 md:h-9"
              onClick={() => void refresh()}
            >
              {t('workbench.retry', '重试')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {targetLookupError ? (
        <div
          role="alert"
          data-testid="smart-app-deep-link-error"
          className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-danger/25 bg-danger/10 p-4 text-sm text-danger"
        >
          <span className="min-w-0">{targetLookupError}</span>
          <Button
            size="sm"
            variant="secondary"
            className="min-h-11 shrink-0 sm:min-h-9"
            data-testid="smart-app-deep-link-retry"
            disabled={targetLookupPending}
            onClick={() => setTargetLookupRevision(revision => revision + 1)}
          >
            {t('workbench.retry', '重试')}
          </Button>
        </div>
      ) : null}

      {targetInstallItem ? (
        <div
          role="status"
          data-testid="smart-app-deep-link-install-prompt"
          className="mt-4 flex items-start gap-3 rounded-xl border border-border/50 bg-muted/35 p-4"
        >
          <Download className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary">
              {t('workbench.smart_apps_deep_link_install_title', '此智能工作台尚未安装')}
            </p>
            <p className="mt-1 text-sm leading-5 text-text-secondary">
              {t(
                'workbench.smart_apps_deep_link_install_description',
                '安装“{{name}}”后，可像其他已安装工作台一样在独立标签页中运行。'
              ).replace('{{name}}', targetInstallItem.displayName)}
            </p>
          </div>
        </div>
      ) : null}

      {exportNotice ? (
        <p
          role="status"
          data-testid="smart-app-export-success"
          className="mt-4 flex items-center gap-2 rounded-lg bg-success/10 p-3 text-sm text-success"
        >
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          {exportNotice}
        </p>
      ) : null}

      {mode === 'owned' && accessNotice ? (
        <div
          role="status"
          data-testid="smart-app-access-success"
          className="mt-4 flex items-center justify-between gap-3 rounded-lg bg-success/10 p-3 text-sm text-success"
        >
          <span className="flex min-w-0 items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            {accessNotice.message}
          </span>
          {accessNotice.showMarketplace ? (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 border-success/30 bg-background text-text-primary shadow-sm hover:bg-success/10"
              data-testid="smart-app-access-view-marketplace"
              onClick={() => navigateFromSmartApps('/sites?app_type=smart_app')}
            >
              {t('workbench.smart_apps_view_marketplace', '去市场查看')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {!api && mode === 'marketplace' ? (
        <EmptyState
          icon={<Box className="h-6 w-6" />}
          title={t('workbench.smart_apps_cloud_required', '连接云端后使用智能工作台市场')}
          description={t(
            'workbench.smart_apps_cloud_required_hint',
            '本地已安装工作台不受影响，仍可离线管理和运行。'
          )}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigateFromSmartApps('/sites?app_type=smart_app&view=owned')}
            >
              <PackageCheck className="h-4 w-4" />
              {t('workbench.smart_apps_view_my', '查看我的工作台')}
            </Button>
          }
        />
      ) : (loading && !hasItems) || targetLookupPending ? (
        <div className="flex min-h-72 items-center justify-center text-text-muted">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          {t('workbench.smart_apps_loading', '正在加载')}
        </div>
      ) : !hasItems && !error ? (
        <EmptyState
          icon={<Box className="h-6 w-6" />}
          title={
            mode === 'owned'
              ? t('workbench.smart_apps_my_empty', '还没有符合条件的工作台')
              : t('workbench.smart_apps_marketplace_empty', '没有找到智能工作台')
          }
          description={
            mode === 'owned'
              ? t(
                  'workbench.smart_apps_my_empty_hint',
                  '可以调整筛选条件、从市场安装，或导入一个本地发布包。'
                )
              : t(
                  'workbench.smart_apps_marketplace_empty_hint',
                  '可以调整搜索条件，或稍后再来看看。'
                )
          }
        />
      ) : !hasItems ? null : (
        <div
          data-testid={mode === 'owned' ? 'smart-apps-created-list' : undefined}
          className="mt-3 grid gap-4 md:grid-cols-2"
        >
          {mode === 'owned'
            ? visibleOwnedCards.map(card => {
                const { installation, item } = card
                const title = item?.displayName ?? installation?.manifest.displayName ?? ''
                const description = item?.summary ?? installation?.manifest.description ?? ''
                const isOwner = item?.accessRole === 'owner'
                const sameVersion = Boolean(
                  item && installation && item.version === installation.manifest.version
                )
                const update = installation ? availableUpdate(installation) : null
                const shouldPublish = Boolean(
                  card.category === 'created' && installation && (!item || !sameVersion)
                )
                const stateTone =
                  installation?.state === 'failed'
                    ? 'danger'
                    : update
                      ? 'accent'
                      : installation
                        ? 'success'
                        : 'muted'
                const stateLabel = installation
                  ? update
                    ? t('workbench.smart_apps_update_available', '有可用更新')
                    : runtimeStateLabel(installation)
                  : !localReady
                    ? localError
                      ? t('workbench.smart_apps_load_failed', '智能工作台加载失败。')
                      : t('workbench.smart_apps_loading', '正在加载')
                    : t('workbench.smart_apps_not_installed', '未安装')
                return (
                  <SmartAppCard
                    key={card.key}
                    testId={
                      card.category === 'created' && installation
                        ? `smart-app-created-item-${installation.id}`
                        : item
                          ? `smart-app-owned-item-${item.id}`
                          : undefined
                    }
                    iconUrl={item?.iconUrl}
                    title={title}
                    sourceLabel={
                      card.category === 'created'
                        ? installation?.source === 'linked'
                          ? t('workbench.smart_apps_linked_folder', '关联文件夹')
                          : installation && !installation.smartAppId
                            ? t('workbench.smart_apps_local_import', '本地导入')
                            : t('workbench.smart_apps_created_by_me', '我创建')
                        : t('workbench.smart_apps_market_install', '市场安装')
                    }
                    description={description}
                    tags={item?.tags ?? []}
                    visibility={{
                      kind: item?.visibility ?? 'private',
                      label:
                        item?.visibility === 'public'
                          ? t('workbench.smart_apps_visibility_public', '全员')
                          : item?.visibility === 'restricted'
                            ? t('workbench.smart_apps_visibility_restricted', '指定成员')
                            : t('workbench.smart_apps_visibility_private', '仅自己'),
                      onClick: isOwner && item ? () => setShareItem(item) : undefined,
                      testId: item ? `smart-app-visibility-${item.id}` : undefined,
                    }}
                    stateLabel={stateLabel}
                    stateTone={stateTone}
                    version={installation?.manifest.version ?? item?.version ?? ''}
                    onDetails={item ? () => selectDetails(item) : undefined}
                    supplementary={
                      <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 text-xs text-text-muted">
                        {installation ? (
                          <label className="flex min-w-0 items-center gap-1">
                            <span>{t('workbench.harness_apps_bound_model', '模型')}：</span>
                            <select
                              data-testid={`harness-app-model-${installation.id}`}
                              aria-label={t('workbench.smart_apps_change_model', '修改模型')}
                              className="min-w-0 max-w-44 rounded-md border border-border/50 bg-background px-1.5 py-0.5 text-xs text-text-secondary outline-none keyboard:focus:border-focus keyboard:focus:ring-2 keyboard:focus:ring-focus/15 disabled:cursor-not-allowed disabled:opacity-60"
                              value={installation.modelKey ?? ''}
                              disabled={
                                !localReady ||
                                busy === installation.id ||
                                installation.state === 'running'
                              }
                              onChange={event =>
                                withCurrentInstallation(installation, current =>
                                  changeModel(current, event.target.value)
                                )
                              }
                            >
                              {!installation.modelKey ? (
                                <option value="">
                                  {t('workbench.harness_apps_model_choose', '请选择模型')}
                                </option>
                              ) : null}
                              {modelOptions.map(option => (
                                <option key={option.key} value={option.key}>
                                  {option.label}
                                </option>
                              ))}
                              {!hasSelectedModel(installation) && installation.modelKey ? (
                                <option value={installation.modelKey}>
                                  {t('workbench.harness_apps_model_unavailable', '模型不可用')}
                                </option>
                              ) : null}
                            </select>
                          </label>
                        ) : null}
                        {item?.updatedAt ? (
                          <span>
                            {t('workbench.smart_apps_updated_relative', '更新于 {{time}}').replace(
                              '{{time}}',
                              formatUpdatedAt(item.updatedAt, i18n?.language ?? 'zh-CN')
                            )}
                          </span>
                        ) : null}
                      </div>
                    }
                    actions={
                      <>
                        {shouldPublish && installation ? (
                          <Button
                            size="sm"
                            variant="outline"
                            data-testid={`smart-app-created-publish-${installation.id}`}
                            disabled={!api || busy === installation.id}
                            onClick={() => {
                              setPublishInstallation(installation)
                              setPublishItem(item)
                            }}
                          >
                            <Upload className="h-4 w-4" />
                            {item
                              ? t('workbench.smart_apps_publish_version', '发布新版本')
                              : t('workbench.smart_apps_publish', '发布')}
                          </Button>
                        ) : null}
                        {update ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!localReady || busy === installation?.id}
                            onClick={() => void download(update)}
                          >
                            <Download className="h-4 w-4" />
                            {t('workbench.smart_apps_update', '更新')}
                          </Button>
                        ) : null}
                        {installation ? (
                          installation.state === 'running' ? (
                            <Button
                              size="sm"
                              data-testid={`harness-app-open-${installation.id}`}
                              disabled={!localReady || busy === installation.id}
                              onClick={() => openInstalledApp(installation)}
                            >
                              <ExternalLink className="h-4 w-4" />
                              {t('workbench.harness_apps_open', '打开')}
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              data-testid={`harness-app-start-${installation.id}`}
                              disabled={
                                !localReady ||
                                busy === installation.id ||
                                !hasSelectedModel(installation)
                              }
                              onClick={() =>
                                withCurrentInstallation(installation, startInstalledApp)
                              }
                            >
                              <Play className="h-4 w-4" />
                              {t('workbench.harness_apps_start', '运行')}
                            </Button>
                          )
                        ) : item ? (
                          <Button
                            size="sm"
                            data-testid={`smart-app-owned-install-${item.id}`}
                            disabled={!localReady || busy === `download-${item.id}`}
                            onClick={() => void download(item)}
                          >
                            <Download className="h-4 w-4" />
                            {t('workbench.harness_apps_install', '安装')}
                          </Button>
                        ) : null}
                        {isOwner ? (
                          <Button size="sm" variant="outline" onClick={() => setShareItem(item)}>
                            {t('workbench.smart_apps_manage_access', '管理范围')}
                          </Button>
                        ) : null}
                        {installation ? (
                          <ActionMenu
                            ariaLabel={t('workbench.smart_apps_more_actions', '更多操作')}
                            testId={`smart-app-actions-${installation.id}`}
                            items={localActions(installation, item)}
                            placement="bottom-end"
                            triggerClassName="flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary"
                          />
                        ) : null}
                      </>
                    }
                  />
                )
              })
            : null}
          {mode === 'marketplace' &&
            visibleMarketplaceItems.map(item => {
              const state = localState(item)
              const modelLabel = state
                ? (modelOptions.find(option => option.key === state.installation.modelKey)?.label ??
                  t('workbench.harness_apps_model_unavailable', '模型不可用'))
                : t('workbench.smart_apps_model_selected_on_install', '安装时选择')
              return (
                <SmartAppCard
                  key={item.id}
                  testId={`smart-app-marketplace-item-${item.id}`}
                  iconUrl={item.iconUrl}
                  title={item.displayName}
                  sourceLabel={
                    item.sourceType === 'official'
                      ? t('workbench.smart_apps_official', '官方')
                      : item.accessRole === 'owner'
                        ? t('workbench.smart_apps_published_by_me', '我发布的')
                        : item.accessRole === 'public'
                          ? t('workbench.smart_apps_public_for_everyone', '全员应用')
                          : t('workbench.smart_apps_shared_with_me', '分享给我')
                  }
                  description={item.summary}
                  tags={item.tags}
                  visibility={{
                    kind: item.visibility,
                    label:
                      item.visibility === 'public'
                        ? t('workbench.smart_apps_visibility_public', '全员')
                        : t('workbench.smart_apps_visibility_restricted', '指定成员'),
                  }}
                  stateLabel={
                    state
                      ? state.update
                        ? t('workbench.smart_apps_update_available', '有可用更新')
                        : runtimeStateLabel(state.installation)
                      : !localReady
                        ? localError
                          ? t('workbench.smart_apps_load_failed', '智能工作台加载失败。')
                          : t('workbench.smart_apps_loading', '正在加载')
                        : t('workbench.smart_apps_not_installed', '未安装')
                  }
                  stateTone={
                    state?.installation.state === 'failed'
                      ? 'danger'
                      : state?.update
                        ? 'accent'
                        : state
                          ? 'success'
                          : 'muted'
                  }
                  version={item.version}
                  supplementary={
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-text-muted">
                      <span>
                        {t('workbench.harness_apps_bound_model', '模型')}：{modelLabel}
                      </span>
                      <span>
                        {t('workbench.smart_apps_size', '大小')}：{formatBytes(item.sizeBytes)}
                      </span>
                    </div>
                  }
                  onDetails={() => selectDetails(item)}
                  actions={
                    <>
                      {state ? (
                        state.update ? (
                          <Button
                            size="sm"
                            data-testid={`smart-app-marketplace-install-${item.id}`}
                            disabled={!localReady || busy === `download-${item.id}`}
                            onClick={() => void download(item)}
                          >
                            <Download className="h-4 w-4" />
                            {t('workbench.smart_apps_update', '更新')}
                          </Button>
                        ) : state.installation.state === 'running' ? (
                          <Button
                            size="sm"
                            data-testid={`harness-app-open-${state.installation.id}`}
                            disabled={!localReady || busy === state.installation.id}
                            onClick={() => openInstalledApp(state.installation)}
                          >
                            <ExternalLink className="h-4 w-4" />
                            {t('workbench.harness_apps_open', '打开')}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            data-testid={`harness-app-start-${state.installation.id}`}
                            disabled={
                              !localReady ||
                              busy === state.installation.id ||
                              !hasSelectedModel(state.installation)
                            }
                            onClick={() =>
                              withCurrentInstallation(state.installation, startInstalledApp)
                            }
                          >
                            <Play className="h-4 w-4" />
                            {t('workbench.harness_apps_start', '运行')}
                          </Button>
                        )
                      ) : (
                        <Button
                          size="sm"
                          data-testid={`smart-app-marketplace-install-${item.id}`}
                          disabled={!localReady || busy === `download-${item.id}`}
                          onClick={() => void download(item)}
                        >
                          {busy === `download-${item.id}` ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Download className="h-4 w-4" />
                          )}
                          {t('workbench.harness_apps_install', '安装')}
                        </Button>
                      )}
                      {state ? (
                        <ActionMenu
                          ariaLabel={t('workbench.smart_apps_more_actions', '更多操作')}
                          testId={`smart-app-marketplace-actions-${item.id}`}
                          items={localActions(state.installation, item)}
                          placement="bottom-end"
                          triggerClassName="flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary"
                        />
                      ) : null}
                    </>
                  }
                />
              )
            })}
        </div>
      )}

      {currentSelected ? (
        <SmartAppDetails
          item={currentSelected}
          state={localState(currentSelected)}
          installDisabled={!localReady}
          busy={busy === `download-${currentSelected.id}`}
          onClose={closeDetails}
          onInstall={() => void download(currentSelected)}
        />
      ) : null}
      {currentPendingInstall ? (
        <HarnessAppInstallDialog
          busy={busy === 'install'}
          installDisabled={!localReady}
          error={error}
          modelKey={installModelKey}
          modelOptions={modelOptions}
          preview={currentPendingInstall.preview}
          onCancel={() => setPendingInstall(null)}
          onInstall={() => void install()}
          onModelChange={setModelKey}
        />
      ) : null}
      {publishItem !== undefined && api ? (
        <SmartAppPublishDialog
          api={api}
          item={publishItem}
          installation={publishInstallation}
          tags={tags}
          onClose={() => {
            setPublishItem(undefined)
            setPublishInstallation(null)
          }}
          onPublished={() => {
            setPublishItem(undefined)
            setPublishInstallation(null)
            void refresh()
          }}
        />
      ) : null}
      {shareItem && api ? (
        <SmartAppShareDialog
          api={api}
          item={shareItem}
          onClose={() => setShareItem(null)}
          onSaved={savedAccess => {
            setShareItem(null)
            setExportNotice(null)
            setAccessNotice({
              message:
                savedAccess.scope === 'public'
                  ? savedAccess.isListed
                    ? t(
                        'workbench.smart_apps_listed_success',
                        'v{{version}} 已上架到智能应用市场。'
                      ).replace('{{version}}', savedAccess.version)
                    : t(
                        'workbench.smart_apps_public_unlisted_success',
                        '已发布给全员，但当前已被管理员下架。'
                      )
                  : t('workbench.smart_apps_access_saved', '分享范围已保存。'),
              showMarketplace: savedAccess.scope === 'public' && savedAccess.isListed,
            })
            void refresh()
          }}
        />
      ) : null}
      {developmentDialog ? (
        <SmartAppDevelopmentDialog
          mode={developmentDialog}
          initialDisplayName={
            developmentDialog === 'copy' ? copyInstallation?.manifest.displayName : undefined
          }
          onClose={() => {
            setDevelopmentDialog(null)
            if (developmentDialog === 'copy') setCopyInstallation(null)
          }}
          onSubmit={developmentDialog === 'copy' ? copySmartApp : createSmartApp}
        />
      ) : null}
      {pluginInstallation ? (
        <SmartAppPluginDialog
          displayName={pluginInstallation.manifest.displayName}
          onClose={() => setPluginInstallation(null)}
          onInstall={addPluginToInstallation}
        />
      ) : null}
      <SmartAppRemoveLocalDialog
        installation={pendingDelete}
        localReady={localReady}
        localError={localError}
        pending={Boolean(pendingDelete && busy === pendingDelete.id)}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void deleteLocalInstallation()}
      />
    </section>
  )
}
