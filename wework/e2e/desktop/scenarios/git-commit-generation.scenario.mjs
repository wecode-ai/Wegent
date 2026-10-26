import { readRequestBody } from '../modules/response-protocol.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { selectE2EModel } from '../modules/shared.mjs'

const exec = promisify(execFile)
const SUBJECT = 'test: verify routed commit generation'
const MARKER = 'WEWORK_ROUTED_COMMIT_GENERATION'

export async function openEnvironmentInfo(control) {
  const button = '[data-testid="environment-info-button"]'
  await control.command('waitFor', button)
  const expanded = await control.command('getAttribute', button, { value: 'aria-expanded' })
  assert.ok(expanded === 'true' || expanded === 'false', 'Environment toggle must expose its state')
  if (expanded === 'false') await control.command('click', button)
  await control.command('waitFor', '[data-testid="environment-info-popover"]')
}

function complete(response, content) {
  const id = `commit-generation-${Date.now()}`
  const events = [
    { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.done',
      item: {
        id: `${id}-message`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: content, annotations: [] }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id,
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  response.end(
    events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
  )
}

export async function createDesktopScenario({
  homePath,
  workspacePath,
  uiTimeoutMs,
  captureScreenshot,
}) {
  const remote = join(homePath, 'commit-generation-remote.git')
  await exec('git', ['init', '--bare', remote])
  await exec('git', ['remote', 'add', 'origin', remote], { cwd: workspacePath })
  let generationRequest = null
  let rejectGeneration = false
  let generationCount = 0

  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/v1/responses', '/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      const isCommit = JSON.stringify(body.input).includes('Generate a Git commit subject line')
      if (isCommit) {
        generationRequest = body
        generationCount += 1
      }
      complete(
        response,
        isCommit
          ? JSON.stringify({ message: rejectGeneration ? '' : SUBJECT })
          : 'Commit fixture ready'
      )
      return true
    },

    async verify(control) {
      await control.command('clickWhenEnabled', '[data-testid="project-work-button"]')
      await control.command('click', '[data-testid="add-local-project-option"]')
      await control.command('waitFor', '[data-testid="device-folder-path-input"]')
      await control.command('fill', '[data-testid="device-folder-path-input"]', {
        value: workspacePath,
      })
      await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
      await control.command(
        'clickWhenEnabled',
        '[data-testid="confirm-device-folder-picker-button"]'
      )
      await control.command('waitFor', '[data-testid="local-project-create-dialog"]')
      await control.command('fill', '[data-testid="local-project-create-name-input"]', {
        value: 'commit-generation-e2e',
      })
      await control.command(
        'clickWhenEnabled',
        '[data-testid="confirm-local-project-create-button"]'
      )
      await control.command('waitFor', '[data-testid="project-work-button"]', {
        text: 'commit-generation-e2e',
      })
      await selectE2EModel(control)
      await control.command('fill', '[data-testid="chat-message-input"]', {
        value: 'Prepare the commit fixture',
      })
      await control.command('clickWhenEnabled', '[data-testid="send-message-button"]')
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: 'Commit fixture ready',
        timeoutMs: uiTimeoutMs,
      })
      await writeFile(join(workspacePath, 'commit-generation.txt'), `${MARKER}\n`)
      await openEnvironmentInfo(control)
      // The Git contribution loads after the environment popover shell mounts.
      await control.command('clickWhenEnabled', '[data-testid="environment-commit-button"]')
      await control.command('fill', '[data-testid="environment-commit-message-input"]', {
        value: '',
      })
      await control.command('click', '[data-testid="environment-commit-and-push-button"]')
      await control.command('waitFor', '[data-testid="environment-commit-button"]', {
        text: '已提交',
      })
      assert.ok(generationRequest, 'Commit generation must reach the configured model route')
      assert.ok(
        JSON.stringify(generationRequest.input).includes(MARKER),
        'Generation must use the staged workspace diff'
      )
      const local = await exec('git', ['rev-parse', 'HEAD'], { cwd: workspacePath })
      const upstream = await exec('git', ['rev-parse', '@{u}'], { cwd: workspacePath })
      const remoteHead = await exec('git', [
        '--git-dir',
        remote,
        'rev-parse',
        (await exec('git', ['branch', '--show-current'], { cwd: workspacePath })).stdout.trim(),
      ])
      assert.equal(local.stdout.trim(), upstream.stdout.trim())
      assert.equal(local.stdout.trim(), remoteHead.stdout.trim())
      assert.equal(
        (await exec('git', ['log', '-1', '--format=%s'], { cwd: workspacePath })).stdout.trim(),
        SUBJECT
      )
      assert.equal(
        (await exec('git', ['status', '--porcelain'], { cwd: workspacePath })).stdout.trim(),
        ''
      )
      await captureScreenshot(control, 'git-commit-generation-success.png')

      rejectGeneration = true
      await writeFile(join(workspacePath, 'commit-generation.txt'), `${MARKER}\nerror path\n`)
      await control.command('click', '[data-testid="environment-commit-button"]')
      await control.command('click', '[data-testid="environment-commit-and-push-button"]')
      await control.command('waitFor', '[data-testid="environment-info-popover"]', {
        text: '提交失败',
      })
      assert.equal(
        (await exec('git', ['rev-parse', 'HEAD'], { cwd: workspacePath })).stdout,
        local.stdout
      )
      assert.ok(
        (await exec('git', ['diff', '--cached'], { cwd: workspacePath })).stdout.includes(
          'error path'
        )
      )
      await captureScreenshot(control, 'git-commit-generation-failure.png')
      const inferenceCount = generationCount
      await control.command('click', '[data-testid="environment-commit-button"]')
      await control.command('fill', '[data-testid="environment-commit-message-input"]', {
        value: 'test: recover with explicit message',
      })
      await control.command('click', '[data-testid="environment-commit-and-push-button"]')
      await control.command('waitFor', '[data-testid="environment-commit-button"]', {
        text: '已提交',
      })
      assert.equal(generationCount, inferenceCount, 'An explicit message must bypass inference')
      assert.equal(
        (await exec('git', ['status', '--porcelain'], { cwd: workspacePath })).stdout.trim(),
        ''
      )
      assert.equal(
        (await exec('git', ['rev-parse', 'HEAD'], { cwd: workspacePath })).stdout,
        (await exec('git', ['rev-parse', '@{u}'], { cwd: workspacePath })).stdout
      )
      await captureScreenshot(control, 'git-commit-generation-recovery.png')
    },
  }
}
