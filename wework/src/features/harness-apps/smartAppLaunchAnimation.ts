interface SmartAppLaunchAnimationOptions {
  origin: DOMRect | null
  title: string
}

export async function animateSmartAppIntoTab({
  origin,
  title,
}: SmartAppLaunchAnimationOptions): Promise<void> {
  if (
    !origin ||
    typeof HTMLElement.prototype.animate !== 'function' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    return
  }
  const target = document.querySelector<HTMLElement>('[data-testid="workspace-tab-add"]')
  if (!target) return

  const targetRect = target.getBoundingClientRect()
  const token = document.createElement('div')
  token.dataset.testid = 'smart-app-launch-token'
  token.className =
    'pointer-events-none fixed z-system-popover flex h-8 max-w-48 items-center gap-2 overflow-hidden rounded-lg border border-border/70 bg-popover/95 px-2.5 text-sm font-medium text-text-primary shadow-lg backdrop-blur-md'
  token.style.left = `${origin.left}px`
  token.style.top = `${origin.top}px`

  const icon = document.createElement('span')
  icon.className =
    'flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted text-xs text-text-secondary'
  icon.textContent = '◇'
  const label = document.createElement('span')
  label.className = 'truncate'
  label.textContent = title
  token.append(icon, label)
  document.body.append(token)

  const deltaX = targetRect.left + targetRect.width / 2 - origin.left - token.offsetWidth / 2
  const deltaY = targetRect.top + targetRect.height / 2 - origin.top - token.offsetHeight / 2
  const isDesktopE2E = import.meta.env.VITE_WEWORK_E2E === 'true'
  const duration = isDesktopE2E ? 30_000 : 460
  const animation = token.animate(
    [
      { opacity: 0, transform: 'translate(0, 8px) scale(0.94)' },
      { opacity: 1, offset: 0.18, transform: 'translate(0, 0) scale(1)' },
      {
        opacity: 0.96,
        offset: 0.76,
        transform: `translate(${deltaX * 0.82}px, ${deltaY * 0.82}px) scale(0.86)`,
      },
      { opacity: 0, transform: `translate(${deltaX}px, ${deltaY}px) scale(0.58)` },
    ],
    {
      duration,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'forwards',
    }
  )
  if (isDesktopE2E) {
    void animation.finished.finally(() => token.remove())
    return
  }
  let fallbackTimer: number | undefined
  try {
    await Promise.race([
      animation.finished.catch(() => undefined),
      new Promise<void>(resolve => {
        fallbackTimer = window.setTimeout(resolve, duration + 100)
      }),
    ])
  } finally {
    if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer)
    token.remove()
  }
}
