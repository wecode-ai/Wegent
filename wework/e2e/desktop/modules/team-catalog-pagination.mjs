import assert from 'node:assert/strict'
import { withTimeout } from './shared.mjs'

/** Verify the real backend catalog through the desktop selector, including older pages. */
export async function verifyTeamCatalogPagination(control, cloudRequest, sourceTeam) {
  const created = []
  try {
    for (let index = 0; index < 105; index += 1) {
      const team = await cloudRequest('/api/teams', {
        method: 'POST',
        body: JSON.stringify({
          name: `pagination-${process.pid}-${Date.now()}-${index}`,
          bots: sourceTeam.bots,
          workflow: sourceTeam.workflow,
          bind_mode: ['wework'],
          namespace: 'default',
        }),
      })
      assert.ok(team.id, 'Pagination Team fixture did not return an id')
      created.push(team)
    }
    const firstPage = await cloudRequest('/api/teams?page=1&limit=100')
    assert.equal(
      firstPage.items.some(team => team.id === sourceTeam.id),
      false
    )

    const readyCount = control.readyCount
    await control.command('reloadMainWindow', 'body')
    await withTimeout(control.awaitReadyAfter(readyCount), 30_000, 'Team catalog reload failed')
    await control.command('waitFor', '[data-testid="workbench-team-selector"]', {
      visible: true,
    })
    await control.command('click', '[data-testid="workbench-team-selector"]')
    const target = `[data-testid="workbench-team-option-${sourceTeam.id}"]`
    await control.command('waitFor', target)
    await control.command('scrollIntoView', target)
    await control.command('click', target)
    await control.command('waitFor', '[data-testid="workbench-team-selector"]', {
      text: sourceTeam.displayName || sourceTeam.name,
      visible: true,
    })
    await control.command('click', '[data-testid="workbench-team-selector"]')
    await control.command('click', '[data-testid="workbench-team-option-codex"]')
  } finally {
    const results = []
    for (let offset = 0; offset < created.length; offset += 5) {
      results.push(
        ...(await Promise.allSettled(
          created
            .slice(offset, offset + 5)
            .map(team =>
              cloudRequest(
                `/api/teams/${team.id}?force=true&confirm_name=${encodeURIComponent(team.name)}`,
                { method: 'DELETE' }
              )
            )
        ))
      )
    }
    assert.deepEqual(
      results.filter(result => result.status === 'rejected'),
      []
    )
  }
}
