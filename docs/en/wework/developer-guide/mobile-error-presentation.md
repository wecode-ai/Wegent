---
sidebar_position: 12
---

# Mobile error presentation

Use `showErrorAlert` for failed operations, `NativeErrorAlert` for state-driven actionable failures,
and `ErrorNotice` beside persistent page, form, settings or transcript errors. Do not create another
screen-specific error style.

## Platform behavior

- Background connection, discovery and list-read failures appear only as a retry badge on the
  sidebar avatar. Do not show alerts or repeat the failure on other screens. Tapping retries reads,
  keeps the badge during recovery and removes it on success. Settings remain accessible.
- After initial loading, list snapshots update through pull-to-refresh, retry, explicit device
  selection or an accepted user operation. Foreground transitions, socket reconnection, task events
  and token renewal do not refresh lists. Active conversation streaming remains independent.
- React Native `Alert` uses the native UIKit alert on iOS and native Android alert. The platform owns
  appearance, system theme, text scaling, button layout and accessibility. Android receives at most
  three buttons, in neutral/negative/positive order. Retrying always requires an explicit action.
- Persistent contextual failures use neutral surfaces, a semantic error icon and concise guidance.
  Do not cover the composer or put required recovery information in an expiring Snackbar.
- Keep existing content, drafts and recovery actions. Isolate failures and never resubmit a task
  automatically. A retry must repeat the affected operation; a generic list refresh cannot repair
  every failure.
- Primary copy excludes exceptions, URLs, HTTP payloads and stacks. Reuse the PC `parseChatError`
  classification. Do not invent a cause for unknown failures. Explicit diagnostic copying redacts
  credentials, tokens, passwords and URL authentication data.

## Implementation

```tsx
showErrorAlert(cause, { title: '无法打开文件' })

<ErrorNotice error={error} title="无法读取文件夹" testID="folder-error" onRetry={reloadFolder} />
```

Pass the original error to the shared boundary. Extend presentation and its focused tests rather
than parsing exceptions independently in screens. Run copy, native action, contextual component and
source-boundary tests, Mobile type checking, and both platform exports. Source-boundary tests prevent
direct Alert imports and raw error JSX. Record real-device visual verification separately; these
checks do not establish it.

Platform sources: [Apple Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts),
[Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback),
[Writing](https://developer.apple.com/design/human-interface-guidelines/writing),
[Material Dialogs](https://m3.material.io/components/dialogs/guidelines), and
[Snackbar](https://m3.material.io/components/snackbar/overview).
