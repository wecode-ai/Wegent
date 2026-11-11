const status = document.querySelector('#runtime-status')
const details = document.querySelector('#details')
const reloadButton = document.querySelector('#reload-dsh')
const overlay = document.querySelector('#runtime-overlay')
const runtimeCard = document.querySelector('.runtime-card')
const copyButton = document.querySelector('#copy-diagnostics')
const logsButton = document.querySelector('#open-logs')
const recovery = new URLSearchParams(window.location.search).get('recovery') === '1'
const chinese = navigator.language.startsWith('zh')
const copy = chinese
  ? {
      title: 'Wework 恢复中心',
      retry: '重试启动',
      diagnostics: '复制诊断信息',
      logs: '打开日志目录',
      ready: '运行时已就绪',
      starting: '正在初始化 Core DSH…',
      failed: '运行时暂不可用',
      unknown: '未知错误',
      stateFailed: '无法读取运行时状态',
      retryFailed: '重试失败',
      copyFailed: '复制失败',
      logsFailed: '无法打开日志',
    }
  : {
      title: 'Wework Recovery Center',
      retry: 'Retry startup',
      diagnostics: 'Copy diagnostics',
      logs: 'Open log folder',
      ready: 'Runtime is ready',
      starting: 'Starting Core DSH…',
      failed: 'Runtime is unavailable',
      unknown: 'Unknown error',
      stateFailed: 'Could not read runtime status',
      retryFailed: 'Retry failed',
      copyFailed: 'Copy failed',
      logsFailed: 'Could not open logs',
    }
reloadButton.textContent = copy.retry
copyButton.textContent = copy.diagnostics
logsButton.textContent = copy.logs
if (recovery) {
  document.querySelector('h1').textContent = copy.title
  copyButton.hidden = false
  logsButton.hidden = false
}

async function refreshState() {
  try {
    const state = await window.weworkElectron.getRuntimeState()
    overlay.dataset.phase = state.phase
    const failed = state.phase === 'failed'
    runtimeCard.hidden = !failed
    status.textContent = state.ready
      ? copy.ready
      : state.phase === 'failed'
        ? `${copy.failed}: ${state.error || copy.unknown}`
        : copy.starting
    details.textContent = JSON.stringify(state, null, 2)
    details.hidden = state.phase !== 'failed'
    reloadButton.textContent = copy.retry
    reloadButton.hidden = state.phase !== 'failed'
    reloadButton.disabled = false
  } catch (error) {
    overlay.dataset.phase = 'failed'
    runtimeCard.hidden = false
    status.textContent = `${copy.stateFailed}: ${error instanceof Error ? error.message : String(error)}`
    details.hidden = false
    details.textContent = error instanceof Error ? error.stack || error.message : String(error)
    reloadButton.textContent = copy.retry
    reloadButton.hidden = false
    reloadButton.disabled = false
  }
}

reloadButton.addEventListener('click', async () => {
  reloadButton.disabled = true
  await window.weworkElectron.reloadDsh().catch(error => {
    status.textContent = `${copy.retryFailed}: ${error instanceof Error ? error.message : String(error)}`
  })
  await refreshState()
})

copyButton.addEventListener('click', () => {
  void window.weworkElectron.copyStartupDiagnostics().catch(error => {
    status.textContent = `${copy.copyFailed}: ${error instanceof Error ? error.message : String(error)}`
  })
})
logsButton.addEventListener('click', () => {
  void window.weworkElectron.openStartupLogs().catch(error => {
    status.textContent = `${copy.logsFailed}: ${error instanceof Error ? error.message : String(error)}`
  })
})

window.weworkElectron.onRuntimeChanged(refreshState)
void refreshState()
