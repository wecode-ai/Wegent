---
sidebar_position: 20
---

# Wework Startup Animation

## Goal

Replace the blank Wework window shown while React mounts and authentication state is restored with a branded Logo drawing animation.

## Visual Sequence

The startup layer shows the blue transparent `We >_` Logo in this order:

1. Draw the `W` stroke
2. Draw the `e` stroke
3. Draw the `>` stroke
4. Draw the `_` stroke
5. Transition the strokes into the solid blue Logo
6. Fade out when the first application page is ready

The target duration is 1.4 to 1.8 seconds. If the page becomes ready earlier, the animation still reaches the completed Logo to avoid flashing. If the page takes longer, the completed Logo remains visible until readiness.

## Implementation

- Inline the startup layer in `wework/index.html` so it is visible before JavaScript and React load.
- Use SVG paths extracted from the current brand artwork.
- Animate drawing with CSS `stroke-dasharray` and `stroke-dashoffset`.
- Keep the startup layer after React mounts until authentication restoration determines the first page.
- Apply an exit state when ready, then remove the startup node after its fade-out transition.
- Match light and dark page backgrounds to prevent a white flash.
- Under `prefers-reduced-motion: reduce`, skip path drawing, show the completed Logo, and fade it out when ready.

## Readiness Signal

The application routing layer emits readiness when:

- The login or OIDC callback page completes its first render.
- Authentication loading finishes and determines the authenticated or unauthenticated state.
- The authenticated application shell completes its first render.

The startup layer does not wait for later workbench network requests, preventing API failures from leaving it permanently visible.

## Verification

- Cold startup never shows an empty white window.
- Animation order is `W → e → > → _ → fill`.
- Login, authenticated, and OIDC callback paths all remove the startup layer.
- Slow authentication keeps the startup layer visible without content flashing.
- Reduced-motion mode disables path drawing.
- macOS, Windows, and iOS WebViews render it correctly.
