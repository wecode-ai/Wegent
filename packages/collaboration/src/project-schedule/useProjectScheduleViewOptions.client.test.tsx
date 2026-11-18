// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import type { CollaborationProject } from '../types'
import { defaultScheduleViewOptions } from './model'
import { useProjectScheduleViewOptions } from './useProjectScheduleViewOptions'

let container: HTMLDivElement
let root: Root | undefined
let options!: ReturnType<typeof useProjectScheduleViewOptions>
const project = (id: string, user = 1) =>
  ({
    id,
    project_store: 'local',
    current_user_id: user,
  }) as CollaborationProject
function Probe({ value }: { value: CollaborationProject }) {
  options = useProjectScheduleViewOptions(value)
  return (
    <span>
      {options.options.status}:{options.options.groupBy}
    </span>
  )
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  localStorage.clear()
  container = document.createElement('div')
  document.body.append(container)
  root = undefined
})
afterEach(() => {
  act(() => root?.unmount())
  container.remove()
  localStorage.clear()
})

test('switching projects and users never displays another scope personal options', () => {
  localStorage.setItem(
    'collaboration-schedule-view:local:A:1',
    JSON.stringify({ ...defaultScheduleViewOptions, status: 'pending' })
  )
  localStorage.setItem(
    'collaboration-schedule-view:local:B:1',
    JSON.stringify({ ...defaultScheduleViewOptions, groupBy: 'priority' })
  )
  root = createRoot(container)
  act(() => root!.render(<Probe value={project('A')} />))
  expect(options.options.status).toBe('pending')
  act(() => root!.render(<Probe value={project('B')} />))
  expect(options.options.groupBy).toBe('priority')
  expect(options.options.status).toBe(defaultScheduleViewOptions.status)
  act(() => root!.render(<Probe value={project('A', 2)} />))
  expect(options.options).toEqual(defaultScheduleViewOptions)
})

test('changes and resets persist under the current scope', () => {
  root = createRoot(container)
  act(() => root!.render(<Probe value={project('A')} />))
  act(() => options.changeOptions({ ...defaultScheduleViewOptions, status: 'pending' }))
  expect(options.options.status).toBe('pending')
  expect(options.hasPersonalOverride).toBe(true)
  expect(JSON.parse(localStorage.getItem('collaboration-schedule-view:local:A:1')!).status).toBe(
    'pending'
  )
  act(() => options.resetOptions())
  expect(options.options).toEqual(defaultScheduleViewOptions)
  expect(localStorage.getItem('collaboration-schedule-view:local:A:1')).toBeNull()
})

test('hydration keeps the server snapshot stable before loading personal options', async () => {
  localStorage.setItem(
    'collaboration-schedule-view:local:A:1',
    JSON.stringify({ ...defaultScheduleViewOptions, status: 'pending' })
  )
  container.innerHTML = renderToString(<Probe value={project('A')} />)
  expect(options.options).toEqual(defaultScheduleViewOptions)
  const onRecoverableError = vi.fn()
  await act(async () => {
    root = hydrateRoot(container, <Probe value={project('A')} />, {
      onRecoverableError,
    })
  })
  expect(options.options.status).toBe('pending')
  expect(onRecoverableError).not.toHaveBeenCalled()
})
