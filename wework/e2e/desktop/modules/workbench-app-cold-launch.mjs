import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createDevtoolsClient } from '../../../scripts/ai-verify-devtools.mjs'

const execFileAsync = promisify(execFile)
const CLI = fileURLToPath(new URL('../../../electron/src/cli/wework-cli.mjs', import.meta.url))
const STEP_TIMEOUT_MS = 10_000

async function until(read, predicate, description, timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let value
  do {
    value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  assert.fail(`${description}: ${JSON.stringify(value)}`)
}

async function cli(resultDir, args) {
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      WEWORK_DESKTOP_CONTROL_REGISTRY_DIR: join(resultDir, 'desktop-control'),
    },
    timeout: STEP_TIMEOUT_MS,
  })
  return JSON.parse(stdout)
}

function sandboxDocument(node) {
  const index = node.attributes?.indexOf('data-testid') ?? -1
  if (
    node.nodeName === 'IFRAME' &&
    index >= 0 &&
    node.attributes[index + 1] === 'workbench-lightweight-frame'
  )
    return node.contentDocument
  for (const child of node.children ?? []) {
    const found = sandboxDocument(child)
    if (found) return found
  }
}

const DOCUMENT_EXPRESSION = `Promise.resolve().then(async () => ({
  sdk: Boolean(window.weworkWorkbench),
  text: document.querySelector('[data-testid="todo-items"]')?.textContent,
  checked: document.querySelector('[data-testid^="todo-check-"]')?.checked,
  state: await window.weworkWorkbench?.storage.get()
}))`

async function readCrossProcessDocument(command) {
  const { targetInfos } = await command('Target.getTargets', {})
  for (const info of targetInfos.filter(value => value.type === 'iframe')) {
    const { sessionId } = await command('Target.attachToTarget', {
      targetId: info.targetId,
      flatten: true,
    })
    try {
      const { frameTree } = await command('Page.getFrameTree', {}, sessionId)
      if (frameTree.frame.name !== 'wework-workbench-lightweight') continue
      const result = await command(
        'Runtime.evaluate',
        { expression: DOCUMENT_EXPRESSION, awaitPromise: true, returnByValue: true },
        sessionId
      )
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
      return result.result?.value
    } finally {
      await command('Target.detachFromTarget', { sessionId })
    }
  }
  return null
}

