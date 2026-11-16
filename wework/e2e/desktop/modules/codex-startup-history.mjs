import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { WORKBENCH_READY_TIMEOUT_MS } from './shared.mjs'

const PROXY_STORAGE_KEY = 'wework.local-proxy-settings'
const WORKBENCH = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'

export async function verifyCodexStartupHistory(control, proxyUrl, completion, timeoutMs) {
  const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
  const address = snapshot.workbench?.currentRuntimeTask
  assert.ok(address?.taskId, 'Startup history needs the completed native seed conversation')
  const { task } = await requestExecutor(control, 'runtime.tasks.get', { address }, timeoutMs)
  assert.ok(task.threadId, 'The seed conversation must have a persisted Codex thread')
  const previous = await control.command('getLocalStorageItem', 'body', {
    value: PROXY_STORAGE_KEY,
  })
  const readyCount = control.readyCount
  // Same real proxy endpoint, different configuration identity. Store it atomically
  // with reload so only the new renderer can apply it to the existing app-server.
  await control.command('reloadMainWindow', 'body', {
    value: JSON.stringify({
      localStorage: {
        key: PROXY_STORAGE_KEY,
        value: JSON.stringify({ mode: 'custom', proxyUrl: `${proxyUrl}/` }),
      },
    }),
  })
  try {
    await control.awaitReadyAfter(readyCount)
    await control.command('waitFor', `${WORKBENCH} [data-testid="message-assistant"]`, {
      text: completion,
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    assert.equal(
      Number(await control.command('getElementCount', '[data-testid="runtime-transcript-error"]')),
      0,
      'Applying startup proxy settings must not cancel the restored conversation history'
    )
    const transcript = JSON.parse(
      await control.command('getLocalRuntimeTranscript', 'body', {
        value: JSON.stringify({ address, refresh: true }),
      })
    )
    assert.ok(
      transcript.messages.some(message => JSON.stringify(message).includes(completion)),
      'The original native history must remain readable without a UI retry'
    )
  } finally {
    if (previous) {
      await control.command('setLocalStorageItem', 'body', {
        value: JSON.stringify({ key: PROXY_STORAGE_KEY, value: previous }),
      })
    } else {
      await control.command('removeLocalStorageItem', 'body', { value: PROXY_STORAGE_KEY })
    }
  }
}
