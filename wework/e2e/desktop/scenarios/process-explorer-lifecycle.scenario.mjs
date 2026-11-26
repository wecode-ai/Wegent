import assert from 'node:assert/strict'

async function readSnapshot(control) {
  return JSON.parse(await control.command('getProcessExplorerWindowSnapshot', 'body'))
}

async function waitForSnapshot(control, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await readSnapshot(control)
    if (predicate(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${message}: ${JSON.stringify(latest)}`)
}

function fixtureRow(snapshot, pid) {
  return snapshot.rows.find(row => row.pid === pid) ?? null
}

/** The process count is the last number of the summary line in every locale. */
function summaryCount(snapshot) {
  const counts = [...snapshot.summary.matchAll(/\d+/g)]
  return counts.length ? Number(counts.at(-1)[0]) : Number.NaN
}

/** Totals count running rows only; other processes may come and go during the check. */
function totalsMatchRows(snapshot) {
  return summaryCount(snapshot) === snapshot.rows.filter(row => !row.exited).length
}

/** Holds a negative observation window open; it never proves an update completed. */
function observeFor(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function createDesktopScenario({ uiTimeoutMs }) {
  return {
    // Hiding and showing the explorer window must change its real visibility.
    appEnvironment: { WEWORK_E2E_BACKGROUND_WINDOW: '0' },
    async verify(control) {
      await control.command('openProcessExplorer', 'body')
      try {
        await waitForSnapshot(
          control,
          snapshot =>
            snapshot.exists &&
            snapshot.visibility === 'visible' &&
            !snapshot.testIds.includes('process-explorer-collecting') &&
            totalsMatchRows(snapshot),
          'The process explorer did not finish collecting a consistent process table',
          uiTimeoutMs
        )
        const { pid } = JSON.parse(await control.command('spawnProcessExplorerFixture', 'body'))
        assert.ok(Number.isSafeInteger(pid) && pid > 0, 'The fixture process has no PID')
        await waitForSnapshot(
          control,
          snapshot =>
            fixtureRow(snapshot, pid) !== null &&
            !fixtureRow(snapshot, pid).exited &&
            totalsMatchRows(snapshot),
          `The forked fixture process ${pid} was not listed and counted by the explorer`,
          uiTimeoutMs
        )

        await control.command('setProcessExplorerWindowHidden', 'body', { value: 'true' })
        await waitForSnapshot(
          control,
          snapshot => snapshot.visibility === 'hidden',
          'Hiding the explorer window did not hide its document',
          uiTimeoutMs
        )
        // The sample already in flight when the window was hidden may still land.
        await observeFor(1500)
        const frozen = fixtureRow(await readSnapshot(control), pid).uptime
        await observeFor(3000)
        const hidden = await readSnapshot(control)
        assert.equal(
          hidden.visibility,
          'hidden',
          'The explorer window was shown during the pause check'
        )
        assert.equal(
          fixtureRow(hidden, pid).uptime,
          frozen,
          'The explorer kept sampling while its window was hidden'
        )

        await control.command('setProcessExplorerWindowHidden', 'body', { value: 'false' })
        await waitForSnapshot(
          control,
          snapshot =>
            snapshot.visibility === 'visible' && fixtureRow(snapshot, pid)?.uptime !== frozen,
          'Showing the explorer window did not resume sampling',
          uiTimeoutMs
        )

        await control.command('stopProcessExplorerFixture', 'body')
        const exited = await waitForSnapshot(
          control,
          snapshot => fixtureRow(snapshot, pid)?.exited === true,
          'An exited process did not linger as an exited row',
          uiTimeoutMs
        )
        assert.ok(
          totalsMatchRows(exited),
          'An exited process was still counted in the explorer totals'
        )
      } finally {
        await control.command('stopProcessExplorerFixture', 'body')
        await control.command('closeProcessExplorerWindow', 'body')
      }
    },

    diagnostics() {
      return { processExplorerLifecycle: true }
    },
  }
}
