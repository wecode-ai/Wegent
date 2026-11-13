const requestedSlowAfterMs = Number(new URLSearchParams(window.location.search).get('slowAfterMs'))
const SLOW_AFTER_MS =
  Number.isInteger(requestedSlowAfterMs) && requestedSlowAfterMs > 0 ? requestedSlowAfterMs : 30_000
const DEFAULT_STAGE_TIMEOUT_MS = 60_000

const FALLBACK_UPDATE = {
  index: 0,
  total: 0,
  completedWeight: 0,
  startedAt: Date.now(),
  stage: {
    id: 'launch',
    label: { en: 'Starting Wework', zh: '启动应用' },
    detail: {
      en: 'Preparing the local environment…',
      zh: '正在准备本地环境…',
    },
    weight: 5,
    expectedMs: 10_000,
    timeoutMs: DEFAULT_STAGE_TIMEOUT_MS,
  },
}

const splashRoot = document.querySelector('#splash-root')
const titleElement = document.querySelector('#splash-title')
const percentageElement = document.querySelector('#splash-percentage')
const stepCountElement = document.querySelector('#splash-step-count')
const elapsedElement = document.querySelector('#splash-elapsed')
const progressElement = document.querySelector('#splash-progress')
const progressSvg = document.querySelector('.startup-progress-svg')
const progressTrackElement = document.querySelector('#splash-progress-track')
const progressFillElement = document.querySelector('#splash-progress-fill')
const progressGradient = document.querySelector('#startup-progress-gradient')
const activityElement = document.querySelector('#splash-activity')
const slowElement = document.querySelector('#startup-slow')
const slowTitleElement = document.querySelector('#startup-slow-title')
const slowDetailElement = document.querySelector('#startup-slow-detail')
const timeoutElement = document.querySelector('#startup-timeout')
const timeoutTitleElement = document.querySelector('#startup-timeout-title')
const timeoutDetailElement = document.querySelector('#startup-timeout-detail')
const failureElement = document.querySelector('#startup-failure')
const failureTitleElement = document.querySelector('#startup-failure-title')
const failureDetailElement = document.querySelector('#startup-failure-detail')
const recoveryElement = document.querySelector('#startup-recovery')
const timeoutActionsElement = document.querySelector('#startup-timeout-actions')
const disablePluginButton = document.querySelector('#startup-disable-plugin')
const retryButton = document.querySelector('#startup-retry')
const recoverButton = document.querySelector('#startup-recover')
const resetOpenButton = document.querySelector('#startup-reset-open')
const copyDiagnosticsButton = document.querySelector('#startup-copy-diagnostics')
const openLogsButton = document.querySelector('#startup-open-logs')
const timeoutCopyButton = document.querySelector('#startup-timeout-copy')
const timeoutOpenLogsButton = document.querySelector('#startup-timeout-open-logs')
const actionErrorElement = document.querySelector('#startup-action-error')
const toastElement = document.querySelector('#startup-toast')
const confirmationElement = document.querySelector('#startup-confirmation')
const confirmationTitle = document.querySelector('#startup-confirmation-title')
const confirmationDescription = document.querySelector('#startup-confirmation-description')
const confirmationCancel = document.querySelector('#startup-confirmation-cancel')
const confirmationSubmit = document.querySelector('#startup-confirmation-submit')
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')
const brandAnimation = window.createStartupBrandAnimation(
  document.querySelector('#startup-brand-canvas'),
  document.querySelector('#startup-status'),
  [[slowElement], [timeoutElement, timeoutActionsElement]]
)
const isChinese = navigator.language.toLowerCase().startsWith('zh')

document.documentElement.lang = isChinese ? 'zh-CN' : 'en'

let currentUpdate = FALLBACK_UPDATE
const splashStartedAt = Date.now()
let slowActive = false
let timeoutActive = false
let startupFailed = false
let failedPluginName = null
let pendingResetMode = null
let actionPending = false
let confirmationTrigger = null
let toastTimer = 0
let toastSequence = 0
let progressTimer = 0
let progressFrame = null
let displayedProgress = 0
let progressRenderedAt = performance.now()
let completionPromise = null
let completionController = null
let disposed = false

