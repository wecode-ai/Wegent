import assert from 'node:assert/strict'

function dateKey(value) {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addDays(value, days) {
  const next = new Date(value)
  next.setDate(next.getDate() + days)
  return next
}

function nextMonday() {
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const daysUntilMonday = (8 - today.getDay()) % 7 || 7
  return addDays(today, daysUntilMonday)
}

function monthGridContains(month, target) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const leadingDays = (first.getDay() + 6) % 7
  const gridStart = addDays(first, -leadingDays)
  const gridEnd = addDays(gridStart, 41)
  return target >= gridStart && target <= gridEnd
}

async function waitForAttributeIncludes(
  control,
  selector,
  attribute,
  expected,
  message,
  timeoutMs
) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await control.command('getAttribute', selector, { value: attribute })
    if (latest?.includes(expected)) return latest
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${message}: ${JSON.stringify(latest)}`)
}

function monthIndex(year, month) {
  return Number(year) * 12 + Number(month)
}

function visibleMonthIndex(title) {
  const match = /(\d{4})年(\d{1,2})月/.exec(title ?? '')
  return match ? monthIndex(match[1], match[2]) : null
}

// The month grid only renders the six weeks around one month, so a day a week
// past the first task can sit outside it. Follow the month title instead of
// clicking blindly, so an overshooting navigation is corrected as well.
async function revealCalendarDay(control, scoped, day, timeoutMs) {
  const selector = scoped(`[data-testid="collaboration-calendar-day-${day}"]`)
  const title = scoped('[data-testid="collaboration-calendar"] h1')
  const target = monthIndex(day.slice(0, 4), day.slice(5, 7))
  const deadline = Date.now() + timeoutMs
  let visible = null
  while (Date.now() < deadline) {
    if (Number(await control.command('getElementCount', selector)) > 0) return selector
    visible = visibleMonthIndex(await control.command('getText', title))
    const direction = visible === null || target >= visible ? 'next' : 'previous'
    await control.command('click', scoped(`[data-testid="collaboration-schedule-${direction}"]`))
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  assert.fail(`The calendar never rendered ${day} (visible month index ${visible})`)
}

export async function verifyCollaborationScheduleViews({
  capture,
  control,
  issueTitle,
  scoped,
  timeoutMs,
}) {
  await control.command('setMainWindowSize', 'body', {
    value: JSON.stringify({ width: 1440, height: 900 }),
  })
  const initialStart = nextMonday()
  const initialEnd = addDays(initialStart, 2)
  const calendarStart = addDays(initialStart, 7)
  const calendarEnd = addDays(calendarStart, 2)
  const resizedEnd = addDays(calendarEnd, 1)
  const movedStart = calendarEnd
  const movedEnd = addDays(resizedEnd, 2)
  const keys = Object.fromEntries(
    Object.entries({
      initialStart,
      initialEnd,
      calendarStart,
      calendarEnd,
      resizedEnd,
      movedStart,
      movedEnd,
    }).map(([key, value]) => [key, dateKey(value)])
  )

  await control.command('click', scoped('[aria-label="时间范围"]'))
  await control.command('waitFor', '[data-testid="cloud-todo-detail-start-date"]', {
    visible: true,
    timeoutMs,
  })
  await control.command('fill', '[data-testid="cloud-todo-detail-start-date"]', {
    value: keys.initialStart,
  })
  await control.command('fill', '[data-testid="cloud-todo-detail-due-date"]', {
    value: keys.initialEnd,
  })
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-save"]'), {
    timeoutMs,
  })
  await control.command('waitFor', scoped('[data-testid="cloud-todo-save"]'), {
    visible: false,
    timeoutMs,
  })
  await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
  await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
    visible: false,
    timeoutMs,
  })

  await control.command('click', scoped('[data-testid="collaboration-calendar-tab"]'))
  await control.command('waitFor', scoped('[data-testid="collaboration-calendar"]'), {
    visible: true,
    timeoutMs,
  })
  await control.command('select', scoped('[data-testid="collaboration-calendar-status-filter"]'), {
    value: 'inbox',
  })
  await control.command('select', scoped('[data-testid="collaboration-calendar-group-by"]'), {
    value: 'status',
  })
  await control.command(
    'waitFor',
    scoped('[data-testid="collaboration-calendar-save-view-options"]'),
    {
      visible: true,
      timeoutMs,
    }
  )
  await control.command(
    'clickWhenEnabled',
    scoped('[data-testid="collaboration-calendar-save-view-options"]'),
    { timeoutMs }
  )
  await control.command(
    'waitFor',
    scoped('[data-testid="collaboration-calendar-save-view-options"]'),
    {
      visible: false,
      timeoutMs,
    }
  )

  const calendarTarget = await revealCalendarDay(control, scoped, keys.calendarStart, timeoutMs)
  await control.command('waitFor', calendarTarget, { visible: true, timeoutMs })

  const calendarBar = scoped('[data-testid^="collaboration-calendar-issue-"]')
  await control.command('waitFor', calendarBar, {
    text: issueTitle,
    visible: true,
    timeoutMs,
  })
  await waitForAttributeIncludes(
    control,
    calendarBar,
    'title',
    `${keys.initialStart} → ${keys.initialEnd}`,
    'The calendar did not render the saved start-to-end range',
    timeoutMs
  )
  if (!monthGridContains(new Date(), calendarStart)) {
    await control.command('click', scoped('[aria-label="下一个月"]'))
    await control.command(
      'waitFor',
      scoped(`[data-testid="collaboration-calendar-day-${keys.calendarStart}"]`),
      { visible: true, timeoutMs }
    )
  }
  await capture(control, 'offline-local-project-space-02-calendar-schedule.png')
  await control.command('drag', `${calendarBar} > button:not([data-testid])`, {
    target: calendarTarget,
    timeoutMs,
  })
  await waitForAttributeIncludes(
    control,
    calendarBar,
    'title',
    `${keys.calendarStart} → ${keys.calendarEnd}`,
    'Dragging the calendar bar did not move the complete task range',
    timeoutMs
  )

  await control.command('click', scoped('[data-testid="collaboration-gantt-tab"]'))
  await control.command('waitFor', scoped('[data-testid="collaboration-gantt"]'), {
    visible: true,
    timeoutMs,
  })
  assert.equal(
    await control.command('getValue', scoped('[data-testid="collaboration-gantt-group-by"]')),
    'status',
    'The Gantt view did not inherit the saved project view configuration'
  )
  const ganttBar = scoped(
    '[data-testid^="collaboration-gantt-issue-"]:not([data-testid$="-handle"])'
  )
  await control.command('waitFor', ganttBar, {
    visible: true,
    timeoutMs,
  })
  await control.command(
    'hover',
    scoped(`[data-testid^="collaboration-gantt-row-"] button[aria-label="${issueTitle}"]`)
  )
  await control.command('waitFor', '[data-testid^="collaboration-gantt-title-tooltip-"]', {
    text: issueTitle,
    visible: true,
    timeoutMs,
  })
  await control.command('hover', ganttBar)
  await control.command(
    'waitFor',
    scoped('[data-testid^="collaboration-gantt-issue-"][data-testid$="-start-handle"]'),
    { timeoutMs }
  )
  const ganttEndHandle = scoped(
    '[data-testid^="collaboration-gantt-issue-"][data-testid$="-end-handle"]'
  )
  const ganttRow = scoped('[data-testid^="collaboration-gantt-row-"]')
  assert.equal(
    await control.command('getComputedStyleValue', ganttEndHandle, { value: 'cursor' }),
    'ew-resize',
    'Hovering the Gantt bar did not expose a horizontal resize handle'
  )
  await control.command('dragBy', ganttEndHandle, {
    value: JSON.stringify({ x: 20, y: 0 }),
  })
  await waitForAttributeIncludes(
    control,
    ganttBar,
    'title',
    `${keys.calendarStart} → ${keys.resizedEnd}`,
    'Dragging the Gantt end handle did not update the end date',
    timeoutMs
  )
  await control.command('drag', `${ganttBar} > button:not([data-testid])`, {
    target: `${ganttRow} [data-testid$="-day-${keys.movedStart}"]`,
    timeoutMs,
  })
  await waitForAttributeIncludes(
    control,
    ganttBar,
    'title',
    `${keys.movedStart} → ${keys.movedEnd}`,
    'Dragging the complete Gantt bar did not preserve its duration',
    timeoutMs
  )
  await capture(control, 'offline-local-project-space-03-gantt-schedule.png')

  await control.command('click', scoped('[data-testid="collaboration-tab-table"]'))
  await control.command('waitFor', scoped('[data-testid="collaboration-issue-table"]'), {
    text: issueTitle,
    visible: true,
    timeoutMs,
  })
  const tableText = await control.command(
    'getText',
    scoped('[data-testid="collaboration-issue-table"]')
  )
  assert.ok(
    tableText.includes('开始时间') && tableText.includes('结束时间'),
    'The table did not expose start and end date columns by default'
  )
  assert.equal(
    tableText.includes('分配来源'),
    false,
    'The table still exposed assignment source instead of schedule columns'
  )
  const titleSort = scoped('[data-testid="collaboration-issue-table-sort-title"]')
  await control.command('click', titleSort)
  assert.equal(
    await control.command(
      'getAttribute',
      `${scoped('[data-testid="collaboration-issue-table"]')} th:has([data-testid="collaboration-issue-table-sort-title"])`,
      { value: 'aria-sort' }
    ),
    'ascending',
    'Clicking the title header did not enable ascending table sorting'
  )
  await capture(control, 'offline-local-project-space-04-table.png')

  const rowCheckbox = scoped(
    '[data-testid^="collaboration-issue-table-select-"]:not([data-testid="collaboration-issue-table-select-all"])'
  )
  await control.command('click', rowCheckbox)
  await control.command(
    'select',
    scoped('[data-testid="collaboration-issue-table-batch-status"]'),
    {
      value: 'completed',
    }
  )
  await control.command(
    'clickWhenEnabled',
    scoped('[data-testid="collaboration-issue-table-batch-apply"]'),
    { timeoutMs }
  )
  await control.command('waitFor', scoped('[data-testid="collaboration-issue-table-batch"]'), {
    visible: false,
    timeoutMs,
  })
  await control.command('click', rowCheckbox)
  await control.command(
    'clickWhenEnabled',
    scoped('[data-testid="collaboration-issue-table-batch-delete"]'),
    { timeoutMs }
  )
  await control.command('waitFor', '[data-testid="collaboration-issue-archive-dialog"]', {
    visible: true,
    timeoutMs,
  })
  await control.command('clickWhenEnabled', '[data-testid="collaboration-issue-archive-confirm"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="collaboration-issue-archive-dialog"]', {
    visible: false,
    timeoutMs,
  })
}
