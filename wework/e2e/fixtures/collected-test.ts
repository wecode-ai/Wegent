import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { test as base, expect, type Response, type Request, type Page } from '@playwright/test'
import { E2EErrorLog, recordE2ERendererError } from '../../electron/src/host/e2e-error-log'
import { DesktopErrorCollector } from '../desktop/error-collector.mjs'

export type ErrorRecord = {
  source: string
  type: string
  details: {
    requestId?: string
    status?: number
    url?: string
    message?: string
    diagnostics?: { requestId?: string; status?: number }
  }
}

type ExpectedResponse = {
  requestId: string
  clientRequestId?: string
  url: string
  status: number
  statusText: string
}

export const test = base.extend<{
  errors: {
    expectHttpError: (response: Response, status: number) => void
    expectError: (match: (entry: ErrorRecord) => boolean, count?: number) => void
  }
}>({
  errors: [
    async ({ context }, runTest, testInfo) => {
      const journalPath = testInfo.outputPath('errors.jsonl')
      const appLogPath = testInfo.outputPath('collector.log')
      writeFileSync(appLogPath, '')
      const collector = new DesktopErrorCollector(journalPath, appLogPath)
      const journal = new E2EErrorLog(journalPath, message =>
        writeFileSync(appLogPath, message, { flag: 'a' })
      )
      const expected: ExpectedResponse[] = []
      const expectedErrors: { match: (entry: ErrorRecord) => boolean; count: number }[] = []
      const requests = new WeakMap<Request, string>()
      const requestId = (request: Request) => {
        let id = requests.get(request)
        if (!id) {
          id = randomUUID()
          requests.set(request, id)
        }
        return id
      }
      const observedPages = new Set<Page>()
      const observePage = (target: Page) => {
        if (observedPages.has(target)) return
        observedPages.add(target)
        target.on('crash', () => journal.record('process', 'page-crashed', 'error', {}))
        target.on('close', () => journal.record('process', 'page-closed', 'info', {}))
        target.on('websocket', socket => {
          const connectionId = randomUUID()
          journal.record('network', 'websocket-opened', 'info', { connectionId, url: socket.url() })
          socket.on('socketerror', message =>
            journal.record('network', 'websocket-error', 'error', {
              connectionId,
              url: socket.url(),
              message,
            })
          )
          socket.on('close', () =>
            journal.record('network', 'websocket-closed', 'info', {
              connectionId,
              url: socket.url(),
            })
          )
        })
      }
      context.on('weberror', event => {
        const error = event.error()
        journal.record('renderer', 'page-error', 'error', {
          message: error.message,
          stack: error.stack,
        })
      })
      context.on('console', message => {
        if (message.type() === 'error' || message.type() === 'warning')
          recordE2ERendererError(
            message.text(),
            message.location(),
            message.type() === 'error' ? 3 : 2,
            journal
          )
      })
      context.on('page', observePage)
      for (const target of context.pages()) observePage(target)
      context.on('requestfailed', request =>
        journal.record('network', 'request-failed', 'error', {
          requestId: requestId(request),
          url: request.url(),
          method: request.method(),
          message: request.failure()?.errorText,
        })
      )
      context.on('response', response =>
        journal.record('network', 'http-response', response.status() >= 400 ? 'error' : 'info', {
          requestId: requestId(response.request()),
          url: response.url(),
          status: response.status(),
        })
      )
      try {
        await runTest({
          expectError(match, count = 1) {
            assert.ok(Number.isSafeInteger(count) && count > 0)
            expectedErrors.push({ match, count })
          },
          expectHttpError(response, status) {
            expect(response.status()).toBe(status)
            assert.ok(status >= 400)
            expected.push({
              requestId: requestId(response.request()),
              clientRequestId: response.request().headers()['x-request-id'],
              url: response.url(),
              status,
              statusText: response.statusText(),
            })
          },
        })
      } finally {
        try {
          await context.close()
          const checkpoint = journal.checkpoint()
          assert.equal(checkpoint.failedWrites, 0)
          const records = collector.records({ byteLength: checkpoint.byteLength })
          const expectations = expected.flatMap(response => {
            const network = {
              match: (entry: ErrorRecord) =>
                entry.source === 'network' &&
                entry.type === 'http-response' &&
                entry.details.requestId === response.requestId &&
                entry.details.status === response.status,
              count: 1,
            }
            const consoleError = (entry: ErrorRecord) =>
              entry.source === 'renderer' &&
              entry.type === 'renderer-error' &&
              entry.details.url === response.url &&
              entry.details.message ===
                `Failed to load resource: the server responded with a status of ${response.status} (${response.statusText})`
            const rendererResponse = (entry: ErrorRecord) =>
              Boolean(response.clientRequestId) &&
              entry.source === 'renderer' &&
              entry.type === 'http:response' &&
              entry.details.diagnostics?.requestId === response.clientRequestId &&
              entry.details.diagnostics?.status === response.status
            // Chromium may emit a console record for an explicitly asserted HTTP failure.
            return [
              network,
              ...(records.some(consoleError) ? [{ match: consoleError, count: 1 }] : []),
              ...(records.some(rendererResponse) ? [{ match: rendererResponse, count: 1 }] : []),
            ]
          })
          await collector.assertCollectedErrors(
            {
              command: async (action: string) => {
                assert.equal(action, 'getErrorCollectionCheckpoint')
                return JSON.stringify(journal.checkpoint())
              },
            },
            [...expectations, ...expectedErrors]
          )
        } finally {
          const summaryPath = testInfo.outputPath('error-summary.json')
          writeFileSync(summaryPath, JSON.stringify(collector.summary(), null, 2))
          await testInfo.attach('error-journal', {
            path: journalPath,
            contentType: 'application/x-ndjson',
          })
          await testInfo.attach('error-summary', {
            path: summaryPath,
            contentType: 'application/json',
          })
        }
      }
    },
    { auto: true },
  ],
})

export { expect }
