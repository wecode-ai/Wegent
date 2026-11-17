import { afterEach, expect, it, vi } from 'vitest'
import { waitForProjectCreateClosed } from '../../e2e/desktop/modules/project-create-dialog-navigation.mjs'
import { runDesktopControlClient } from './automation'

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('waits for the active dialog to unmount even when its submission form is hidden', async () => {
  document.body.innerHTML = `
    <section data-workspace-tab-content aria-hidden="false">
      <section data-testid="collaboration-project-create-dialog">
        <form hidden><button data-testid="collaboration-project-create-confirm">Create</button></form>
        <div data-testid="collaboration-project-create-discard">Discard draft?</div>
      </section>
    </section>
    <section data-workspace-tab-content aria-hidden="true">
      <section data-testid="collaboration-project-create-dialog">Another tab's draft</section>
    </section>`
  const content = '[data-workspace-tab-content][aria-hidden="false"]'
  const dialog = document.querySelector(
    `${content} [data-testid="collaboration-project-create-dialog"]`
  )!
  let closed = false
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  const results: Array<{ ok: boolean; closed: boolean }> = []
  try {
    await waitForProjectCreateClosed(
      {
        async command(action: string, selector: string, options: { timeoutMs: number }) {
          let polls = 0
          vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
            if (url.includes('/commands?')) {
              if (++polls > 1) return Promise.resolve(new Response(null, { status: 410 }))
              closeTimer = setTimeout(() => {
                dialog.remove()
                closed = true
              }, 32)
              return Promise.resolve(
                Response.json({ id: 'creation-closed', action, selector, ...options })
              )
            }
            if (url.endsWith('/results')) {
              results.push({ ...JSON.parse(String(init?.body)), closed })
            }
            return Promise.resolve(new Response('{}'))
          })
          await runDesktopControlClient('http://127.0.0.1:43111', 'main')
        },
      },
      content,
      10_000
    )
    expect(results).toEqual([expect.objectContaining({ ok: true, closed: true })])
    expect(
      document.querySelectorAll('[data-testid="collaboration-project-create-dialog"]')
    ).toHaveLength(1)
  } finally {
    clearTimeout(closeTimer)
  }
})
