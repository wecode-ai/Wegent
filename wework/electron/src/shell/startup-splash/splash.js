const stages = [
  {
    en: 'Opening your projects',
    zh: '正在整理项目',
    paths: [
      [2, 7, 9, 7, 11, 9, 22, 9, 22, 20, 2, 20, 2, 7],
      [4, 12, 20, 12, 20, 12],
      [12, 16, 12, 16],
    ],
  },
  {
    en: 'Connecting your tools',
    zh: '正在连接工具',
    paths: [
      [2, 4, 22, 4, 22, 20, 2, 20, 2, 4, 2, 4, 2, 4],
      [7, 9, 10, 12, 7, 15],
      [13, 15, 18, 15],
    ],
  },
  {
    en: 'Waking your agents',
    zh: '正在唤醒智能体',
    paths: [
      [13, 2, 5, 13, 11, 13, 9, 22, 20, 9, 14, 9, 13, 2],
      [12, 12, 12, 12, 12, 12],
      [12, 12, 12, 12],
    ],
  },
]

const pathElements = [
  document.querySelector('#morph-primary'),
  document.querySelector('#morph-secondary'),
  document.querySelector('#morph-tertiary'),
]
const splashRoot = document.querySelector('#splash-root')
const stageIndicator = document.querySelector('#stage-indicator')
const statusElement = document.querySelector('#splash-status')
const titleElement = document.querySelector('#splash-title')
const stageDots = [...document.querySelectorAll('.stage-dot')]
const recoveryElement = document.querySelector('#startup-recovery')
const retryButton = document.querySelector('#startup-retry')
const recoverButton = document.querySelector('#startup-recover')
const resetOpenButton = document.querySelector('#startup-reset-open')
const actionErrorElement = document.querySelector('#startup-action-error')
const confirmationElement = document.querySelector('#startup-confirmation')
const confirmationTitle = document.querySelector('#startup-confirmation-title')
const confirmationDescription = document.querySelector('#startup-confirmation-description')
const confirmationCancel = document.querySelector('#startup-confirmation-cancel')
const confirmationSubmit = document.querySelector('#startup-confirmation-submit')
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
const isChinese = navigator.language.toLowerCase().startsWith('zh')
const currentPaths = stages[0].paths.map(path => [...path])
const velocities = stages[0].paths.map(path => path.map(() => 0))
let stageIndex = prefersReducedMotion ? stages.length - 1 : 0
let previousTime = performance.now()
let slowStartup = false
let startupFailed = false
let pendingResetMode = null
let actionPending = false
let confirmationTrigger = null

function pathData(points) {
  let data = `M${points[0]} ${points[1]}`
  for (let index = 2; index < points.length; index += 2) {
    data += `L${points[index]} ${points[index + 1]}`
  }
  return data
}

function paintPaths(paths) {
  paths.forEach((path, index) => {
    pathElements[index]?.setAttribute('d', pathData(path))
  })
}

function updateCopy(index, animate) {
  const stage = stages[index]
  document.documentElement.lang = isChinese ? 'zh-CN' : 'en'
  document.body.dataset.stage = String(index)
  titleElement.textContent = startupFailed
    ? isChinese
      ? 'Wework 启动失败'
      : 'Wework could not start'
    : slowStartup
      ? isChinese
        ? '启动时间比预期稍长'
        : 'Startup is taking longer than expected'
      : isChinese
        ? '我们正在准备工作台'
        : "We're preparing your workbench"
  splashRoot.setAttribute('aria-label', isChinese ? 'Wework 正在启动' : 'Wework is starting')
  stageIndicator.setAttribute(
    'aria-label',
    isChinese ? '正在准备工作台' : 'Preparing your workbench'
  )
  stageIndicator.setAttribute('aria-valuenow', String(index + 1))

  const replaceStatus = () => {
    statusElement.textContent = startupFailed
      ? isChinese
        ? '你可以重试，或重置启动状态后重新打开'
        : 'Retry, or reset startup state and reopen Wework'
      : slowStartup
        ? isChinese
          ? '仍在加载任务列表，请稍候…'
          : 'Still loading your task list…'
        : isChinese
          ? stage.zh
          : stage.en
    statusElement.classList.remove('is-changing')
  }

  if (animate) {
    statusElement.classList.add('is-changing')
    window.setTimeout(replaceStatus, 140)
  } else {
    replaceStatus()
  }

  stageDots.forEach((dot, dotIndex) => {
    dot.classList.toggle('is-active', dotIndex === index)
  })
}

function setLocalizedActionCopy() {
  retryButton.textContent = isChinese ? '重新启动' : 'Restart'
  recoverButton.textContent = isChinese ? '恢复工作台' : 'Recover workbench'
  resetOpenButton.textContent = isChinese ? '更多重置选项' : 'More reset options'
  confirmationCancel.textContent = isChinese ? '取消' : 'Cancel'
}