function localized(copy) {
  return copy ? (isChinese ? copy.zh : copy.en) : ''
}

function formatSeconds(milliseconds) {
  const seconds = Math.max(0, milliseconds) / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  return `${Math.floor(seconds / 60)}m ${String(Math.floor(seconds % 60)).padStart(2, '0')}s`
}

function stageElapsedMs(now) {
  const startedAt = Number.isFinite(currentUpdate.startedAt) ? currentUpdate.startedAt : Date.now()
  return Math.max(0, now - startedAt)
}

function stageTimeoutMs() {
  const configured = currentUpdate.stage.timeoutMs
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STAGE_TIMEOUT_MS
}

function computeProgress(now) {
  const stage = currentUpdate.stage
  const expectedMs =
    Number.isFinite(stage.expectedMs) && stage.expectedMs > 0 ? stage.expectedMs : 1_000
  const ratio = stageElapsedMs(now) / expectedMs
  const fraction = Math.min(0.92, 1 - Math.exp(-2.2 * ratio))
  return Math.min(100, currentUpdate.completedWeight + fraction * stage.weight)
}

function shortenPath(path, maxLength = 48) {
  const normalized = String(path).replace(/\\/g, '/')
  if (normalized.length <= maxLength) return normalized
  const segments = normalized.split('/').filter(Boolean)
  let shortened = segments.at(-1) ?? normalized
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const candidate = `${segments[index]}/${shortened}`
    if (candidate.length + 2 > maxLength) break
    shortened = candidate
  }
  if (shortened.length > maxLength) return `…${shortened.slice(1 - maxLength)}`
  return `…/${shortened}`
}

function activityText(maxLength = 48) {
  const activity = currentUpdate.activity
  if (activity && typeof activity.path === 'string' && activity.path.trim()) {
    const verb =
      activity.kind === 'unpack'
        ? isChinese
          ? '解压'
          : 'Unpacking'
        : activity.kind === 'migrate'
          ? isChinese
            ? '迁移'
            : 'Migrating'
          : activity.kind === 'load'
            ? isChinese
              ? '加载'
              : 'Loading'
            : isChinese
              ? '扫描'
              : 'Scanning'
    return `${verb} ${shortenPath(activity.path, maxLength)}`
  }
  return localized(currentUpdate.stage.detail)
}

function animateSwap(element) {
  if (motionPreference.matches || typeof element?.animate !== 'function') return
  element.animate(
    [
      { opacity: 0, transform: 'translateY(2px)' },
      { opacity: 1, transform: 'none' },
    ],
    { duration: 180, easing: 'ease-out' }
  )
}

function setText(element, text) {
  if (!element || element.textContent === text) return false
  element.textContent = text
  return true
}

function showToast(message) {
  if (!toastElement) return
  if (toastTimer) window.clearTimeout?.(toastTimer)
  toastElement.textContent = message
  toastElement.dataset.sequence = String(++toastSequence)
  toastElement.hidden = false
  toastTimer = window.setTimeout(() => {
    toastElement.hidden = true
  }, 2200)
}

async function copyStartupDiagnostics() {
  const diagnostics = window.weworkStartupDiagnostics
  if (!diagnostics || typeof diagnostics.copy !== 'function') {
    showToast(isChinese ? '诊断信息暂不可用' : 'Diagnostics are unavailable')
    return
  }
  try {
    await diagnostics.copy()
    showToast(
      isChinese
        ? '诊断信息已复制，可直接发给技术支持'
        : 'Diagnostics copied — share it with support'
    )
  } catch {
    showToast(isChinese ? '复制失败，请重试' : 'Could not copy diagnostics')
  }
}

async function openStartupLogs() {
  const diagnostics = window.weworkStartupDiagnostics
  if (!diagnostics || typeof diagnostics.openLogs !== 'function') {
    showToast(isChinese ? '日志目录暂不可用' : 'The log folder is unavailable')
    return
  }
  try {
    await diagnostics.openLogs()
  } catch {
    showToast(isChinese ? '无法打开日志目录' : 'Could not open the log folder')
  }
}

