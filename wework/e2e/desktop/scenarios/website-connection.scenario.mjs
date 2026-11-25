import assert from 'node:assert/strict'
import { once } from 'node:events'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  assistantMessage,
  createSse,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { withNativePluginDecision } from '../modules/native-plugin-approval.mjs'
import { withTimeout } from '../modules/shared.mjs'
import {
  openStoryPrimary,
  STORY_CHAT,
  STORY_USER,
  storyUntil,
} from '../modules/stand-in-source-story-evidence.mjs'
import { storyToolOutput } from '../modules/stand-in-source-story-model.mjs'

const SITE = '/website-connection/project/42'
const REPORT_PAGE = SITE + '/report'
const ACCOUNT = SITE + '/account'
const REPORT = SITE + '/runs'
const COOKIE = 'website_trial=logged_in'
const CSRF_COOKIE = 'website_csrf'
const INTENT = '查询 Agent 运行时长，单次超过 30 分钟就提醒我'
const READ_INTENT = '查询网页来源中的两条 Agent 运行记录。WEBSITE_CONNECTION_ON_DEMAND'
const READ_ANSWER = '该网页来源有两条运行记录，合计 41 分钟。'
const READ_CALL = 'website-connection-read-source'
const SINCE = '2026-11-01T00:00:00.000Z'
const UNTIL = '2026-11-03T00:00:00.000Z'
const historicalRows = [
  { id: 'run-short', at: '2026-11-01T09:00:00.000Z', durationMs: 60_000 },
  { id: 'run-long', at: '2026-11-02T09:00:00.000Z', durationMs: 2_400_000 },
]
const testId = id => `[data-testid="${id}"]`
const dateTime = { type: 'string', format: 'date-time' }

function draftFromRecording(samples) {
  const account = samples.findIndex(item => item.path === ACCOUNT)
  const report = samples.findIndex(item => item.path === REPORT)
  assert.ok(account >= 0 && report >= 0, 'The model must receive the two recorded requests')
  assert.deepEqual(samples[account].accountPaths, [['user', 'id']])
  const inputSchema = {
    type: 'object',
    properties: { since: dateTime, until: dateTime },
    required: ['since', 'until'],
    additionalProperties: false,
  }
  const view = {
    operation: 'runs',
    rows: ['results'],
    fields: { id: ['id'], at: ['at'], durationMs: ['durationMs'] },
  }
  return {
    pathPrefix: SITE,
    resource: { id: '42', kind: 'project', name: 'Agent runs' },
    operations: {
      account: {
        sampleIndex: account,
        inputSchema: { type: 'object', additionalProperties: false },
      },
      runs: {
        sampleIndex: report,
        inputSchema,
        json: { since: { $parameter: 'since' }, until: { $parameter: 'until' } },
      },
    },
    check: { operation: 'account', accountPath: ['user', 'id'] },
    read: {
      ...view,
      inputSchema,
      displayUnits: { durationMs: 'millisecond' },
      itemSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', title: '运行编号' },
          at: { ...dateTime, title: '运行时间' },
          durationMs: { type: 'integer', title: '运行时长' },
        },
        required: ['id', 'at', 'durationMs'],
        additionalProperties: false,
      },
    },
    poll: { ...view, minimum: { field: 'durationMs', value: 1_800_000 } },
    sample: { read: { since: SINCE, until: UNTIL }, observation: { since: SINCE, until: UNTIL } },
  }
}

function recordingText(value) {
  if (typeof value === 'string') return value.includes('Recorded samples: ') ? value : undefined
  if (value && typeof value === 'object')
    return Object.values(value).map(recordingText).find(Boolean)
}

