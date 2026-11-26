import { ActionMenu } from '@/components/common/ActionMenu'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { TransientNotice } from '@/components/common/TransientNotice'
import { useTranslation } from '@/hooks/useTranslation'
import { zoomPercentToScaleFactor } from '@/lib/browser-zoom'
import {
  canUseEmbeddedBrowser,
  clearEmbeddedBrowserAnnotations,
  goBackEmbeddedBrowser,
  goForwardEmbeddedBrowser,
  readEmbeddedBrowserAnnotationState,
} from '@/lib/embedded-browser'
import { navigateTo } from '@/lib/navigation'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { cn } from '@/lib/utils'
import { deviceSurfaceExtension } from '@extensions/device-surface'
import { WorkbenchServicesContext } from '@/features/workbench/workbenchContexts'
import { useContext, useState } from 'react'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  EllipsisVertical,
  ExternalLink,
  Globe2,
  Loader2,
  MessageSquarePlus,
  Pause,
  Play,
  RotateCw,
  Trash2,
  X,
} from 'lucide-react'
import { BrowserFindBar } from './browser-find/BrowserFindBar'
import { BrowserAddressBar } from './BrowserAddressBar'
import { BrowserDownloads } from './BrowserDownloads'
import { BrowserDeviceToolbar } from './BrowserDeviceToolbar'
import { ElectronEmbeddedBrowserView } from './ElectronEmbeddedBrowserView'
import { WebsiteConnectionPanel } from './WebsiteConnectionPanel'
import { useWorkspaceBrowserPanelSession } from './useWorkspaceBrowserPanelSession'
import {
  BrowserToolbarButton,
  OriginalViewEye,
  OriginalViewEyeOff,
} from './workspaceBrowserPanelChrome'
import {
  getFallbackBrowserTitle,
  shouldShowAgentState,
  type BrowserStateUpdate,
  type WorkspaceBrowserPanelProps,
} from './workspaceBrowserSessionTypes'
export function WorkspaceBrowserTabPanel(props: WorkspaceBrowserPanelProps) {
  return (
    <WorkspaceBrowserSession
      key={JSON.stringify([
        props.label ?? 'workspace-browser',
        props.browserTabId ?? props.label ?? 'workspace-browser',
      ])}
      {...props}
    />
  )
}