function renderCopy() {
  let title

  if (startupFailed) {
    title = isChinese ? 'Wework 启动失败' : 'Wework could not start'
  } else if (slowActive) {
    title = isChinese ? '启动比预期慢' : 'Startup is taking longer than expected'
  } else {
    title = isChinese ? '正在准备工作台' : "We're preparing your workbench"
  }

  if (setText(titleElement, title)) animateSwap(titleElement)
  splashRoot.setAttribute('aria-label', isChinese ? 'Wework 正在启动' : 'Wework is starting')
}

function renderNotes() {
  slowElement.hidden = !slowActive || timeoutActive || startupFailed
  timeoutElement.hidden = !timeoutActive || startupFailed
  timeoutActionsElement.hidden = !timeoutActive || startupFailed
  failureElement.hidden = !startupFailed
  const showRecovery = startupFailed
  recoveryElement.hidden = !showRecovery
}

function renderMeta(now) {
  const total = currentUpdate.total
  const stageLabel = localized(currentUpdate.stage.label)
  setText(
    stepCountElement,
    total > 1
      ? isChinese
        ? `第 ${currentUpdate.index + 1} 步，共 ${total} 步 · ${stageLabel}`
        : `Step ${currentUpdate.index + 1} of ${total} · ${stageLabel}`
      : isChinese
        ? '正在启动'
        : 'Starting'
  )
  setText(elapsedElement, formatSeconds(stageElapsedMs(now)))
}

function renderActivity() {
  setText(activityElement, activityText())
  activityElement.title = activityText(Number.POSITIVE_INFINITY)
}

function renderProgress(now) {
  const renderedAt = performance.now()
  if (!completionPromise && !startupFailed) {
    const target = Math.max(displayedProgress, computeProgress(now))
    const elapsed = Math.max(0, renderedAt - progressRenderedAt)
    const fraction = motionPreference.matches ? 1 : 1 - Math.exp(-elapsed / 100)
    const next = displayedProgress + (target - displayedProgress) * fraction
    // Settle subpixel differences so an integer target also settles its visible percentage.
    displayedProgress = target - next < 0.001 ? target : next
  }
  progressRenderedAt = renderedAt
  paintProgress()
  progressElement.classList.toggle('is-running', !startupFailed)
  progressElement.classList.toggle('is-failed', startupFailed)
}

function paintProgress() {
  const width = progressSvg.clientWidth
  if (width > 0) {
    const fillEnd = (width * displayedProgress) / 100
    progressTrackElement.setAttribute('x2', String(width))
    progressFillElement.setAttribute('x2', String(fillEnd))
    progressFillElement.setAttribute('visibility', displayedProgress > 0 ? 'visible' : 'hidden')
    progressGradient.setAttribute('x2', String(fillEnd))
  }
  progressElement.setAttribute('aria-valuenow', String(Math.round(displayedProgress)))
  setText(percentageElement, `${Math.floor(displayedProgress)}%`)
}

function animateProgress() {
  progressFrame = null
  if (disposed || startupFailed || completionPromise || motionPreference.matches) return
  renderProgress(Date.now())
  progressFrame = window.requestAnimationFrame(animateProgress)
}

function stopProgressUpdates() {
  window.clearInterval(progressTimer)
  progressTimer = 0
  if (progressFrame !== null) window.cancelAnimationFrame(progressFrame)
  progressFrame = null
}

function renderStates(now) {
  if (completionPromise && !startupFailed) return
  const elapsed = stageElapsedMs(now)
  const startupElapsed = Math.max(0, now - splashStartedAt)
  slowActive = !startupFailed && (startupElapsed >= SLOW_AFTER_MS || elapsed >= SLOW_AFTER_MS)
  timeoutActive = !startupFailed && elapsed >= stageTimeoutMs()
  renderCopy()
  renderMeta(now)
  renderActivity()
  renderNotes()
  renderProgress(now)
  brandAnimation.setPaused(startupFailed || !confirmationElement.hidden)
  if (!startupFailed && !motionPreference.matches && progressFrame === null) {
    progressFrame = window.requestAnimationFrame(animateProgress)
  }
}

