/** Track actual mounted surfaces and their geometry on each animation frame. */
export function createElementFrameSampler(root: HTMLElement, selector: string) {
  const identities = new WeakMap<Element, number>()
  let nextIdentity = 0
  return () =>
    Array.from(root.querySelectorAll<HTMLElement>(selector), element => {
      if (!identities.has(element)) identities.set(element, ++nextIdentity)
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      const track = element.closest('.issue-conversation-drawers')
      const trackStyle = track ? getComputedStyle(track) : null
      return {
        identity: identities.get(element),
        className: element.className,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        scrollLeft: element.scrollLeft,
        scrollTop: element.scrollTop,
        display: style.display,
        transform: style.transform,
        border: [
          style.borderTopWidth,
          style.borderRightWidth,
          style.borderBottomWidth,
          style.borderLeftWidth,
        ],
        radius: style.borderRadius,
        reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        trackTransition: trackStyle
          ? { duration: trackStyle.transitionDuration, property: trackStyle.transitionProperty }
          : null,
        trackAnimations: (track?.getAnimations() ?? []).map(animation => ({
          time: animation.currentTime,
          state: animation.playState,
        })),
        animations: element.getAnimations().map(animation => ({
          time: animation.currentTime,
          state: animation.playState,
        })),
      }
    })
}
