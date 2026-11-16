const MAX_FADE_PX = 16
const OVERFLOW_TOLERANCE_PX = 1

/** Keep the mask tied to current geometry, including when a draft is cleared. */
export function observeComposerScrollFade(viewport: HTMLElement, content: HTMLElement): () => void {
  const update = () => {
    const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    const overflowing = viewport.clientHeight > 0 && maximum > OVERFLOW_TOLERANCE_PX
    const top = overflowing ? Math.max(0, Math.min(maximum, viewport.scrollTop)) : 0
    const bottom = overflowing ? maximum - top : 0
    viewport.style.setProperty('--composer-scroll-fade-top', `${Math.min(MAX_FADE_PX, top)}px`)
    viewport.style.setProperty(
      '--composer-scroll-fade-bottom',
      `${Math.min(MAX_FADE_PX, bottom)}px`
    )
    viewport.toggleAttribute('data-composer-scroll-overflow', overflowing)
  }
  const observer = new ResizeObserver(update)
  observer.observe(viewport)
  observer.observe(content)
  viewport.addEventListener('scroll', update, { passive: true })
  update()

  return () => {
    observer.disconnect()
    viewport.removeEventListener('scroll', update)
    viewport.removeAttribute('data-composer-scroll-overflow')
    viewport.style.removeProperty('--composer-scroll-fade-top')
    viewport.style.removeProperty('--composer-scroll-fade-bottom')
  }
}