async function readSandboxDocument(devtools, target) {
  const command = (method, params, sessionId) =>
    devtools({ action: 'command', target, method, params, ...(sessionId ? { sessionId } : {}) })
  const { root } = await command('DOM.getDocument', { depth: -1, pierce: true })
  const document = sandboxDocument(root)
  if (!document?.backendNodeId) return readCrossProcessDocument(command)
  const { object } = await command('DOM.resolveNode', { backendNodeId: document.backendNodeId })
  if (!object.objectId) return null
  try {
    const result = await command('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function () { const window=this.defaultView; const document=this; return (${DOCUMENT_EXPRESSION}); }`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result?.value
  } finally {
    await command('Runtime.releaseObject', { objectId: object.objectId })
  }
}

async function inspectColdApp({
  app,
  control,
  installationId,
  note,
  resultDir,
  readyCount,
  startupTimeoutMs,
}) {
  const instances = await until(
    () => cli(resultDir, ['desktop', 'instances']),
    values => values.some(value => value.pid === app.pid),
    'The cold workbench Host did not publish its isolated control instance',
    startupTimeoutMs
  )
  const instanceId = instances.find(value => value.pid === app.pid).instanceId
  const list = () =>
    cli(resultDir, ['workbench', 'list', '--instance', instanceId, '--format', 'json'])
  const installations = await until(
    list,
    values =>
      values.some(
        value =>
          value.id === installationId && value.state === 'running' && value.visible && value.webUrl
      ),
    'The cold startup did not run the requested DSH installation',
    startupTimeoutMs
  )
  const installation = installations.find(value => value.id === installationId)
  assert.match(installation.webUrl, /^http:\/\/127\.0\.0\.1:\d+(?:[/?#]|$)/)
  const pageUrl = new URL(installation.webUrl).href
  const matchesPage = value => URL.canParse(value.url) && new URL(value.url).href === pageUrl
  const devtools = await createDevtoolsClient(resultDir, STEP_TIMEOUT_MS)
  const targets = await until(
    () => devtools({ action: 'targets' }),
    values => values.some(matchesPage),
    'The cold startup did not open its DSH workbench window',
    startupTimeoutMs
  )
  const target = targets.find(matchesPage)
  try {
    const document = await until(
      () => readSandboxDocument(devtools, target.id),
      value => value?.sdk && value.text?.includes(note) && value.checked === true,
      'Cold launch did not restore the sandboxed TODO UI and completed state',
      startupTimeoutMs
    )
    assert.equal(document.state[0].text, note)
    assert.equal(document.state[0].done, true)
    const deadline = Date.now() + 1000
    let snapshot
    do {
      snapshot = {
        status: await cli(resultDir, ['desktop', 'status', '--instance', instanceId]),
        apps: await list(),
        targets: await devtools({ action: 'targets' }),
      }
      assert.equal(snapshot.status.pid, app.pid)
      assert.equal(
        snapshot.status.ready,
        false,
        'Cold application-only launch created the main renderer'
      )
      assert.equal(snapshot.status.url, null)
      assert.equal(snapshot.apps.find(value => value.id === installationId)?.visible, true)
      assert.equal(
        snapshot.targets.length,
        2,
        'Cold application-only launch created an unrelated renderer'
      )
      assert.equal(snapshot.targets.filter(value => value.id === target.id).length, 1)
      assert.equal(
        snapshot.targets.filter(
          value =>
            value.id !== target.id &&
            value.type === 'window' &&
            ['', 'about:blank'].includes(value.url)
        ).length,
        1,
        'The independent window must contain only its native container and DSH page'
      )
      assert.equal(
        control.readyCount,
        readyCount,
        'The main renderer connected during application-only startup'
      )
      if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    return { ...snapshot, document }
  } finally {
    await devtools({ action: 'detach', target: target.id })
  }
}

/** The shortcut starts the shared Host and DSH services without creating the main renderer. */
export async function verifyWorkbenchAppColdLaunch({
  control,
  installationId,
  note,
  resultDir,
  restartDesktopApp,
  shortcutExecutable,
  startupTimeoutMs = STEP_TIMEOUT_MS,
}) {
  assert.equal(typeof restartDesktopApp, 'function', 'The shared desktop restart hook is missing')
  const readyCount = control.readyCount
  const appLogPath = join(resultDir, 'app.log')
  let logOffset
  let evidence
  try {
    await restartDesktopApp({
      ...(shortcutExecutable
        ? { launchCommand: { command: shortcutExecutable, args: [] } }
        : { startupUrls: [`wework://workbenches/${installationId}`] }),
      afterStop: async () => {
        logOffset = (await readFile(appLogPath, 'utf8')).length
      },
      waitForStartup: async ({ app }) => {
        evidence = await inspectColdApp({
          app,
          control,
          installationId,
          note,
          resultDir,
          readyCount,
          startupTimeoutMs,
        })
      },
    })
    const startupLog = (await readFile(appLogPath, 'utf8')).slice(logOffset)
    assert.match(
      startupLog,
      /step: 'desktop-control-bridge'/,
      'The cold-start log did not record Host readiness'
    )
    assert.match(
      startupLog,
      /step: 'core-dsh-start',\s*status: 'completed'/,
      'Cold startup did not prepare the shared DSH runtime'
    )
    assert.match(
      startupLog,
      /step: 'desktop-runtime-start',\s*status: 'completed'/,
      'Cold startup did not prepare the shared Executor'
    )
    await writeFile(
      join(resultDir, 'workbench-app-cold-start.json'),
      JSON.stringify(evidence, null, 2)
    )
  } finally {
    await restartDesktopApp()
  }
  assert.ok(control.readyCount > readyCount, 'Normal restart did not restore the main workbench')
  await control.command('navigate', 'body', { value: '/sites?app_type=smart_app&view=owned' })
  await control.command('waitFor', '[data-testid="smart-apps-owned-page"]')
  await control.command('waitFor', `[data-testid="smart-app-created-item-${installationId}"]`)
  await control.command(
    'clickWhenEnabled',
    `[data-testid="harness-app-start-${installationId}"], [data-testid="harness-app-open-${installationId}"]`
  )
  await until(
    async () =>
      JSON.parse(
        await control.command('workbenchApp', 'body', {
          value: JSON.stringify({ action: 'snapshot', id: installationId }),
        })
      ),
    value => value.running && value.sdkAvailable,
    'Normal startup could not reopen the existing DSH workbench',
    startupTimeoutMs
  )
}