function tick() {
  renderStates(Date.now())
}

function applyUpdate(update) {
  if (
    !update ||
    typeof update !== 'object' ||
    !update.stage ||
    !Number.isFinite(update.index) ||
    !Number.isFinite(update.total)
  ) {
    return
  }
  if (update.completed === true) {
    void completeStartup(update).catch(error => {
      console.error('[startup] Could not complete the splash handoff', error)
    })
    return
  }
  if (completionPromise) return
  const stageChanged = currentUpdate.stage?.id !== update.stage.id
  currentUpdate = update
  if (stageChanged) renderLocalizedStaticCopy()
  renderStates(Date.now())
}

function waitForCompletionStep(signal, delay) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const done = timestamp => {
      signal.removeEventListener('abort', cancel)
      resolve(timestamp)
    }
    const id =
      delay === undefined ? window.requestAnimationFrame(done) : window.setTimeout(done, delay)
    const cancel = () => {
      if (delay === undefined) window.cancelAnimationFrame(id)
      else window.clearTimeout(id)
      reject(signal.reason)
    }
    signal.addEventListener('abort', cancel, { once: true })
  })
}

async function completeProgress(signal, duration) {
  const initial = displayedProgress
  const startedAt = performance.now()
  let fraction = duration === 0 ? 1 : 0
  while (fraction < 1) {
    const timestamp = await waitForCompletionStep(signal)
    fraction = motionPreference.matches ? 1 : Math.min(1, (timestamp - startedAt) / duration)
    const eased = fraction * fraction * (3 - 2 * fraction)
    displayedProgress = initial + (100 - initial) * eased
    paintProgress()
  }
  displayedProgress = 100
  paintProgress()
}