const EMPTY_COMMENT_CONTEXTS: NonNullable<WorkspaceBrowserPanelProps['codeCommentContexts']> = []
function WorkspaceBrowserSession({
  active,
  hideToolbar = false,
  label = 'workspace-browser',
  transferFromLabel,
  transferredNativeLabel,
  transferredUrl,
  browserTabId = label,
  openRequest,
  codeCommentCount = 0,
  codeCommentContexts = EMPTY_COMMENT_CONTEXTS,
  browserAnnotationCommand,
  onAddCodeComment,
  onReplaceBrowserCodeComments,
  onRemoveBrowserCodeComments,
  onNativeLabelChange,
  onDownloadActivityChange,
  onFaviconChange,
  onLoadingChange,
  onTitleChange,
  onAgentActiveChange,
  onUrlChange,
}: WorkspaceBrowserPanelProps) {
  const { t } = useTranslation('common')
  const services = useContext(WorkbenchServicesContext)
  const [connectionPage, setConnectionPage] = useState<string | null>(null)
  const { state, source, browserPanelRef, bindPanel, bindHost, bindAddressInput } =
    useWorkspaceBrowserPanelSession({
      active,
      hideToolbar,
      label,
      transferFromLabel,
      transferredNativeLabel,
      transferredUrl,
      browserTabId,
      openRequest,
      codeCommentCount,
      codeCommentContexts,
      browserAnnotationCommand,
      onAddCodeComment,
      onReplaceBrowserCodeComments,
      onRemoveBrowserCodeComments,
      onNativeLabelChange,
      onDownloadActivityChange,
      onFaviconChange,
      onLoadingChange,
      onTitleChange,
      onAgentActiveChange,
      onUrlChange,
      t,
    })
  const {
    browserOcclusion,
    occlusionSnapshot,
    address,
    currentUrl,
    pageUrl,
    status,
    canGoBack,
    canGoForward,
    error,
    navigationError,
    annotationMode,
    annotations,
    annotationRevision,
    annotationRuntimeRevision,
    annotationOriginalView,
    discardDialogOpen,
    discardingAnnotations,
    originalViewHeld,
    downloads,
    downloadsOpen,
    downloadsError,
    downloadsLoading,
    downloadPeek,
    unreadDownloadCount,
    localFilePreviewToast,
    clearDataNotice,
    clearingDataKind,
    agentState,
    agentCursor,
    invalidTlsCertificate,
    zoomPercent,
    findOpen,
    findQuery,
    findResult,
    findUnavailable,
    deviceToolbar,
    deviceVisualRect,
  } = state
  const {
    exitAnnotationMode,
    applyAnnotationState,
    enterAnnotationMode,
    holdOriginalView,
    releaseOriginalView,
    cancelOriginalView,
    blurOriginalView,
    handleOriginalViewKeyDown,
    handleOriginalViewKeyUp,
    handleOcclusionSnapshotLoad,
    runBrowserCommand,
    submitAddress,
    handleReload,
    handleOpenExternal,
    clearBrowserData,
    setAgentControlPaused,
    resolveAgentApproval,
    agentStatusText,
    agentApprovalReason,
    clearLocalFilePreviewToast,
    clearClearDataNotice,
    openFindBar,
    closeFindBar,
    stepFind,
    changeBrowserZoom,
    toggleDeviceToolbar,
    handleDevicePresetChange,
    handleDeviceDimensionsChange,
    handleDeviceRotate,
    handleDeviceResizeStart,
    handleDeviceResizeMove,
    handleDeviceResizeEnd,
    handleBrowserKeyDown,
  } = source.actions
  const setAddress = (value: BrowserStateUpdate<'address'>) => source.set('address', value)
  const setError = (value: BrowserStateUpdate<'error'>) => source.set('error', value)
  const setDiscardDialogOpen = (value: BrowserStateUpdate<'discardDialogOpen'>) =>
    source.set('discardDialogOpen', value)
  const setDiscardingAnnotations = (value: BrowserStateUpdate<'discardingAnnotations'>) =>
    source.set('discardingAnnotations', value)
  const setOriginalViewHeld = (value: BrowserStateUpdate<'originalViewHeld'>) =>
    source.set('originalViewHeld', value)
  const setDownloadsOpen = (open: boolean) => {
    source.set('downloadPeek', null)
    source.set('downloadsOpen', open)
  }
  const setFindQuery = (value: BrowserStateUpdate<'findQuery'>) => source.set('findQuery', value)
  const electronRuntime = isElectronRuntime()
  const embeddedBrowserAvailable = canUseEmbeddedBrowser()
  const activePageUrl = pageUrl ?? currentUrl
  const internalExtensionPage = Boolean(
    activePageUrl && deviceSurfaceExtension.isInternalPageUrl(activePageUrl)
  )
  const embeddedBrowserOccluded =
    browserOcclusion.overlayIds.size > 0 ||
    (active && Boolean(currentUrl) && browserOcclusion.documentOverlayOccluded)
  const hasQueuedTweaks = annotations.some(annotation => annotation.designChanges.length > 0)
  const originalViewEnabled = annotationMode && hasQueuedTweaks && originalViewHeld
  const canUsePageFind = Boolean(activePageUrl) && !internalExtensionPage
  const connectablePage =
    activePageUrl && /^https?:\/\//i.test(activePageUrl) && !internalExtensionPage
      ? activePageUrl
      : null
  const hideDownloadsTrigger = hideToolbar || (annotationMode && !internalExtensionPage)
  const browserDownloads = (
    <BrowserDownloads
      active={active}
      hideTrigger={hideDownloadsTrigger}
      downloads={downloads}
      open={downloadsOpen}
      loading={downloadsLoading}
      loadError={downloadsError}
      onRetry={source.actions.refreshDownloads}
      unreadCount={unreadDownloadCount}
      peek={downloadPeek}
      onOpenChange={setDownloadsOpen}
      onDismissPeek={() => source.set('downloadPeek', null)}
      onAcknowledge={source.actions.markDownloadRead}
      onActionError={() => {
        if (downloadsOpen) void source.actions.refreshDownloads()
        source.set('localFilePreviewToast', {
          id: Date.now(),
          message: t('workbench.browser_download_action_failed'),
        })
      }}
    />
  )
  return (
    <div
      ref={bindPanel}
      data-testid="workspace-browser-panel"
      data-embedded-browser-label={label}
      data-browser-annotation-original-view={annotationOriginalView}
      data-browser-annotation-revision={annotationRevision}
      data-browser-annotation-runtime-revision={annotationRuntimeRevision}
      onKeyDown={handleBrowserKeyDown}
      className={cn(
        'relative flex h-full min-h-0 w-full flex-col bg-background text-text-primary',
        !active && 'hidden'
      )}
    >
      {annotationMode && !internalExtensionPage ? (
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-browser-annotation-border)] bg-[var(--color-browser-annotation-surface)] px-2 text-sm text-text-primary">
          <BrowserToolbarButton
            testId="workspace-browser-annotation-close-button"
            label={t('workbench.browser_annotation_close')}
            onClick={exitAnnotationMode}
          >
            <X className="h-4 w-4" />
          </BrowserToolbarButton>
          <BrowserToolbarButton
            testId="workspace-browser-annotation-clear-button"
            label={t('workbench.browser_annotation_clear')}
            disabled={annotations.length === 0 || discardingAnnotations}
            onClick={() => setDiscardDialogOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
          </BrowserToolbarButton>
          <div className="min-w-0 flex-1 truncate text-center font-medium">
            {originalViewEnabled
              ? t('workbench.browser_annotation_original_title', {
                  site: activePageUrl
                    ? getFallbackBrowserTitle(activePageUrl)
                    : t('workbench.browser'),
                })
              : t('workbench.browser_annotation_active', {
                  site: activePageUrl
                    ? getFallbackBrowserTitle(activePageUrl)
                    : t('workbench.browser'),
                })}
          </div>
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="workspace-browser-annotation-original-view-button"
            aria-pressed={originalViewEnabled}
            aria-label={t('workbench.browser_annotation_hold_to_view_original')}
            title={t('workbench.browser_annotation_hold_to_view_original')}
            disabled={!hasQueuedTweaks}
            onBlur={blurOriginalView}
            onKeyDown={handleOriginalViewKeyDown}
            onKeyUp={handleOriginalViewKeyUp}
            onPointerCancel={cancelOriginalView}
            onPointerDown={holdOriginalView}
            onPointerUp={releaseOriginalView}
            className="flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md px-2 text-text-secondary transition-colors hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45 aria-pressed:bg-muted aria-pressed:text-text-primary"
          >
            <span
              className={
                originalViewEnabled
                  ? 'inline-flex items-center justify-center transition-transform duration-200 motion-reduce:transition-none scale-[0.8]'
                  : 'inline-flex items-center justify-center transition-transform duration-200 motion-reduce:transition-none'
              }
            >
              {originalViewEnabled ? (
                <OriginalViewEyeOff className="h-4 w-4" />
              ) : (
                <OriginalViewEye className="h-4 w-4" />
              )}
            </span>
          </ControlButton>
          {annotations.length > 0 ? (
            <span
              data-testid="workspace-browser-annotation-count"
              className="rounded-md bg-[var(--color-browser-annotation-chip)] px-2 py-1 text-xs font-medium text-[rgb(var(--color-focus))]"
            >
              {t('workbench.browser_annotation_count', { count: annotations.length })}
            </span>
          ) : null}
        </div>
      ) : hideToolbar ? null : (
        <div className="relative flex h-11 shrink-0 items-center gap-1.5 border-b border-border bg-background px-2">
          <BrowserToolbarButton
            testId="workspace-browser-back-button"
            label={t('workbench.browser_back')}
            disabled={
              !currentUrl || !embeddedBrowserAvailable || !canGoBack || status === 'loading'
            }
            onClick={() => void runBrowserCommand(() => goBackEmbeddedBrowser(label))}
          >
            <ArrowLeft className="h-4 w-4" />
          </BrowserToolbarButton>
          <BrowserToolbarButton
            testId="workspace-browser-forward-button"
            label={t('workbench.browser_forward')}
            disabled={
              !currentUrl || !embeddedBrowserAvailable || !canGoForward || status === 'loading'
            }
            onClick={() => void runBrowserCommand(() => goForwardEmbeddedBrowser(label))}
          >
            <ArrowRight className="h-4 w-4" />
          </BrowserToolbarButton>
          <BrowserToolbarButton
            testId="workspace-browser-reload-button"
            label={t('workbench.browser_reload')}
            disabled={!activePageUrl || status === 'loading'}
            onClick={handleReload}
          >
            <RotateCw className="h-4 w-4" />
          </BrowserToolbarButton>
          <BrowserAddressBar
            active={active}
            address={address}
            historyAvailable={embeddedBrowserAvailable}
            inputRef={bindAddressInput}
            onChange={setAddress}
            onFocus={() => source.setAddressEditing(true)}
            onBlur={() => {
              source.setAddressEditing(false)
              const currentPageUrl = source.getPageUrl()
              if (currentPageUrl) setAddress(currentPageUrl)
            }}
            onNavigate={submitAddress}
          />
          {browserDownloads}
          <BrowserToolbarButton
            testId="workspace-browser-annotate-button"
            label={t('workbench.browser_annotation_start')}
            disabled={!activePageUrl || !embeddedBrowserAvailable || internalExtensionPage}
            onClick={() => void enterAnnotationMode()}
          >
            <MessageSquarePlus className="h-4 w-4" />
          </BrowserToolbarButton>
          <BrowserToolbarButton
            testId="workspace-browser-open-external-button"
            label={t('workbench.browser_open_external')}
            disabled={!activePageUrl || internalExtensionPage}
            onClick={handleOpenExternal}
          >
            <ExternalLink className="h-4 w-4" />
          </BrowserToolbarButton>
          {embeddedBrowserAvailable ? (
            <ActionMenu
              ariaLabel={t('workbench.browser_more_actions')}
              testId="workspace-browser-more-button"
              icon={EllipsisVertical}
              placement="bottom-end"
              width={240}
              itemClassName="min-h-9 px-2"
              density="compact"
              triggerClassName="flex shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
              items={[
                {
                  label: t('workbench.browser_find_in_page'),
                  testId: 'workspace-browser-find-item',
                  disabled: !canUsePageFind,
                  onSelect: openFindBar,
                },
                ...(electronRuntime && services?.standInApi
                  ? [
                      {
                        label: t('workbench.web_connection_title'),
                        testId: 'workspace-browser-connect-assistant',
                        disabled: !connectablePage || status === 'loading',
                        onSelect: () => setConnectionPage(connectablePage),
                      },
                    ]
                  : []),
                {
                  label: '',
                  testId: 'workspace-browser-more-separator-find',
                  separator: true,
                },
                {
                  label: deviceToolbar.isEnabled
                    ? t('workbench.browser_device_toolbar_hide')
                    : t('workbench.browser_device_toolbar_show'),
                  testId: 'workspace-browser-device-toolbar-item',
                  disabled: !activePageUrl || internalExtensionPage,
                  onSelect: toggleDeviceToolbar,
                },
                {
                  label: '',
                  testId: 'workspace-browser-more-separator-actions',
                  separator: true,
                },
                {
                  label: t('workbench.browser_downloads'),
                  testId: 'workspace-browser-downloads-item',
                  onSelect: () => setDownloadsOpen(true),
                },
                {
                  label: t('workbench.browser_history'),
                  testId: 'workspace-browser-history-item',
                  onSelect: () => navigateTo('/settings/browser/history'),
                },
                {
                  label: t('workbench.browser_clear_data'),
                  testId: 'workspace-browser-clear-data-item',
                  disabled: Boolean(clearingDataKind),
                  children: [
                    {
                      label: t('workbench.browser_clear_cookies'),
                      testId: 'workspace-browser-clear-cookies-item',
                      disabled: Boolean(clearingDataKind),
                      onSelect: () => clearBrowserData(['cookies']),
                    },
                    {
                      label: t('workbench.browser_clear_cache'),
                      testId: 'workspace-browser-clear-cache-item',
                      disabled: Boolean(clearingDataKind),
                      onSelect: () => clearBrowserData(['cache', 'storage']),
                    },
                  ],
                },
                {
                  label: '',
                  testId: 'workspace-browser-more-separator-data',
                  separator: true,
                },
                {
                  label: t('workbench.browser_settings'),
                  testId: 'workspace-browser-settings-item',
                  onSelect: () => navigateTo('/settings/browser'),
                },
              ]}
            />
          ) : null}
        </div>
      )}
      {connectionPage && services && (
        <WebsiteConnectionPanel
          key={connectionPage}
          label={label}
          url={connectionPage}
          services={services}
          onClose={() => setConnectionPage(null)}
        />
      )}
      {findOpen && (!annotationMode || internalExtensionPage) ? (
        <BrowserFindBar
          query={findQuery}
          result={findResult}
          unavailable={findUnavailable}
          onQueryChange={setFindQuery}
          onStep={stepFind}
          onClose={closeFindBar}
        />
      ) : null}
      {deviceToolbar.isEnabled && (!annotationMode || internalExtensionPage) ? (
        <BrowserDeviceToolbar
          state={deviceToolbar}
          zoomPercent={zoomPercent}
          onPresetChange={handleDevicePresetChange}
          onDimensionsChange={handleDeviceDimensionsChange}
          onRotate={handleDeviceRotate}
          onZoomPercentChange={changeBrowserZoom}
          onClose={toggleDeviceToolbar}
        />
      ) : null}
      <ConfirmDialog
        open={discardDialogOpen}
        title={t('workbench.browser_annotation_discard_title')}
        description={t('workbench.browser_annotation_discard_description')}
        cancelLabel={t('workbench.cancel')}
        confirmLabel={t('workbench.browser_annotation_discard_confirm')}
        confirmTestId="workspace-browser-annotation-discard-confirm-button"
        destructive
        pending={discardingAnnotations}
        onClose={() => setDiscardDialogOpen(false)}
        onConfirm={() => {
          setDiscardingAnnotations(true)
          void clearEmbeddedBrowserAnnotations(label)
            .then(() => readEmbeddedBrowserAnnotationState(label))
            .then(state => {
              if (!applyAnnotationState(state)) return
              setOriginalViewHeld(false)
              if (state.scope) {
                onRemoveBrowserCodeComments?.({ ...state.scope, browserTabId })
              }
              setDiscardDialogOpen(false)
            })
            .catch(error => {
              console.error('Failed to clear embedded browser annotations:', error)
              setError(t('workbench.browser_annotation_clear_failed'))
            })
            .finally(() => setDiscardingAnnotations(false))
        }}
      />
      {shouldShowAgentState(agentState) ? (
        <div
          data-testid="workspace-browser-agent-status"
          className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 text-xs text-text-secondary"
        >
          {agentState?.status === 'paused' ? (
            <Pause className="h-3.5 w-3.5 shrink-0 text-text-muted" />
          ) : (
            <CircleAlert className="h-3.5 w-3.5 shrink-0 text-warning wework:text-amber-600" />
          )}
          <span className="min-w-0 flex-1 truncate">
            {agentState ? agentStatusText(agentState) : null}
            {agentState?.approval ? (
              <span className="ml-1 text-text-muted">{agentApprovalReason(agentState)}</span>
            ) : null}
          </span>
          {agentState?.approval ? (
            <>
              <ControlButton
                variant="outline"
                size="sm"
                type="button"
                data-testid="workspace-browser-agent-approval-approve-button"
                data-approval-id={agentState.approval.approvalId}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 font-medium text-text-primary hover:bg-muted"
                onClick={() => resolveAgentApproval(agentState.approval?.approvalId || '', true)}
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                {t('workbench.browser_agent_approval_continue')}
              </ControlButton>
              <ControlButton
                variant="outline"
                size="sm"
                type="button"
                data-testid="workspace-browser-agent-approval-reject-button"
                data-approval-id={agentState.approval.approvalId}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 font-medium text-text-primary hover:bg-muted"
                onClick={() => resolveAgentApproval(agentState.approval?.approvalId || '', false)}
              >
                <X className="h-3.5 w-3.5" />
                {t('workbench.browser_agent_approval_cancel')}
              </ControlButton>
            </>
          ) : agentState?.status === 'paused' ? (
            <ControlButton
              variant="outline"
              size="sm"
              type="button"
              data-testid="workspace-browser-agent-resume-button"
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 font-medium text-text-primary hover:bg-muted"
              onClick={() => setAgentControlPaused(false)}
            >
              <Play className="h-3.5 w-3.5" />
              {t('workbench.browser_agent_resume')}
            </ControlButton>
          ) : null}
        </div>
      ) : null}
      {hideDownloadsTrigger ? browserDownloads : null}
      <TransientNotice
        key={localFilePreviewToast?.id ?? 'workspace-browser-local-file-toast'}
        message={localFilePreviewToast?.message ?? null}
        tone="error"
        onClear={clearLocalFilePreviewToast}
        horizontalAnchorRef={browserPanelRef}
        visible={active}
      />
      <TransientNotice
        key={clearDataNotice?.id ?? 'workspace-browser-clear-data-toast'}
        message={clearDataNotice?.message ?? null}
        tone={clearDataNotice?.tone}
        onClear={clearClearDataNotice}
        horizontalAnchorRef={browserPanelRef}
        visible={active}
      />
      {invalidTlsCertificate ? (
        <div
          data-testid="workspace-browser-invalid-tls-warning"
          role="status"
          className="flex shrink-0 items-start gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2 text-sm text-text-primary wework:border-amber-500/30 wework:bg-amber-500/10"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning wework:text-amber-600" />
          <div className="min-w-0">
            <p className="font-medium">{t('workbench.browser_invalid_tls_title')}</p>
            <p className="mt-0.5 text-xs text-text-secondary">
              {t('workbench.browser_invalid_tls_desc', {
                host: invalidTlsCertificate.host,
              })}
            </p>
          </div>
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-background pl-1">
        {!currentUrl && (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <Globe2 className="mb-4 h-8 w-8 text-text-muted" />
            <p className="text-sm font-semibold text-text-primary">
              {t('workbench.browser_empty_title')}
            </p>
            <p className="mt-2 text-sm leading-[18px] text-text-secondary">
              {t('workbench.browser_empty_desc')}
            </p>
          </div>
        )}
        {currentUrl && !embeddedBrowserAvailable && (
          <iframe
            key={currentUrl}
            data-testid="workspace-browser-frame"
            title={t('workbench.browser')}
            src={currentUrl}
            className="h-full w-full border-0 bg-background"
          />
        )}
        {currentUrl && embeddedBrowserAvailable && (
          <div
            ref={bindHost}
            data-testid="workspace-browser-native-view"
            className={cn(
              'relative h-full min-h-0 w-full overflow-hidden',
              deviceToolbar.isEnabled ? 'bg-muted wework:bg-neutral-700' : 'bg-background'
            )}
            aria-label={t('workbench.browser')}
          >
            {electronRuntime ? (
              <ElectronEmbeddedBrowserView
                active={active}
                cursor={agentCursor}
                cursorScale={
                  deviceToolbar.isEnabled
                    ? (deviceVisualRect ? deviceVisualRect.width / deviceToolbar.width : 1) *
                      zoomPercentToScaleFactor(zoomPercent)
                    : zoomPercentToScaleFactor(zoomPercent)
                }
                interactionBlocked={embeddedBrowserOccluded || Boolean(navigationError)}
                label={label}
                transferFromLabel={transferFromLabel}
                visualRect={deviceVisualRect}
              />
            ) : active &&
              embeddedBrowserOccluded &&
              occlusionSnapshot?.generation === browserOcclusion.generation ? (
              <img
                data-testid="workspace-browser-occlusion-snapshot"
                src={occlusionSnapshot.url}
                alt=""
                onLoad={() => handleOcclusionSnapshotLoad(occlusionSnapshot.generation)}
                style={
                  deviceVisualRect
                    ? {
                        left: deviceVisualRect.x,
                        top: deviceVisualRect.y,
                        width: deviceVisualRect.width,
                        height: deviceVisualRect.height,
                      }
                    : undefined
                }
                className={cn(
                  'pointer-events-none absolute bg-background object-fill',
                  deviceVisualRect ? '' : 'inset-0 h-full w-full'
                )}
              />
            ) : null}
            {navigationError ? (
              <div
                data-testid="workspace-browser-navigation-error"
                role="alert"
                className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center"
              >
                <CircleAlert className="mb-4 h-7 w-7 text-text-muted" />
                <p className="text-sm font-medium text-text-primary">
                  {t('workbench.browser_navigation_failed_title')}
                </p>
                <p className="mt-2 max-w-md text-sm leading-[18px] text-text-secondary">
                  {t('workbench.browser_navigation_failed_desc')}
                </p>
              </div>
            ) : null}
            {status === 'loading' && !navigationError && (
              <div
                data-testid="workspace-browser-loading"
                className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/40"
              >
                <Loader2 className="h-5 w-5 animate-spin text-text-secondary" />
              </div>
            )}
            {deviceToolbar.isEnabled && deviceVisualRect
              ? [
                  { edge: 'left' as const, cursor: 'ew-resize' },
                  { edge: 'right' as const, cursor: 'ew-resize' },
                  { edge: 'bottom' as const, cursor: 'ns-resize' },
                  { edge: 'bottom-left' as const, cursor: 'nesw-resize' },
                  { edge: 'bottom-right' as const, cursor: 'nwse-resize' },
                ].map(handle => {
                  const rect = deviceVisualRect
                  // Handles sit 20px outside the device viewport, as in Codex.
                  const thickness = 20
                  const style =
                    handle.edge === 'left'
                      ? {
                          left: rect.x - thickness,
                          top: rect.y,
                          width: thickness,
                          height: rect.height,
                        }
                      : handle.edge === 'right'
                        ? {
                            left: rect.x + rect.width,
                            top: rect.y,
                            width: thickness,
                            height: rect.height,
                          }
                        : handle.edge === 'bottom'
                          ? {
                              left: rect.x - thickness,
                              top: rect.y + rect.height,
                              width: rect.width + thickness * 2,
                              height: thickness,
                            }
                          : handle.edge === 'bottom-left'
                            ? {
                                left: rect.x - thickness,
                                top: rect.y + rect.height,
                                width: thickness,
                                height: thickness,
                              }
                            : {
                                left: rect.x + rect.width,
                                top: rect.y + rect.height,
                                width: thickness,
                                height: thickness,
                              }
                  const left = 'left' in style ? (style.left ?? 0) : 0
                  const top = 'top' in style ? (style.top ?? 0) : 0
                  if (
                    left < 0 ||
                    top < 0 ||
                    left + style.width > rect.hostWidth ||
                    top + style.height > rect.hostHeight
                  ) {
                    return null
                  }
                  return (
                    <div
                      key={handle.edge}
                      data-testid={`workspace-browser-device-resize-${handle.edge}`}
                      data-edge={handle.edge}
                      aria-hidden="true"
                      className="absolute z-30"
                      style={{ ...style, cursor: handle.cursor, touchAction: 'none' }}
                      onPointerDown={handleDeviceResizeStart}
                      onPointerMove={handleDeviceResizeMove}
                      onPointerUp={handleDeviceResizeEnd}
                      onPointerCancel={handleDeviceResizeEnd}
                    />
                  )
                })
              : null}
          </div>
        )}
        {error && (
          <div
            data-testid="workspace-browser-error"
            role="alert"
            className="absolute inset-x-4 top-4 rounded-md border border-destructive/30 bg-background px-3 py-2 text-sm text-destructive shadow-sm wework:border-red-500/30 wework:text-red-500"
          >
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
export const WorkspaceBrowserPanel = WorkspaceBrowserTabPanel

export type { WorkspaceBrowserPanelProps } from './workspaceBrowserSessionTypes'
