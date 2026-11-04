import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { extractZipFixture } from './zip-fixtures.mjs'

const TOGGLE = '[data-testid="general-performance-recording-toggle"]'
const ARCHIVE_LOG = 'logs/app/performance.log'
const SAMPLE_TYPE = 'performance-sample'

async function readRecords(path) {
  const content = await readFile(path, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  return content
    .split('\n')
    .slice(0, -1)
    .filter(Boolean)
    .map(line => JSON.parse(line.slice(line.indexOf('{'))))
}

async function waitForRecords(path, inspect, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  let records = []
  while (Date.now() < deadline) {
    records = await readRecords(path)
    if (inspect(records)) return records
    await delay(100)
  }
  assert.fail(`${message}; records=${JSON.stringify(records)}`)
}

async function openSettings(control, enabled) {
  await control.command('navigate', 'body', { value: '/settings/general' })
  await control.command('waitFor', `${TOGGLE}[aria-checked="${enabled}"]:not(:disabled)`)
}

export async function verifyPerformanceRecording(
  control,
  { electronUserDataDirectory, restartDesktopApp, uiTimeoutMs }
) {
  const preferencePath = join(electronUserDataDirectory, 'app-preferences.json')
  const logPath = join(electronUserDataDirectory, 'logs', 'performance.log')
  await openSettings(control, false)
  assert.equal(
    JSON.parse(await readFile(preferencePath, 'utf8')).performanceRecordingEnabled ?? false,
    false,
    'Performance recording must be disabled in a new device profile'
  )
  await assert.rejects(stat(logPath), { code: 'ENOENT' })

  await control.command('click', TOGGLE)
  await control.command('waitFor', `${TOGGLE}[aria-checked="true"]:not(:disabled)`)
  assert.equal(
    JSON.parse(await readFile(preferencePath, 'utf8')).performanceRecordingEnabled,
    true,
    'The recording switch did not persist its device preference'
  )
  const initial = await waitForRecords(
    logPath,
    records => records.some(record => record.type === SAMPLE_TYPE),
    uiTimeoutMs,
    'Enabling recording did not produce a sample on disk'
  )
  const firstSample = initial.find(record => record.type === SAMPLE_TYPE)
  assert.ok(firstSample.system.memoryTotalBytes > 0)
  assert.ok(firstSample.system.memoryAvailableBytes >= 0)
  assert.ok(firstSample.appVersion)
  assert.ok(firstSample.processes.some(process => process.pid === firstSample.applicationPid))
  await waitForRecords(
    logPath,
    records =>
      records.filter(record => record.type === SAMPLE_TYPE).length >
      initial.filter(record => record.type === SAMPLE_TYPE).length,
    uiTimeoutMs,
    'Recording did not continue sampling after the first snapshot'
  )

  // A real Electron restart must resume sampling without another renderer toggle.
  await restartDesktopApp()
  await openSettings(control, true)
  const afterRestart = await waitForRecords(
    logPath,
    records =>
      records.some(
        record =>
          record.type === SAMPLE_TYPE && record.applicationPid !== firstSample.applicationPid
      ),
    uiTimeoutMs,
    'Performance recording did not resume after restarting Electron'
  )
  assert.ok(
    afterRestart.some(
      record =>
        record.type === SAMPLE_TYPE &&
        record.applicationPid === firstSample.applicationPid &&
        record.timestamp === firstSample.timestamp
    ),
    'Restarting Electron discarded the performance history from the previous process'
  )

  await control.command('click', TOGGLE)
  await control.command('waitFor', `${TOGGLE}[aria-checked="false"]:not(:disabled)`)
  assert.equal(
    JSON.parse(await readFile(preferencePath, 'utf8')).performanceRecordingEnabled,
    false,
    'Disabling recording did not persist its device preference'
  )
  const stoppedContent = await readFile(logPath, 'utf8')
  // Observe a complete sampling interval: disabling must stop writes, retaining history.
  await delay(5500)
  assert.equal(await readFile(logPath, 'utf8'), stoppedContent)

  // Use the product's preview and local export flow, without sending feedback.
  await control.command('navigate', 'body', { value: '/' })
  await control.command('waitFor', '[data-testid="task-feedback-button"]')
  await control.command('click', '[data-testid="task-feedback-button"]')
  await control.command('fill', '[data-testid="task-feedback-note"]', {
    value: 'Performance recording E2E: inspect the resources recorded before restart.',
  })
  await control.command('click', '[data-testid="task-feedback-export-button"]')
  await control.command('waitFor', '[data-testid="task-feedback-preview-list"]')
  await control.command('click', '[data-testid="task-feedback-preview-category-logs"]')
  await control.command('waitFor', `[data-testid="task-feedback-preview-entry-${ARCHIVE_LOG}"]`)
  await control.command('click', `[data-testid="task-feedback-preview-entry-${ARCHIVE_LOG}"]`)
  await control.command('waitFor', '[data-testid="task-feedback-preview-content"]', {
    text: '"type":"performance-sample"',
  })
  await control.command('click', '[data-testid="task-feedback-confirm-button"]')
  await control.command('waitFor', '[data-testid="task-feedback-cancel-button"]')
  const exportedPath = await control.command(
    'getText',
    '[data-testid="task-feedback-dialog-overlay"] p.break-all'
  )
  const extractionDirectory = await mkdtemp(
    join(electronUserDataDirectory, '.performance-recording-export-')
  )
  try {
    await extractZipFixture(exportedPath.trim(), extractionDirectory)
    assert.equal(
      await readFile(join(extractionDirectory, ARCHIVE_LOG), 'utf8'),
      stoppedContent,
      'The exported diagnostic bundle did not preserve the on-disk performance history'
    )
  } finally {
    await rm(extractionDirectory, { recursive: true, force: true })
  }
  await control.command('click', '[data-testid="task-feedback-cancel-button"]')
  console.log('[desktop-e2e] PASS performance recording: switch, restart, stop and local export')
}