function showRecovery() {
  recoveryElement.hidden = false
  document.documentElement.dataset.recoveryVisible = 'true'
}

function showConfirmation(mode) {
  pendingResetMode = mode
  confirmationTrigger = document.activeElement
  confirmationElement.hidden = false
  document.documentElement.dataset.confirmationVisible = 'true'
  if (mode === 'recover') {
    confirmationTitle.textContent = isChinese ? '恢复工作台？' : 'Recover the workbench?'
    confirmationDescription.textContent = isChinese
      ? '将清除标签页、分屏和上次会话恢复状态。登录、项目、任务和偏好设置不会受到影响。'
      : 'This clears tabs, split layouts, and previous-session restore state. Your sign-in, projects, tasks, and preferences are preserved.'
    confirmationSubmit.textContent = isChinese ? '恢复并重启' : 'Recover and restart'
    confirmationSubmit.classList.remove('startup-button-danger')
    confirmationSubmit.classList.add('startup-button-primary')
    confirmationSubmit.focus()
    return
  }
  confirmationTitle.textContent = isChinese ? '彻底重置应用状态？' : 'Reset all app state?'
  confirmationDescription.textContent = isChinese
    ? '将退出登录，并清除界面偏好、标签页和应用缓存。本地任务、插件、智能应用和工作目录会保留。'
    : 'This signs you out and clears UI preferences, tabs, and app caches. Local tasks, plugins, Smart apps, and workspaces are preserved.'
  confirmationSubmit.textContent = isChinese ? '彻底重置并重启' : 'Reset and restart'
  confirmationSubmit.classList.remove('startup-button-primary')
  confirmationSubmit.classList.add('startup-button-danger')
  confirmationSubmit.focus()
}

function hideConfirmation() {
  if (actionPending) return
  pendingResetMode = null
  confirmationElement.hidden = true
  delete document.documentElement.dataset.confirmationVisible
  if (confirmationTrigger instanceof HTMLElement) confirmationTrigger.focus()
  confirmationTrigger = null
}

function setActionPending(pending) {
  actionPending = pending
  retryButton.disabled = pending
  recoverButton.disabled = pending
  resetOpenButton.disabled = pending
  confirmationCancel.disabled = pending
  confirmationSubmit.disabled = pending
}

async function runRecoveryAction(action) {
  actionErrorElement.hidden = true
  setActionPending(true)
  try {
    const recovery = window.weworkStartupRecovery
    if (!recovery || typeof recovery[action] !== 'function') {
      throw new Error('Startup recovery is unavailable')
    }
    await recovery[action]()
  } catch {
    setActionPending(false)
    actionErrorElement.textContent = isChinese
      ? '操作失败，请重新尝试。'
      : 'The operation failed. Please try again.'
    actionErrorElement.hidden = false
  }
}

setLocalizedActionCopy()
retryButton.addEventListener('click', () => void runRecoveryAction('retry'))
recoverButton.addEventListener('click', () => showConfirmation('recover'))
resetOpenButton.addEventListener('click', () => showConfirmation('resetAppState'))
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

window.addEventListener('wework-startup-error', () => {
  startupFailed = true
  slowStartup = true
  document.body.dataset.startupError = 'true'
  document.body.dataset.slowStartup = 'true'
  updateCopy(stageIndex, true)
  showRecovery()
})

function animateMorph(time) {
  const delta = Math.min((time - previousTime) / 1000, 0.032)
  const targetPaths = stages[stageIndex].paths
  previousTime = time

  currentPaths.forEach((path, pathIndex) => {
    path.forEach((value, coordinateIndex) => {
      const displacement = targetPaths[pathIndex][coordinateIndex] - value
      const acceleration = displacement * 190
      const damping = Math.exp(-24 * delta)
      velocities[pathIndex][coordinateIndex] =
        (velocities[pathIndex][coordinateIndex] + acceleration * delta) * damping
      path[coordinateIndex] += velocities[pathIndex][coordinateIndex] * delta
    })
  })

  paintPaths(currentPaths)
  requestAnimationFrame(animateMorph)
}

if (prefersReducedMotion) {
  currentPaths.forEach((path, pathIndex) => {
    path.splice(0, path.length, ...stages[stageIndex].paths[pathIndex])
  })
  paintPaths(currentPaths)
  updateCopy(stageIndex, false)
} else {
  paintPaths(currentPaths)
  updateCopy(stageIndex, false)
  requestAnimationFrame(animateMorph)
  window.setInterval(() => {
    stageIndex = (stageIndex + 1) % stages.length
    if (!slowStartup && !startupFailed) updateCopy(stageIndex, true)
  }, 1150)
}

window.setTimeout(() => {
  slowStartup = true
  document.body.dataset.slowStartup = 'true'
  updateCopy(stageIndex, true)
}, 10_000)

window.setTimeout(() => {
  if (!startupFailed) showRecovery()
}, 30_000)

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    document.documentElement.dataset.animationReady = 'true'
  })
})
