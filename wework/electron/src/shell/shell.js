const status = document.querySelector('#runtime-status')
const details = document.querySelector('#details')
const reloadButton = document.querySelector('#reload-dsh')
const overlay = document.querySelector('#runtime-overlay')
const runtimeCard = document.querySelector('.runtime-card')

async function refreshState() {
  try {
    const state = await window.weworkElectron.getRuntimeState()
    overlay.dataset.phase = state.phase
    const failed = state.phase === 'failed'
    runtimeCard.hidden = !failed
    status.textContent = state.ready
      ? '运行时已就绪'
      : state.phase === 'failed'
        ? `运行时启动失败：${state.error || '未知错误'}`
        : '正在初始化 Core DSH…'
    details.textContent = JSON.stringify(state, null, 2)
    details.hidden = state.phase !== 'failed'
    reloadButton.textContent = '重试启动'
    reloadButton.hidden = state.phase !== 'failed'
    reloadButton.disabled = false
  } catch (error) {
    overlay.dataset.phase = 'failed'
    runtimeCard.hidden = false
    status.textContent = `无法读取运行时状态：${error instanceof Error ? error.message : String(error)}`
    details.hidden = false
    details.textContent = error instanceof Error ? error.stack || error.message : String(error)
    reloadButton.textContent = '重试启动'
    reloadButton.hidden = false
    reloadButton.disabled = false
  }
}

reloadButton.addEventListener('click', async () => {
  reloadButton.disabled = true
  await window.weworkElectron.reloadDsh().catch(error => {
    status.textContent = `重试失败：${error instanceof Error ? error.message : String(error)}`
  })
  await refreshState()
})

window.weworkElectron.onRuntimeChanged(refreshState)
void refreshState()
