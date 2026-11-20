// @vitest-environment node
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { createBoardFocusPreference, createBoardSortPreferences } from './projectBoardPreferences'
import { useProjectBoardState } from './useProjectBoardState'

test('shared board preferences render on the server without accessing browser storage', () => {
  function Harness() {
    const state = useProjectBoardState({
      defaultGroupBy: 'priority',
      focusStorageKey: 'focus',
      personalGroupStorageKey: 'group',
      personalSortStorageKey: 'sort',
      viewScope: 'view',
    })
    return (
      <output>
        {JSON.stringify({
          group: state.groupBy,
          focus: state.focusExecutionColumns,
          sort: state.getColumnSort('high'),
        })}
      </output>
    )
  }
  const html = renderToString(<Harness />)
  expect(html).toContain('priority')
  expect(html).toContain('false')
  expect(createBoardFocusPreference('focus').getServerSnapshot()).toBe(false)
  expect(createBoardSortPreferences('sort').getServerSnapshot()).toEqual({})
})
