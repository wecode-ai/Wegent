import { act, render, screen } from '@testing-library/react'
import { Suspense, useEffect } from 'react'
import { expect, test, vi } from 'vitest'
import { AssistantMarkdown } from '../../../../packages/collaboration/src/markdown/AssistantMarkdown'

const renderer = vi.hoisted(() => {
  let release: () => void = () => {}
  const pending = new Promise<void>(resolve => {
    release = resolve
  })
  return { pending, release, load: vi.fn() }
})

vi.mock('../../../../packages/collaboration/src/markdown/AssistantMarkdownRenderer', async () => {
  renderer.load()
  await renderer.pending
  return {
    AssistantMarkdown: ({ content }: { content: string }) => <p>{content}</p>,
  }
})

function StartupSurface({ content, onReady }: { content?: string; onReady: () => void }) {
  useEffect(onReady, [onReady])
  return content ? <AssistantMarkdown content={content} /> : <p>Empty task launcher</p>
}

test('loads Markdown only for content and commits startup readiness after restored content', async () => {
  const blankReady = vi.fn()
  const restoredReady = vi.fn(() => {
    expect(screen.getByText('Restored answer')).toBeVisible()
  })
  const { rerender } = render(
    <Suspense fallback={<p>Loading restored renderer</p>}>
      <StartupSurface key="blank" onReady={blankReady} />
    </Suspense>
  )

  expect(screen.getByText('Empty task launcher')).toBeVisible()
  expect(blankReady).toHaveBeenCalledOnce()
  expect(renderer.load).not.toHaveBeenCalled()

  await act(async () => {
    rerender(
      <Suspense fallback={<p>Loading restored renderer</p>}>
        <StartupSurface key="restored" content="Restored answer" onReady={restoredReady} />
      </Suspense>
    )
    await Promise.resolve()
  })
  expect(screen.getByText('Loading restored renderer')).toBeVisible()
  expect(restoredReady).not.toHaveBeenCalled()

  await act(async () => {
    renderer.release()
    await vi.dynamicImportSettled()
  })
  expect(renderer.load).toHaveBeenCalledOnce()
  expect(screen.getByText('Restored answer')).toBeVisible()
  expect(restoredReady).toHaveBeenCalledOnce()
})
