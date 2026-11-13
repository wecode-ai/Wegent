/** @jest-environment node */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import config from '../../../playwright.config'

jest.mock('@playwright/test', () => ({
  defineConfig: (value: unknown) => value,
  devices: { 'Desktop Chrome': {} },
}))

const independent = new Set([
  'tasks/executor-workspace-recovery.spec.ts',
  'tasks/pipeline-session-archive.spec.ts',
  'tasks/claude-background-lifecycle.spec.ts',
  'tasks/provider-native-claudecode.spec.ts',
  'tasks/shell-reference-cancel.spec.ts',
])
const expectedCounts: Record<string, number> = {
  'global-setup.ts': 1,
  'global-teardown.ts': 1,
  'tasks/agent-conversation-regression.spec.ts': 22,
  'tasks/device-artifact-declaration.spec.ts': 3,
  'tasks/claudecode-compaction.spec.ts': 4,
  'tasks/executor-workspace-recovery.spec.ts': 1,
  'tasks/pipeline-session-archive.spec.ts': 5,
  'tasks/claude-background-lifecycle.spec.ts': 4,
  'tasks/provider-native-claudecode.spec.ts': 2,
  'tasks/shell-reference-cancel.spec.ts': 1,
  'collaboration/collaboration-agent-execution.spec.ts': 1,
  'collaboration/issue-dispatch-executor.spec.ts': 4,
}

type ListedSuite = {
  suites?: ListedSuite[]
  specs?: Array<{
    file: string
    title: string
    tests: Array<{ projectName: string; expectedStatus: string }>
  }>
}

describe('Executor scheduling boundaries', () => {
  it('keeps device flows serial before bounded file parallelism without changing test budgets', () => {
    const serial = config.projects!.find(project => project.name === 'executor-device-chromium')!
    const parallel = config.projects!.find(project => project.name === 'executor-chromium')!
    expect(serial).toBeDefined()
    expect(serial.workers).toBe(1)
    expect(serial.fullyParallel).toBe(false)
    expect(serial.dependencies).toEqual(['setup'])
    expect(parallel.workers).toBe(2)
    expect(parallel.fullyParallel).toBe(false)
    expect(parallel.dependencies).toEqual(['executor-device-chromium'])
    expect(config.projects!.find(project => project.name === 'setup')!.teardown).toBe('cleanup')
    expect(config.retries).toBe(0)
    expect(config.timeout).toBe(60_000)
    for (const project of [serial, parallel]) {
      expect(project.timeout).toBeUndefined()
      expect(project.retries).toBeUndefined()
    }
  })

  it('discovers every registered Executor scenario exactly once through CI', () => {
    const cli = join(dirname(require.resolve('@playwright/test/package.json')), 'cli.js')
    const listed = spawnSync(
      process.execPath,
      [cli, 'test', '--project=executor-chromium', '--list', '--reporter=json'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          // This is a separate Playwright discovery process, not a Jest worker.
          ...process.env,
          JEST_WORKER_ID: '',
          CI: 'true',
          E2E_BOOTSTRAP_ADMIN_PASSWORD: 'discovery-only-bootstrap',
          E2E_ADMIN_PASSWORD: 'discovery-only-admin',
        },
      }
    )
    const report = JSON.parse(listed.stdout) as { errors: unknown[]; suites: ListedSuite[] }
    expect(report.errors).toEqual([])
    expect(listed.status).toBe(0)
    const identities = new Set<string>()
    const counts: Record<string, number> = {}
    function visit(suite: ListedSuite) {
      for (const spec of suite.specs || []) {
        const key = `${spec.file}:${spec.title}`
        expect(identities.has(key)).toBe(false)
        identities.add(key)
        expect(spec.tests).toHaveLength(1)
        const test = spec.tests[0]
        expect(test.expectedStatus).toBe('passed')
        const expectedProject =
          spec.file === 'global-setup.ts'
            ? 'setup'
            : spec.file === 'global-teardown.ts'
              ? 'cleanup'
              : independent.has(spec.file)
                ? 'executor-chromium'
                : 'executor-device-chromium'
        expect(test.projectName).toBe(expectedProject)
        counts[spec.file] = (counts[spec.file] || 0) + 1
      }
      for (const child of suite.suites || []) visit(child)
    }
    for (const suite of report.suites) visit(suite)
    expect(identities.size).toBe(
      Object.values(expectedCounts).reduce((total, count) => total + count, 0)
    )
    for (const deviceSetup of ['authorized', 'configure']) {
      expect(
        identities.has(
          `collaboration/issue-dispatch-executor.spec.ts:applies a marketplace template with an ${deviceSetup} project APP device and preserves edits across refresh`
        )
      ).toBe(true)
    }
    expect(
      identities.has(
        'tasks/agent-conversation-regression.spec.ts:device ClaudeCode preserves streamed text order after completion and reload'
      )
    ).toBe(true)
    expect(
      identities.has(
        'tasks/claude-background-lifecycle.spec.ts:ClaudeCode persists a child message above 1 MiB and completes after a real background notification'
      )
    ).toBe(true)
    expect(
      identities.has(
        'tasks/claude-background-lifecycle.spec.ts:Web coordinate chat runs a configured team member as a Claude subagent'
      )
    ).toBe(true)
    expect(
      identities.has(
        'tasks/agent-conversation-regression.spec.ts:Socket.IO binds a Git checkout on the first turn and reuses it on follow-up'
      )
    ).toBe(true)
    expect(
      identities.has(
        'tasks/agent-conversation-regression.spec.ts:Socket.IO rejects a whitespace-only Git URL before dispatch'
      )
    ).toBe(true)
    expect(counts).toEqual(expectedCounts)
  })
})
