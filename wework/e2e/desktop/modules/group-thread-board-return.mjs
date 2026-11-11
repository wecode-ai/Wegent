import assert from 'node:assert/strict'

/** Verify a real board's temporary selection independently of its shared default. */
export function createBoardReturnVerification(contentSelector, uiTimeoutMs) {
  const scoped = testId => `${contentSelector} [data-testid="${testId}"]`
  const click = (control, testId) => control.command('click', scoped(testId))
  const fill = (control, testId, value) => control.command('fill', scoped(testId), { value })

  async function readSelectedView(control) {
    await click(control, 'board-view-picker')
    const selected = '[data-testid="board-view-menu"] [role="menuitemradio"][aria-checked="true"]'
    await control.command('waitFor', selected, { visible: true, timeoutMs: uiTimeoutMs })
    assert.equal(Number(await control.command('getElementCount', selected)), 1)
    const id = await control.command('getAttribute', selected, { value: 'data-testid' })
    const text = await control.command('getText', selected)
    assert.ok(id.startsWith('board-view-'))
    await control.command('press', '[data-testid="board-view-menu"]', { key: 'Escape' })
    return { id, text }
  }

  async function selectFilters(control, label) {
    await control.command('markElementWithText', `${scoped('cloud-board-group-filter')} option`, {
      text: label,
      value: 'return-board-status',
      timeoutMs: uiTimeoutMs,
    })
    const column = await control.command(
      'getAttribute',
      `${scoped('cloud-board-group-filter')} option[data-e2e-anchor-id="return-board-status"]`,
      {
        value: 'value',
      }
    )
    assert.ok(column, 'Returning must preserve a non-default status filter')
    await control.command('select', scoped('cloud-board-group-filter'), { value: column })
    await click(control, 'cloud-board-tag-filter')
    await control.command('click', '[data-testid="cloud-board-tag-filter-option-自定义/待评审"]')
    await control.command('press', '[data-testid="cloud-board-tag-filter-search"]', {
      key: 'Escape',
    })
    await fill(control, 'cloud-board-search', '统一交付')
    const selected = await readSelectedView(control)
    assert.doesNotMatch(selected.text, /默认/, 'Choose a view distinct from the shared default')
    return {
      column,
      label,
      viewId: selected.id,
      view: await control.command('getText', scoped('board-view-picker')),
    }
  }

  async function assertFilters(control, filters, threadId) {
    assert.equal(
      await control.command('getValue', scoped('cloud-board-group-filter')),
      filters.column
    )
    assert.equal(
      await control.command('getText', `${scoped('cloud-board-group-filter')} option:checked`),
      filters.label
    )
    assert.equal(await control.command('getValue', scoped('cloud-board-search')), '统一交付')
    assert.equal(await control.command('getText', scoped('board-view-picker')), filters.view)
    const selected = await readSelectedView(control)
    assert.equal(selected.id, filters.viewId, 'Returning must preserve the exact selected view')
    assert.doesNotMatch(selected.text, /默认/, 'Returning replaced the non-default view')
    await control.command(
      'waitFor',
      `${scoped(`cloud-todo-column-${filters.column}`)} [data-testid="cloud-todo-card-${threadId}"]`,
      {
        visible: true,
        timeoutMs: uiTimeoutMs,
      }
    )
    await click(control, 'cloud-board-tag-filter')
    await control.command(
      'waitFor',
      '[data-testid="cloud-board-tag-filter-option-自定义/待评审"]:checked',
      {
        timeoutMs: uiTimeoutMs,
      }
    )
    assert.equal(
      Number(
        await control.command(
          'getElementCount',
          '[data-testid="cloud-board-tag-filter-popover"] input:checked'
        )
      ),
      1,
      'Returning must preserve the exact tag selection'
    )
    await control.command('press', '[data-testid="cloud-board-tag-filter-search"]', {
      key: 'Escape',
    })
    const [toolbar] = JSON.parse(
      await control.command('getElementMetrics', `${contentSelector} .project-board-toolbar`)
    )
    assert.ok(toolbar, 'The board toolbar must expose its visible layout')
    assert.ok(
      toolbar.scrollWidth <= toolbar.clientWidth + 1,
      'Board filters must remain visible without horizontal toolbar scrolling'
    )
    for (const testId of [
      'cloud-board-group-filter-label',
      'cloud-board-tag-filter',
      'cloud-board-search',
      'board-view-picker',
    ]) {
      const [controlMetrics] = JSON.parse(
        await control.command('getElementMetrics', scoped(testId))
      )
      assert.ok(controlMetrics?.width > 0, `${testId} must remain visible`)
      assert.ok(
        controlMetrics.left >= toolbar.left - 1 && controlMetrics.right <= toolbar.right + 1,
        `${testId} was clipped outside the board toolbar`
      )
    }
  }

  return { selectFilters, assertFilters, readSelectedView }
}
