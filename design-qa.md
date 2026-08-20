**Comparison Target**

- Source visual truth: `/Users/hongyu9/.wework/workspace/attachments/draft/1787208914557/image.png`
- IME defect evidence: `/Users/hongyu9/.wework/workspace/attachments/draft/1787209843976/image.png`
- Implementation screenshot: `/Volumes/OuterHD/OuterIdeaProjects/Wegent/wework/test-results/ai-verify/issue-composer-rich-editor.png`
- Rich-content screenshot: `/Volumes/OuterHD/OuterIdeaProjects/Wegent/wework/test-results/ai-verify/issue-composer-rich-editor-content.png`
- Combined comparison: `/Volumes/OuterHD/OuterIdeaProjects/Wegent/wework/test-results/ai-verify/issue-composer-comparison.png`
- State: Wework real Tauri app, light theme, local “我的任务” project, fullscreen new-Issue editor.
- Viewport and density: implementation capture `2560 × 1440` physical pixels, approximately `1280 × 720` CSS pixels at `2×`; source capture `3840 × 1996` physical pixels. Both were proportionally fitted to `1280 × 720` canvases before the side-by-side comparison.

**Full-view Comparison**

- The title, property controls, divider, editor column, footer, radii, neutral colors, and panel elevation remain consistent with the supplied screen.
- The description region now fills the available vertical space. The Markdown/file hint is anchored at the bottom of that region instead of appearing near the middle of the page.
- The plain textarea has been replaced by the existing BlockNote editor, preserving the product’s Notion-like block controls, Markdown shortcuts, slash commands, nested lists, and semantic headings.

**Focused Region Comparison**

- The supplied red-box region was inspected against the lower editor region in the implementation screenshot. The misplaced helper text is resolved and no longer indicates a prematurely ended input area.
- The editor content region was inspected in the real Tauri rich-content screenshot. Typography, spacing, foreground/background balance, and copy use existing Wework tokens; no new raster or decorative assets are involved.

**Required Fidelity Surfaces**

- Fonts and typography: existing Wework semantic typography is preserved; title, metadata, body, hint, and footer retain the expected hierarchy.
- Spacing and layout rhythm: the editor is a flex-filling region with a stable minimum height; the footer remains fixed and visible.
- Colors and visual tokens: unchanged neutral Wework tokens; no new literal application-chrome colors.
- Image quality and assets: no visual assets were added or replaced.
- Copy and content: existing localized title, placeholder, Markdown/file hint, draft status, and submit copy are preserved.

**Comparison History**

- Earlier P1: the fixed-height textarea ended around the upper half of the fullscreen panel, leaving the helper text visually stranded. Fix: made the document column and description region consume the remaining height and gave the block editor a full-height container. Post-fix evidence: `issue-composer-comparison.png`.
- Earlier P1: the fullscreen description was a raw textarea rather than a Typora/Notion-style editing surface. Fix: reused the existing BlockNote Markdown editor and retained file paste/drop behavior. Post-fix evidence: `issue-composer-rich-editor.png` and `issue-composer-rich-editor-content.png`.
- Earlier P1: confirming Chinese Pinyin with Space inside a nested list could leave intermediate pinyin and committed Chinese as separate content. Fix: editor changes are buffered during native composition and published only after WebKit finalizes `compositionend`; Space and ordinary Enter remain untouched. Post-fix evidence: focused IME regression tests.

**Interaction Verification**

- Opened the new-Issue composer and expanded it in an isolated real Tauri session.
- Verified the description is `contenteditable`, occupies the fullscreen document region, accepts content, and keeps the footer visible.
- Verified title and editor updates, draft autosave state, fullscreen layout, and rich editor rendering.
- Unit coverage verifies Markdown loading/emission, file paste/drop, draft persistence, creation, continuous creation, IME Space confirmation buffering, and first-press Enter after composition.
- Real-Tauri debug logs were checked; no browser console error was recorded for the changed flow.

**Residual Test Gap**

- Automated desktop control cannot drive the macOS Chinese candidate window itself. The composition/Space state boundary and first-press Enter behavior are covered directly in regression tests, while the same editor is verified in real Tauri.

final result: passed
