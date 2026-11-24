import type { KeyboardEvent, PointerEvent } from 'react'
import {
  clearEmbeddedBrowserData,
  evalEmbeddedBrowserJson,
  resolveEmbeddedBrowserAgentApproval,
  setEmbeddedBrowserAgentControlPaused,
  type EmbeddedBrowserDataKind,
} from '@/lib/embedded-browser'
import { BROWSER_ZOOM_DEFAULT_PERCENT } from '@/lib/browser-zoom'
import {
  clampDeviceDimension,
  matchDevicePresetId,
  resizeDeviceDimensions,
  resolveDevicePreset,
  BROWSER_DEVICE_MIN_HEIGHT,
  BROWSER_DEVICE_MIN_WIDTH,
  type BrowserDeviceResizeEdge,
  type BrowserDeviceToolbarState,
} from '@/lib/browser-device-toolbar'
import {
  clearEmbeddedBrowserFind,
  searchEmbeddedBrowserPage,
  stepEmbeddedBrowserFind,
} from './browser-find/browser-find-store'
import type { BrowserSessionModel } from './workspaceBrowserSessionTypes'
import {
  BROWSER_CLEAR_STARTED_NOTICE_MIN_MS,
  type BrowserAgentState,
} from './workspaceBrowserSessionTypes'
export function createBrowserActions(model: BrowserSessionModel) {
  const clearBrowserData = async (kinds: EmbeddedBrowserDataKind[]): Promise<void> => {
    if (model.state.clearingDataKind) return
    model.set('clearingDataKind', kinds[0] ?? null)
    model.set('clearDataNotice', {
      id: Date.now(),
      message: model.options.t('workbench.browser_clear_started'),
      tone: 'success',
    })
    await new Promise<void>(resolve =>
      window.setTimeout(resolve, BROWSER_CLEAR_STARTED_NOTICE_MIN_MS)
    )
    try {
      await clearEmbeddedBrowserData(kinds)
      model.set('clearDataNotice', {
        id: Date.now(),
        message: model.options.t('workbench.browser_clear_completed'),
        tone: 'success',
      })
    } catch (error) {
      console.error('Failed to clear embedded browser data:', error)
      model.set('clearDataNotice', {
        id: Date.now(),
        message: model.options.t('workbench.browser_clear_failed'),
        tone: 'error',
      })
    } finally {
      model.set('clearingDataKind', null)
    }
  }
  const setAgentControlPaused = (paused: boolean): void => {
    void setEmbeddedBrowserAgentControlPaused(paused, model.options.label).catch(error => {
      console.error('Failed to update embedded browser agent control:', error)
    })
  }
  const resolveAgentApproval = (approvalId: string, approved: boolean): void => {
    void resolveEmbeddedBrowserAgentApproval(approvalId, approved, model.options.label).catch(
      error => {
        console.error('Failed to resolve embedded browser agent approval:', error)
      }
    )
  }
  const agentActionLabel = (action: string | null): string => {
    switch (action) {
      case 'open':
      case 'navigate':
        return model.options.t('workbench.browser_agent_action_open')
      case 'inspect':
        return model.options.t('workbench.browser_agent_action_inspect')
      case 'waitFor':
        return model.options.t('workbench.browser_agent_action_wait')
      case 'click':
        return model.options.t('workbench.browser_agent_action_click')
      case 'typeText':
      case 'fill':
        return model.options.t('workbench.browser_agent_action_fill')
      case 'hover':
        return model.options.t('workbench.browser_agent_action_hover')
      case 'press':
        return model.options.t('workbench.browser_agent_action_press')
      case 'scroll':
      case 'scrollIntoView':
        return model.options.t('workbench.browser_agent_action_scroll')
      case 'screenshot':
        return model.options.t('workbench.browser_agent_action_screenshot')
      default:
        return model.options.t('workbench.browser_agent_action_generic')
    }
  }
  const agentStatusText = (state: BrowserAgentState): string => {
    if (state.status === 'error') {
      return model.options.t('workbench.browser_agent_error')
    }
    if (
      state.status === 'needs_user' &&
      state.approval &&
      state.errorCode &&
      state.errorCode !== 'approval_required'
    ) {
      return model.options.t('workbench.browser_agent_needs_user')
    }
    if (state.approval) {
      return model.options.t('workbench.browser_agent_approval_required', {
        action: model.actions.agentActionLabel(state.action || state.approval.actionKind),
      })
    }
    if (state.status === 'running') {
      return model.options.t('workbench.browser_agent_running', {
        action: model.actions.agentActionLabel(state.action),
      })
    }
    if (state.status === 'paused') {
      return model.options.t('workbench.browser_agent_paused')
    }
    if (state.status === 'needs_user') {
      switch (state.errorCode) {
        case 'approval_expired':
          return model.options.t('workbench.browser_agent_approval_expired')
        case 'approval_rejected':
        case 'approval_cancelled':
          return model.options.t('workbench.browser_agent_approval_stopped')
        case 'wait_timeout':
          return model.options.t('workbench.browser_agent_wait_timeout')
        default:
          return model.options.t('workbench.browser_agent_error')
      }
    }
    return model.options.t('workbench.browser_agent_ready')
  }
  const agentApprovalReason = (state: BrowserAgentState): string | null => {
    if (!state.approval) return null
    return (
      state.approval.reason ||
      state.message ||
      model.options.t('workbench.browser_agent_approval_reason')
    )
  }
  const clearLocalFilePreviewToast = (): void => model.set('localFilePreviewToast', null)
  const clearClearDataNotice = (): void => model.set('clearDataNotice', null)
  const runFindSearch = (query: string): void => {
    const request = ++model.runtime.findRequestSequence
    if (!query) {
      model.set('findResult', null)
      model.set('findUnavailable', false)
      void clearEmbeddedBrowserFind(model.options.label)
      return
    }
    void searchEmbeddedBrowserPage(query, model.options.label)
      .then(state => {
        if (model.runtime.findRequestSequence !== request) return
        model.set('findResult', state)
        model.set('findUnavailable', state === null)
      })
      .catch(() => {
        if (model.runtime.findRequestSequence !== request) return
        model.set('findResult', null)
        model.set('findUnavailable', true)
      })
  }
  const openFindBar = (): void => {
    model.set('findOpen', true)
    if (!model.runtime.nativeBrowserOpen) return
    // Mirror Codex: prefill the find query with the current page selection.
    void evalEmbeddedBrowserJson<string | null>(
      'window.getSelection()?.toString()?.trim() || null',
      model.options.label
    )
      .then(selection => {
        if (typeof selection === 'string' && selection && !/[\r\n]/.test(selection)) {
          model.set('findQuery', selection)
        }
      })
      .catch(() => undefined)
  }
  const closeFindBar = (): void => {
    model.runtime.findRequestSequence += 1
    model.set('findOpen', false)
    model.set('findQuery', '')
    model.set('findResult', null)
    model.set('findUnavailable', false)
    void clearEmbeddedBrowserFind(model.options.label)
  }
  const stepFind = (direction: 1 | -1): void => {
    if (!model.state.findQuery) return
    void stepEmbeddedBrowserFind(direction, model.options.label)
      .then(state => {
        if (state) model.set('findResult', state)
      })
      .catch(() => undefined)
  }
  const changeBrowserZoom = (nextPercent: number): void => {
    model.set('zoomPercent', nextPercent)
    // The bounds sync applies the correct combined zoom (page zoom alone,
    // or folded into the device viewport fit scale).
    model.actions.scheduleEmbeddedBrowserBoundsSync(model.options.active)
  }
  const updateDeviceToolbar = (patch: Partial<BrowserDeviceToolbarState>): void => {
    model.set('deviceToolbar', current => {
      const next = { ...current, ...patch }
      return next
    })
    model.actions.scheduleEmbeddedBrowserBoundsSync(model.options.active)
  }
  const toggleDeviceToolbar = (): void => {
    model.actions.updateDeviceToolbar({ isEnabled: !model.state.deviceToolbar.isEnabled })
  }
  const handleDevicePresetChange = (presetId: string): void => {
    const preset = resolveDevicePreset(presetId)
    if (!preset) return
    model.set('zoomPercent', BROWSER_ZOOM_DEFAULT_PERCENT)
    model.actions.updateDeviceToolbar({ presetId, width: preset.width, height: preset.height })
  }
  const handleDeviceDimensionsChange = (width: number, height: number): void => {
    const nextWidth = clampDeviceDimension(width, BROWSER_DEVICE_MIN_WIDTH)
    const nextHeight = clampDeviceDimension(height, BROWSER_DEVICE_MIN_HEIGHT)
    model.actions.updateDeviceToolbar({
      width: nextWidth,
      height: nextHeight,
      presetId: matchDevicePresetId(nextWidth, nextHeight),
    })
  }
  const handleDeviceRotate = (): void => {
    const current = model.state.deviceToolbar
    model.actions.updateDeviceToolbar({ width: current.height, height: current.width })
  }
  const handleDeviceResizeStart = (event: PointerEvent<HTMLDivElement>): void => {
    const edge = event.currentTarget.dataset.edge as BrowserDeviceResizeEdge
    if (!edge) return
    event.preventDefault()
    event.stopPropagation()
    const current = model.state.deviceToolbar
    model.runtime.deviceResizeState = {
      pointerId: event.pointerId,
      edge,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: current.width,
      startHeight: current.height,
    }
    if (event.nativeEvent.isTrusted) {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
  }
  const handleDeviceResizeMove = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = model.runtime.deviceResizeState
    if (!drag || drag.pointerId !== event.pointerId) return
    const next = resizeDeviceDimensions(
      drag.edge,
      drag.startWidth,
      drag.startHeight,
      event.clientX - drag.startX,
      event.clientY - drag.startY,
      model.runtime.deviceFitScale
    )
    model.actions.handleDeviceDimensionsChange(next.width, next.height)
  }
  const handleDeviceResizeEnd = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = model.runtime.deviceResizeState
    if (!drag || drag.pointerId !== event.pointerId) return
    model.runtime.deviceResizeState = null
    if (event.nativeEvent.isTrusted && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }
  const handleBrowserKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!(event.metaKey || event.ctrlKey)) return
    if (event.key.toLowerCase() !== 'f') return
    if (model.canUsePageFind && model.embeddedBrowserAvailable) {
      event.preventDefault()
      model.actions.openFindBar()
    }
  }
  return {
    clearBrowserData,
    setAgentControlPaused,
    resolveAgentApproval,
    agentActionLabel,
    agentStatusText,
    agentApprovalReason,
    clearLocalFilePreviewToast,
    clearClearDataNotice,
    runFindSearch,
    openFindBar,
    closeFindBar,
    stepFind,
    changeBrowserZoom,
    updateDeviceToolbar,
    toggleDeviceToolbar,
    handleDevicePresetChange,
    handleDeviceDimensionsChange,
    handleDeviceRotate,
    handleDeviceResizeStart,
    handleDeviceResizeMove,
    handleDeviceResizeEnd,
    handleBrowserKeyDown,
  }
}
