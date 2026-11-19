import { useLayoutEffect, useRef } from 'react'
import { useCollaborationPortalTheme } from '../theme'

export function useIssueTitleSize({
  value,
  issueId,
  editing,
  expanded,
  workspacePanel,
}: {
  value: string
  issueId: string | null
  editing: boolean
  expanded: boolean
  workspacePanel: boolean
}) {
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const theme = useCollaborationPortalTheme()
  useLayoutEffect(() => {
    const textarea = titleRef.current
    if (!textarea) return
    const resize = () => {
      textarea.style.height = 'auto'
      if (textarea.scrollHeight > 0)
        textarea.style.height = `${textarea.scrollHeight}px`
    }
    resize()
    let observedWidth = textarea.parentElement?.clientWidth ?? 0
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      if (width === observedWidth) return
      observedWidth = width
      resize()
    })
    if (textarea.parentElement) observer.observe(textarea.parentElement)
    // Hosts apply appearance tokens at the document root or scoped theme provider.
    const typography = new MutationObserver(resize)
    typography.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class'],
    })
    document.fonts?.addEventListener('loadingdone', resize)
    window.addEventListener('resize', resize)
    return () => {
      observer.disconnect()
      typography.disconnect()
      document.fonts?.removeEventListener('loadingdone', resize)
      window.removeEventListener('resize', resize)
    }
  }, [issueId, editing, expanded, value, workspacePanel, theme.style])
  return titleRef
}
