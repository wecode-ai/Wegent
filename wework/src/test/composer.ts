import { act } from '@testing-library/react'

/** Use the shared editor's value API; DOM change events belong to native inputs. */
export function setComposerValue(element: HTMLElement, value: string) {
  act(() => {
    ;(element as HTMLElement & { value: string }).value = value
  })
}
