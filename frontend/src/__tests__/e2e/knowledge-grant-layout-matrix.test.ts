/** @jest-environment node */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import config from '../../../playwright.config'

jest.mock('@playwright/test', () => ({
  defineConfig: (value: unknown) => value,
  devices: { 'Desktop Chrome': {} },
}))

test('discovers each grant dialog size as an independent CI case with the existing budget', () => {
  const cli = join(dirname(require.resolve('@playwright/test/package.json')), 'cli.js')
  const listed = spawnSync(
    process.execPath,
    [
      cli,
      'test',
      'knowledge/relationship-navigation.spec.ts',
      '--project=chromium',
      '--list',
      '--reporter=json',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        JEST_WORKER_ID: '',
        CI: 'true',
        E2E_BOOTSTRAP_ADMIN_PASSWORD: 'discovery-only-bootstrap',
        E2E_ADMIN_PASSWORD: 'discovery-only-admin',
      },
    }
  )
  expect(listed.status).toBe(0)
  type ListedCase = { title: string; tests: Array<{ expectedStatus: string; projectName: string }> }
  type ListedSuite = { specs?: ListedCase[]; suites?: ListedSuite[] }
  const report = JSON.parse(listed.stdout) as ListedSuite & { errors: unknown[] }
  expect(report.errors).toEqual([])
  const cases: ListedCase[] = []
  const visit = (suite: ListedSuite) => {
    cases.push(...(suite.specs ?? []))
    for (const child of suite.suites ?? []) visit(child)
  }
  visit(report)
  const layouts = cases.filter(item => item.title.startsWith('keeps expanded grant results'))
  expect(layouts.map(item => item.title).sort()).toEqual(
    ['1280x800', '375x812', '320x568', '375x480']
      .map(size => `keeps expanded grant results and actions reachable at ${size}`)
      .sort()
  )
  for (const item of layouts) {
    expect(
      item.tests.map(run => ({ project: run.projectName, status: run.expectedStatus }))
    ).toEqual([{ project: 'chromium', status: 'passed' }])
  }
  expect(config.timeout).toBe(60_000)
  expect(config.retries).toBe(0)
  expect(config.projects!.find(project => project.name === 'chromium')!.timeout).toBeUndefined()
})