function completionEvidence() {
  const canvas = document.querySelector('#startup-brand-canvas').getBoundingClientRect()
  const wordmark = document.querySelector('.startup-brand-name')
  const rootStyle = window.getComputedStyle(document.documentElement)
  return {
    reducedMotion: motionPreference.matches,
    progressNow: Number(progressElement.getAttribute('aria-valuenow')),
    fillEnd: Number(progressFillElement.getAttribute('x2')),
    trackEnd: Number(progressTrackElement.getAttribute('x2')),
    wordmarkVisible: wordmark?.checkVisibility() ?? false,
    appearance: {
      theme: document.documentElement.dataset.theme,
      colorScheme: rootStyle.colorScheme,
      background: rootStyle.backgroundColor,
      footerBackground: window.getComputedStyle(document.querySelector('#startup-status'))
        .backgroundColor,
    },
    canvas: { x: canvas.x, y: canvas.y, width: canvas.width, height: canvas.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  }
}

async function finishStartup(signal) {
  slowActive = false
  timeoutActive = false
  renderNotes()
  confirmationElement.hidden = true
  delete document.documentElement.dataset.confirmationVisible
  brandAnimation.setPaused(false)
  const duration = motionPreference.matches ? 0 : 200
  try {
    await Promise.all([completeProgress(signal, duration), brandAnimation.complete(duration)])
    signal.throwIfAborted()
    setText(titleElement, isChinese ? '准备完成' : 'Ready')
    setText(activityElement, isChinese ? '工作台已就绪' : 'Your workbench is ready.')
    activityElement.title = activityElement.textContent
    progressElement.classList.remove('is-running')
    await waitForCompletionStep(signal)
    await waitForCompletionStep(signal)
    if (!motionPreference.matches) {
      await waitForCompletionStep(signal, 50)
    }
    signal.throwIfAborted()
    return completionEvidence()
  } catch (error) {
    completionController.abort(error)
    throw signal.reason
  }
}

function completeStartup(update) {
  if (completionPromise) return completionPromise
  if (startupFailed || disposed) {
    completionPromise = Promise.reject(
      new Error('Startup splash cannot complete after failure or disposal')
    )
    return completionPromise
  }
  if (update) currentUpdate = update
  stopProgressUpdates()
  if (toastTimer) window.clearTimeout(toastTimer)
  toastTimer = 0
  toastElement.hidden = true
  completionController = new AbortController()
  completionPromise = finishStartup(completionController.signal)
  return completionPromise
}

window.weworkStartupSplash = { complete: completeStartup }

function setLocalizedActionCopy() {
  if (failedPluginName) {
    disablePluginButton.textContent = isChinese
      ? `屏蔽 ${failedPluginName} 并重启`
      : `Disable ${failedPluginName} and restart`
  }
  retryButton.textContent = isChinese ? '重新启动' : 'Restart'
  recoverButton.textContent = isChinese ? '修复启动' : 'Repair startup'
  resetOpenButton.textContent = isChinese ? '重置个人状态' : 'Reset personal state'
  copyDiagnosticsButton.textContent = isChinese ? '复制诊断信息' : 'Copy diagnostics'
  openLogsButton.textContent = isChinese ? '打开日志目录' : 'Open log folder'
  timeoutCopyButton.textContent = isChinese ? '复制诊断信息' : 'Copy diagnostics'
  timeoutOpenLogsButton.textContent = isChinese ? '打开日志目录' : 'Open log folder'
  confirmationCancel.textContent = isChinese ? '取消' : 'Cancel'
}

function renderLocalizedStaticCopy() {
  progressElement.setAttribute('aria-label', isChinese ? '启动进度' : 'Startup progress')
  slowTitleElement.textContent = isChinese ? '请耐心等待' : 'Please wait'
  slowDetailElement.textContent = isChinese
    ? '首次启动或更新后可能需要更长时间。'
    : 'First launches and updates can take longer.'
  timeoutTitleElement.textContent = isChinese ? '首次启动可能较慢' : 'First startup can take longer'
  timeoutDetailElement.textContent = isChinese
    ? '正在继续加载，请稍候…'
    : 'Still loading. Please wait…'
  failureTitleElement.textContent = failedPluginName
    ? isChinese
      ? `插件 ${failedPluginName} 加载失败`
      : `The plugin ${failedPluginName} failed to load`
    : isChinese
      ? '启动过程意外中断'
      : 'Startup was interrupted'
  failureDetailElement.textContent = failedPluginName
    ? isChinese
      ? '可以屏蔽该插件后重启，或先尝试重新启动。'
      : 'Disable the plugin and restart, or try restarting first.'
    : isChinese
      ? '重新启动通常可以恢复。'
      : 'Restarting usually recovers.'
}

function showConfirmation(mode) {
  pendingResetMode = mode
  confirmationTrigger = document.activeElement
  confirmationElement.hidden = false
  document.documentElement.dataset.confirmationVisible = 'true'
  brandAnimation.setPaused(true)
  if (mode === 'recover') {
    confirmationTitle.textContent = isChinese ? '修复启动？' : 'Repair startup?'
    confirmationDescription.textContent = isChinese
      ? '将清理运行环境和缓存，重启后自动重建。登录、设置、布局、插件、任务和会话都会保留。'
      : 'This rebuilds the runtime and clears caches. Your sign-in, settings, layout, plugins, tasks, and conversations are preserved.'
    confirmationSubmit.textContent = isChinese ? '修复并重启' : 'Repair and restart'
    confirmationSubmit.classList.remove('startup-button-danger')
    confirmationSubmit.classList.add('startup-button-primary')
    confirmationSubmit.focus()
    return
  }
  confirmationTitle.textContent = isChinese ? '重置个人状态？' : 'Reset personal state?'
  confirmationDescription.textContent = isChinese
    ? '将修复启动，并退出登录、恢复默认设置和布局、移除已安装插件。任务、会话、智能应用和项目文件都会保留。'
    : 'This repairs startup, signs you out, restores default settings and layouts, and removes installed plugins. Tasks, conversations, Smart apps, and project files are preserved.'
  confirmationSubmit.textContent = isChinese ? '重置并重启' : 'Reset and restart'
  confirmationSubmit.classList.remove('startup-button-primary')
  confirmationSubmit.classList.add('startup-button-danger')
  confirmationSubmit.focus()
}

function hideConfirmation() {
  if (actionPending) return
  pendingResetMode = null
  confirmationElement.hidden = true
  delete document.documentElement.dataset.confirmationVisible
  brandAnimation.setPaused(startupFailed)
  if (confirmationTrigger instanceof HTMLElement) confirmationTrigger.focus()
  confirmationTrigger = null
}

function setActionPending(pending) {
  actionPending = pending
  disablePluginButton.disabled = pending
  retryButton.disabled = pending
  recoverButton.disabled = pending
  resetOpenButton.disabled = pending
  copyDiagnosticsButton.disabled = pending
  openLogsButton.disabled = pending
  timeoutCopyButton.disabled = pending
  timeoutOpenLogsButton.disabled = pending
  confirmationCancel.disabled = pending
  confirmationSubmit.disabled = pending
}

async function runRecoveryAction(action, ...args) {
  actionErrorElement.hidden = true
  setActionPending(true)
  try {
    const recovery = window.weworkStartupRecovery
    if (!recovery || typeof recovery[action] !== 'function') {
      throw new Error('Startup recovery is unavailable')
    }
    await recovery[action](...args)
  } catch {
    setActionPending(false)
    actionErrorElement.textContent = isChinese
      ? '操作失败，请重新尝试。'
      : 'The operation failed. Please try again.'
    actionErrorElement.hidden = false
  }
}

setLocalizedActionCopy()
renderLocalizedStaticCopy()
brandAnimation.refresh()
disablePluginButton.addEventListener('click', () => {
  if (failedPluginName) void runRecoveryAction('disablePlugin', failedPluginName)
})
retryButton.addEventListener('click', () => {
  if (pendingResetMode) {
    const action = pendingResetMode === 'recover' ? 'recoverWorkbench' : pendingResetMode
    void runRecoveryAction(action)
    return
  }
  void runRecoveryAction('retry')
})
recoverButton.addEventListener('click', () => showConfirmation('recover'))
resetOpenButton.addEventListener('click', () => showConfirmation('resetAppState'))
copyDiagnosticsButton.addEventListener('click', () => {
  void copyStartupDiagnostics()
})
openLogsButton.addEventListener('click', () => {
  void openStartupLogs()
})
timeoutCopyButton.addEventListener('click', () => {
  void copyStartupDiagnostics()
})
timeoutOpenLogsButton.addEventListener('click', () => {
  void openStartupLogs()
})
confirmationCancel.addEventListener('click', hideConfirmation)
confirmationSubmit.addEventListener('click', () => {
  if (!pendingResetMode) return
  const action = pendingResetMode === 'recover' ? 'recoverWorkbench' : pendingResetMode
  void runRecoveryAction(action)
})
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !confirmationElement.hidden) {
    event.preventDefault()
    hideConfirmation()
  }
})

window.addEventListener('wework-startup-error', event => {
  const pluginName = event.detail?.pluginName
  failedPluginName = typeof pluginName === 'string' && pluginName ? pluginName : null
  disablePluginButton.hidden = failedPluginName === null
  startupFailed = true
  stopProgressUpdates()
  completionController?.abort(new Error('Startup failed before the splash handoff completed'))
  setLocalizedActionCopy()
  renderLocalizedStaticCopy()
  renderStates(Date.now())
})

const progressApi = window.weworkStartupProgress
if (progressApi && typeof progressApi.onUpdate === 'function') {
  progressApi.onUpdate(update => applyUpdate(update))
}

renderStates(Date.now())
if (!completionPromise) progressTimer = window.setInterval(tick, 100)
const progressObserver = new ResizeObserver(paintProgress)
progressObserver.observe(progressSvg)
window.addEventListener('pagehide', () => {
  disposed = true
  completionController?.abort(new Error('Startup splash was disposed before handoff completed'))
  progressObserver.disconnect()
  brandAnimation.destroy()
  stopProgressUpdates()
  if (toastTimer) window.clearTimeout(toastTimer)
})

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    document.documentElement.dataset.animationReady = 'true'
  })
})