export function createDesktopScenario({
  uiTimeoutMs,
  modelResponseTimeoutMs,
  workbenchReadyTimeoutMs,
  captureScreenshot,
  executorHome,
}) {
  let generation = false
  let modelCalls = 0
  let reportCalls = 0
  let csrfVersion = 1
  let pageLoads = 0
  let source
  const observations = new AbortController()
  const reports = new EventTarget()
  const rows = [...historicalRows]
  const nativeWindow = { focusMainWindow: process.platform !== 'darwin' }
  return {
    appEnvironment: { WEWORK_E2E_BACKGROUND_WINDOW: '0' },
    async handleHttp(req, res, url) {
      if (req.method === 'GET' && (url.pathname === SITE || url.pathname === REPORT_PAGE)) {
        const reportPage = url.pathname === REPORT_PAGE
        const readyTitle = `Agent runs · Report loaded ${++pageLoads}`
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': [
            COOKIE + '; Path=/; HttpOnly',
            `${CSRF_COOKIE}=private-csrf-${csrfVersion}; Path=/`,
          ],
        })
        res.end(`<!doctype html><title>Agent runs</title><h1>Agent runs</h1>
          <a href="${REPORT_PAGE}">Open run report</a><p id="results"></p>
          ${
            reportPage
              ? `<script>Promise.all([
            fetch(${JSON.stringify(ACCOUNT)}),
            fetch(${JSON.stringify(REPORT)}, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-csrftoken': document.cookie.split('; ').find(value => value.startsWith('${CSRF_COOKIE}=')).split('=')[1]
              },
              body: JSON.stringify({ since: ${JSON.stringify(SINCE)}, until: ${JSON.stringify(UNTIL)} })
            })
          ].map(request => request.then(response => response.json())))
            .then(([, report]) => {
              document.title = ${JSON.stringify(readyTitle)}
              document.querySelector('#results').textContent = 'Runs in this report: ' + report.results.length
            })</script>`
              : ''
          }`)
        return true
      }
      const report = req.method === 'POST' && url.pathname === REPORT
      if ((req.method === 'GET' && url.pathname === ACCOUNT) || report) {
        const cookies = req.headers.cookie?.split('; ') ?? []
        const authenticated = cookies.includes(COOKIE)
        const csrf = req.headers['x-csrftoken']
        const valid =
          authenticated &&
          (!report ||
            (csrf === `private-csrf-${csrfVersion}` && cookies.includes(`${CSRF_COOKIE}=${csrf}`)))
        const query = report ? await readRequestBody(req) : null
        res.writeHead(valid ? 200 : authenticated ? 403 : 401, {
          'content-type': 'application/json',
          ...(report &&
            valid &&
            generation && {
              'set-cookie': `${CSRF_COOKIE}=private-csrf-${++csrfVersion}; Path=/`,
            }),
        })
        if (!valid) {
          res.end(JSON.stringify({ error: 'Sign in' }))
          return true
        }
        const after = Date.parse(query?.since)
        const until = Date.parse(query?.until)
        res.end(
          JSON.stringify(
            url.pathname === ACCOUNT
              ? { user: { id: 42 }, password: 'fixture-secret' }
              : {
                  results: rows.filter(
                    row => Date.parse(row.at) > after && Date.parse(row.at) <= until
                  ),
                }
          )
        )
        if (url.pathname === REPORT) {
          reportCalls++
          reports.dispatchEvent(new Event('read'))
        }
        return true
      }
      if (
        (!generation && !source) ||
        req.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(req)
      if (
        source &&
        (JSON.stringify(body.input).includes(READ_INTENT) ||
          requestContainsToolOutput(body, READ_CALL) ||
          requestContainsToolOutput(body, READ_CALL + '-search'))
      ) {
        const output = requestContainsToolOutput(body, READ_CALL)
        const events = output
          ? [assistantMessage(READ_ANSWER)]
          : mcpToolRequestEvents(body, {
              toolName: 'read_source',
              directToolName: 'mcp__wework_stand_in__read_source',
              argumentsValue: { source, query: { since: SINCE, until: UNTIL } },
              searchCallId: READ_CALL + '-search',
              toolCallId: READ_CALL,
            }).events
        if (output) {
          const response = storyToolOutput(body, READ_CALL)
          assert.deepEqual(response.items, historicalRows)
        }
        const id = 'website-connection-on-demand'
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
        return true
      }
      const prompt = recordingText(body.input)
      if (!prompt) return false
      assert.ok(prompt.includes(`Current page path: ${JSON.stringify(REPORT_PAGE)}`))
      assert.ok(
        !prompt.includes('fixture-secret') &&
          !prompt.includes(COOKIE) &&
          !prompt.includes('private-csrf-') &&
          !prompt.includes(CSRF_COOKIE)
      )
      const draft = draftFromRecording(JSON.parse(prompt.split('Recorded samples: ').at(-1)))
      const id = `website-connection-${++modelCalls}`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        createSse([
          responseCreated(id),
          assistantMessage(JSON.stringify({ draftJson: JSON.stringify(draft), reason: '' })),
          responseCompleted(id),
        ])
      )
      return true
    },
    async verify(control) {
      const wait = (id, options = {}) =>
        control.command('waitFor', testId(id), { timeoutMs: uiTimeoutMs, ...options })
      const click = id =>
        control.command('clickWhenEnabled', testId(id), { timeoutMs: uiTimeoutMs })
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      try {
        await control.command('ensureLocalModelCatalogReady', 'body', {
          timeoutMs: workbenchReadyTimeoutMs,
        })
        const predefined = await rpc('runtime.connections.catalog', {
          websiteUrl: 'https://github.com/wecode-ai/Wegent',
        })
        assert.ok(
          predefined.items.some(item => item.id === '@wegent/dsh-connection-git/github'),
          'A GitHub page must find its bundled connection without recording'
        )
        await click('toggle-right-workspace-panel-button')
        await click('right-workspace-browser-option')
        await control.command('submit', testId('workspace-browser-url-input'), {
          value: control.url + SITE,
        })
        await wait('workspace-browser-native-view')
        await click('workspace-browser-more-button')
        await click('workspace-browser-connect-assistant')
        await wait('website-connection-intent')
        await control.command('fill', testId('website-connection-intent'), { value: INTENT })
        await captureScreenshot(control, 'website-01-intent.png')
        await click('website-connection-start-recording')
        await wait('website-connection-finish-recording')
        const nextPage = pageLoads + 1
        const observed = once(reports, 'read', { signal: observations.signal })
        await control.command('submit', testId('workspace-browser-url-input'), {
          value: control.url + REPORT_PAGE,
        })
        await withTimeout(
          observed,
          uiTimeoutMs,
          'The browser did not query the signed-in report during recording'
        )
        await control.command(
          'waitFor',
          '[data-testid^="right-workspace-browser-tab-"][aria-selected="true"]',
          { text: `Report loaded ${nextPage}`, timeoutMs: uiTimeoutMs }
        )
        await captureScreenshot(control, 'website-02-recording.png')
        const beforeTrial = reportCalls
        generation = true
        await click('website-connection-finish-recording')
        await wait('website-connection-trial-pending', { timeoutMs: modelResponseTimeoutMs })
        await withNativePluginDecision(
          control,
          () => wait('website-connection-trial-result', { timeoutMs: modelResponseTimeoutMs }),
          {
            focusMainWindow: false,
            labels: ['Run trial', '开始试跑'],
            titles: ['Try this website connection?', '试跑这个网页连接？'],
          }
        )
        generation = false
        assert.equal(modelCalls, 1)
        assert.ok(csrfVersion >= 3, 'Both trial requests must send the current CSRF cookie')
        await wait('website-connection-trial-result', { text: '运行时长' })
        await wait('website-connection-trial-match', { text: 'run-long' })
        assert.ok(
          reportCalls >= beforeTrial + 2,
          'The trial query and poll must both reuse the signed-in browser session'
        )
        await captureScreenshot(control, 'website-03-trial.png')
        await withNativePluginDecision(
          control,
          async () => {
            await click('website-connection-install')
            await wait('website-connection-open-installed', { timeoutMs: workbenchReadyTimeoutMs })
          },
          {
            ...nativeWindow,
            beforeDecision: async () => {
              await wait('website-connection-installing', { text: '正在安装连接…' })
              await captureScreenshot(control, 'website-04a-installing.png')
            },
          }
        )
        await captureScreenshot(control, 'website-04-installed.png')
        const readyCount = control.readyCount
        await click('website-connection-open-installed')
        await withTimeout(
          control.awaitReadyAfter(readyCount),
          workbenchReadyTimeoutMs,
          'The workbench did not reconnect after loading the installed connector'
        )
        await wait('stand-in-website-add-source', { timeoutMs: workbenchReadyTimeoutMs })
        const { items } = await rpc('runtime.connections.catalog', {
          websiteUrl: control.url + SITE,
        })
        assert.equal(items.length, 1)
        assert.equal(items[0].availability.status, 'ready')
        await click('stand-in-website-add-source')
        await control.command('waitFor', testId('stand-in-website-add-source'), { visible: false })
        await captureScreenshot(control, 'website-05-assistant-source.png')
        await click('stand-in-primary-save')
        const saved = await storyUntil(
          () => rpc('runtime.stand_in.personal.get', { userId: STORY_USER }),
          settings => settings.primary?.connections?.some(item => item.providerId === items[0].id),
          uiTimeoutMs,
          'The assistant did not persist the granted website source'
        )
        const { providerId, id, profile, kind } = saved.primary.connections.find(
          item => item.providerId === items[0].id
        )
        source = { providerId, id, profile, kind }
        await openStoryPrimary(control, uiTimeoutMs)
        await click('stand-in-onboarding-continue')
        await click('stand-in-onboarding-complete')
        await control.command('waitFor', testId('stand-in-onboarding'), { visible: false })
        const composer = `${STORY_CHAT} ${testId('chat-message-input')}`
        await control.command('fill', composer, { value: READ_INTENT })
        await control.command('press', composer, { key: 'Enter' })
        await control.command('waitFor', `${STORY_CHAT} ${testId('message-assistant')}`, {
          text: READ_ANSWER,
          timeoutMs: modelResponseTimeoutMs,
        })
        await captureScreenshot(control, 'website-06-assistant-query.png')
        const database = new DatabaseSync(join(executorHome, 'data', 'tasks.sqlite'), {
          readOnly: true,
        })
        database.exec('PRAGMA busy_timeout = 10000')
        const records = database.prepare(
          "SELECT metadata FROM loop_items WHERE resource_type=? AND json_extract(metadata,'$.source.providerId')=?"
        )
        const inspect = kind => records.all(kind, providerId).map(row => JSON.parse(row.metadata))
        try {
          const states = await storyUntil(
            () => inspect('stand_in_source'),
            states => states.some(state => state.checkpoint?.since),
            30_000,
            'The running assistant did not establish a collection checkpoint'
          )
          const since = states.find(state => state.checkpoint?.since).checkpoint.since
          const at = new Date(Math.max(Date.now(), Date.parse(since) + 1)).toISOString()
          rows.push(
            { id: 'after-activation-short', at, durationMs: 60_000 },
            { id: 'after-activation-long', at, durationMs: 2_400_000 }
          )
          const intake = await storyUntil(
            () => inspect('stand_in_event'),
            events => events.some(event => event.message?.objectId === 'after-activation-long'),
            30_000,
            'The assistant did not collect the new long run after closing setup'
          )
          assert.ok(!intake.some(event => event.message?.objectId === 'after-activation-short'))
        } finally {
          database.close()
        }
      } finally {
        generation = false
        source = undefined
        observations.abort()
      }
    },
  }
}
