# Applications layout design QA

## Comparison target

- Source visual truth:
  - My: `/Users/junlong5/.codex/generated_images/01a03d17-3e77-7ef2-a61b-ba2ab3de9a90/exec-72fff9de-aa43-4eb8-92ae-2765bf454277.png`
  - Market: `/Users/junlong5/.codex/generated_images/01a03d17-3e77-7ef2-a61b-ba2ab3de9a90/exec-46eee616-97d2-4f73-8cca-99ffd9a945c5.png`
  - Site: `/Users/junlong5/.codex/generated_images/01a03d17-3e77-7ef2-a61b-ba2ab3de9a90/exec-9be266aa-53d7-415f-be2f-dfd5709c5ba2.png`
  - Mini Program: `/Users/junlong5/.codex/generated_images/01a03d17-3e77-7ef2-a61b-ba2ab3de9a90/exec-f3bb0013-fcbe-4036-b20c-eb4a9bad8a13.png`
- Rendered implementation:
  - Market: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/design-qa/market-iteration-1.png`
  - My empty: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/design-qa/owned-iteration-1.png`
  - My with card: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/design-qa/owned-card-iteration-1.png`
  - Site: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/design-qa/site-iteration-1.png`
  - Mini Program: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/design-qa/miniapp-iteration-1.png`

## Environment and normalization

- Runtime: isolated packaged Electron application, local-first mode, light theme, Chinese locale.
- CSS viewport: `1386 x 869`; implementation capture: `2772 x 1738`; `deviceScaleFactor: 2`.
- Source visuals: `1584 x 993`; conceptual desktop density `1`.
- Both sets use the same desktop aspect ratio. Comparisons were normalized by full-frame aspect ratio and application content bounds. Geometry findings use Electron CSS-pixel metrics, not raw image pixels.
- State: disconnected cloud marketplace, local owned collection, unavailable Site and Mini Program services.

## Full-view comparison evidence

The four source images and five Electron captures covering four application states were opened together in the same comparison input. The implementation preserves the selected visual hierarchy: constant Applications header, invariant primary tabs, one aligned context toolbar, matching neutral controls, and a shared bordered content surface.

Measured Electron geometry across Market, My, Site, and Mini Program:

- Shared content container: `1120px` wide.
- Context toolbar: `1056 x 36`, `left: 285`, `top: 242.8828125` in every state.
- Site and Mini Program unavailable surfaces: `1056 x 320`, `left: 285`, `top: 298.8828125`.
- Owned card: `520 x 211`; with the `16px` grid gap, two tracks resolve exactly to `(1056 - 16) / 2 = 520px`.

No horizontal or vertical layout shift was observed while switching all four states.

## Focused region comparison evidence

- Header and action slot: the My actions align with the title block and retain outline/primary hierarchy; Site and Mini Program use the same inverse-neutral Create control.
- Primary and secondary navigation: the application underline tabs remain fixed while Market/My use the selected segmented control treatment.
- Toolbar: search, marketplace selects, and owned filters share the same height, radius, border, and focus token.
- Empty states: Market, Site, and Mini Program share one 320px surface and icon/title/body rhythm, with state-specific copy.
- Card: the isolated created-workbench fixture confirms the target two-column width, 211px height, icon/title hierarchy, semantic status color, divider, model selector, and right-aligned action group.

## Findings

- No actionable P0, P1, or P2 differences remain.
- P3: the isolated My capture contains one created card rather than the two installed cards in the source. This is test-data variance; grid metrics and a rendered real card confirm the selected two-column geometry.

Required fidelity surfaces:

- Fonts and typography: existing Wework font stack, semantic sizes, weights, line heights, truncation, and wrapping match the source hierarchy.
- Spacing and layout rhythm: shared width, fixed toolbar position, 16px card gap, surface radius, borders, and vertical rhythm match the selected design.
- Colors and tokens: neutral application chrome, blue experimental badge/focus, and green semantic runtime state are correctly scoped.
- Image quality and assets: no raster product imagery is required; all visible symbols use the existing Lucide icon library and render sharply at `@2x`.
- Copy and content: constant Applications title/subtitle and state-specific marketplace/Site/Mini Program copy match the approved direction.
- Accessibility and responsiveness: semantic tabs and labels are retained, focus rings use shared tokens, desktop controls are 36px, and mobile variants remain at least 44px.

## Interaction and runtime checks

- Switched Market to My and back through the segmented navigation.
- Switched Smart Workbench, Site, and Mini Program through the primary tab list.
- Exercised the owned `Installed` zero-result filter and recovered with `All`.
- Created an isolated blank workbench and verified the resulting real card.
- Verified disconnected marketplace, Site unavailable, and Mini Program unavailable states.
- Electron debug snapshot reported `workbench.error: null` and no runtime logs.
- The isolated Electron session was stopped and the temporary fixture directory was moved to Trash.

## Comparison history

- Pass 1: compared all four valid post-build Electron captures with their source visuals. No P0/P1/P2 findings were identified, so no post-comparison visual fix iteration was required.
- A pre-build stale package capture was discarded as build troubleshooting and was not used as design-QA evidence.

## Implementation checklist

- [x] Constant header and 1120px application shell
- [x] Fixed primary tabs and header action slot
- [x] Shared 36px context toolbar in all four states
- [x] Segmented Market/My navigation
- [x] Equal two-column card geometry and aligned actions
- [x] State-specific unavailable copy and icons
- [x] Real Electron interaction, geometry, screenshot, and error verification

final result: passed
