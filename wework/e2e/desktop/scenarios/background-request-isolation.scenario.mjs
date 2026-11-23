import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ACTIVE_COMPOSER_SELECTOR,
  CHECKPOINT_TASK_COMPLETION_TEXT,
  CHECKPOINT_TASK_PROMPT,
  createSingleRootLocalProject,
  selectE2EModel,
  waitForLogPattern,
} from '../modules/shared.mjs'
import { runtimeTransportGates } from '../modules/runtime-transport-gates.mjs'
import { currentRuntimeTaskFromDebugSnapshot } from '../modules/workspace-flows.mjs'

export function createDesktopScenario({ workspacePath, electronUserDataDirectory, uiTimeoutMs }) {
  let partialProxySocket
  return {
    prepareApp({ appEnvironment, control }) {
      appEnvironment.WEWORK_BACKEND_URL = control.url
    },
    handleHttp(request, response, url) {
      switch (url.pathname) {
        case '/api/e2e-http-fault/before':
          request.socket.destroy()
          return true
        case '/api/e2e-http-fault/body':
          partialProxySocket = request.socket
          response.writeHead(200, {
            'content-length': '1024',
            'content-type': 'application/octet-stream',
            'cache-control': 'no-transform',
          })
          response.write('partial')
          return true
        case '/api/e2e-http-fault/release':
          assert.ok(partialProxySocket && !partialProxySocket.destroyed)
          partialProxySocket.destroy()
          response.writeHead(204).end()
          return true
        default:
          return false
      }
    },
    async verify(control) {
      await createSingleRootLocalProject(control, workspacePath, 'background-request-isolation')
      await selectE2EModel(control)
      await control.command('click', '[data-testid="execution-mode-button"]')
      await control.command(
        'clickWhenEnabled',
        '[data-testid="execution-mode-git-worktree-button"]'
      )
      const logDirectory = join(electronUserDataDirectory, 'logs')
      const transportLog = join(logDirectory, 'executor-transport.log')
      assert.equal(
        await control.command('runOversizedArchiveProbe', 'body', { timeoutMs: uiTimeoutMs }),
        'request_too_large'
      )
      const failurePattern =
        /"requestId":"(wework-local-[a-f\d-]+)","method":"runtime\.tasks\.archive","stage":"rpc_failed",[^\n]*"status":413,"code":"request_too_large"/
      const transport = await waitForLogPattern(transportLog, failurePattern, {
        timeoutMs: uiTimeoutMs,
      })
      const [, requestId] = transport.match(failurePattern)
      const eventFor = (field, value) =>
        new RegExp(`"requestId":"${requestId}"[^\\n]*"${field}":"${value}"`)
      const serverLog = join(logDirectory, 'dsh-core-runtime.log')
      const server = await waitForLogPattern(serverLog, eventFor('event', 'connection_closed'), {
        timeoutMs: uiTimeoutMs,
      })
      assert.match(server, eventFor('event', 'response_finished'))
      await waitForLogPattern(transportLog, eventFor('stage', 'background_released'), {
        timeoutMs: uiTimeoutMs,
      })
      await verifyDshHttpFailures(control, serverLog, uiTimeoutMs)

      const gates = runtimeTransportGates(control)
      try {
        for (let index = 0; index < 4; index++) {
          await gates.arm({
            id: `background-${index}`,
            kind: 'request',
            name: 'runtime.tasks.list',
            where: [{ path: 'params.backgroundProbe', equals: index }],
          })
        }
        await control.command('startBackgroundRequestProbe', 'body')
        await gates.wait('background-0')
        await gates.wait('background-1')
        const probe = JSON.parse(await control.command('readBackgroundRequestProbe', 'body'))
        const background = lock => lock.name.startsWith('wework.dsh.background.')
        assert.equal(probe.locks.held.filter(background).length, 2)
        assert.ok(
          probe.locks.pending.filter(background).length >= 2,
          'Remaining background requests must wait before fetch'
        )
        assert.equal(await gates.read('background-2'), null)
        assert.equal(await gates.read('background-3'), null)

        // Stall the real background transport at admission; native attachment staging stays usable.
        const filename = 'foreground-while-background-stalled.txt'
        await control.command('pasteFile', ACTIVE_COMPOSER_SELECTOR, {
          filename,
          mimeType: 'text/plain',
          value: Buffer.from('foreground attachment').toString('base64'),
        })
        await control.command('waitFor', '[data-testid="attachment-badge"]', {
          text: filename,
          visible: true,
          timeoutMs: uiTimeoutMs,
        })
        control.setScenario('checkpoint_task')
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: CHECKPOINT_TASK_PROMPT })
        await control.command('clickWhenEnabled', '[data-testid="send-message-button"]')
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: CHECKPOINT_TASK_COMPLETION_TEXT,
          timeoutMs: uiTimeoutMs,
        })
        const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        const task = currentRuntimeTaskFromDebugSnapshot(snapshot)
        assert.ok(task?.taskId && task.workspacePath, 'The created task must have a workspace')
        assert.notEqual(task.workspacePath, workspacePath, 'The task must use a separate worktree')
        assert.ok(
          (await stat(join(task.workspacePath, '.git'))).isFile(),
          'The created workspace must be a Git worktree'
        )
        const afterCreate = JSON.parse(await control.command('readBackgroundRequestProbe', 'body'))
        assert.equal(afterCreate.locks.held.filter(background).length, 2)
        assert.equal(await gates.read('background-2'), null)
        assert.equal(await gates.read('background-3'), null)

        await gates.release('background-1')
        await gates.wait('background-2')
        await gates.release('background-0')
        await gates.wait('background-3')
        await gates.reset()
        const completed = JSON.parse(
          await control.command('waitForBackgroundRequestProbe', 'body', { timeoutMs: uiTimeoutMs })
        )
        assert.deepEqual(Object.values(completed), ['done', 'done', 'done', 'done'])
      } finally {
        await gates.reset()
      }
    },
  }
}

async function verifyDshHttpFailures(control, serverLog, uiTimeoutMs) {
  const run = async value =>
    JSON.parse(
      await control.command('runDshHttpFailureProbe', 'body', { value, timeoutMs: uiTimeoutMs })
    )
  const log = (probe, fields) =>
    waitForLogPattern(serverLog, new RegExp(`"requestId":"e2e-http-${probe}"[^\\n]*${fields}`), {
      timeoutMs: uiTimeoutMs,
    })
  for (const probe of ['electron', 'terminal', 'plugins']) {
    assert.deepEqual(await run(probe), {
      status: 413,
      connection: 'close',
      code: 'request_too_large',
    })
    await log(probe, '"event":"connection_closed","status":413')
  }
  assert.deepEqual(await run('proxy-before'), {
    status: 502,
    connection: 'close',
    code: 'upstream_request_failed',
  })
  await log('proxy-before', '"code":"upstream_request_failed","status":502,"headersSent":false')
  assert.deepEqual(await run('proxy-body'), {
    status: 200,
    first: 'partial',
    readError: 'TypeError',
  })
  await log('proxy-body', '"code":"upstream_response_aborted","status":502,"headersSent":true')
  assert.deepEqual(await run('sse'), {
    status: 200,
    contentType: 'text/event-stream',
    requestId: 'e2e-http-sse',
  })
  await log('sse', '"reason":"client_disconnected"')
}
