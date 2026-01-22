# Wegent Scheme URL System

## Overview

Wegent implements a comprehensive **Scheme URL system** that allows navigation and interaction with the application using `wegent://` URLs. This enables deep linking from external sources, automation scripts, and provides a declarative API for common operations.

## Architecture

The system follows a **three-layer architecture**:

1. **Parser Layer** (`parser.ts`): Parses and validates `wegent://` URLs
2. **Registry Layer** (`registry.ts`): Stores and matches URL handlers
3. **Handler Layer** (`handler.ts`): Executes the appropriate action for each URL

## URL Structure

```
wegent://{type}/{path}?{params}
```

- **type**: Category of operation (`open`, `form`, `action`, `modal`)
- **path**: Specific target within the type
- **params**: Optional query parameters

## Supported Scheme URLs

### Page Navigation (`wegent://open/*`)

Navigate to different pages in the application.

| Scheme URL | Description | Examples |
|------------|-------------|----------|
| `wegent://open/chat` | Open chat page | `wegent://open/chat`<br/>`wegent://open/chat?team=123` |
| `wegent://open/code` | Open code page | `wegent://open/code`<br/>`wegent://open/code?team=123` |
| `wegent://open/settings` | Open settings page | `wegent://open/settings`<br/>`wegent://open/settings?tab=integrations` |
| `wegent://open/knowledge` | Open knowledge base | `wegent://open/knowledge`<br/>`wegent://open/knowledge/123` |
| `wegent://open/feed` | Open activity feed | `wegent://open/feed` |
| `wegent://open/feedback` | Open feedback dialog | `wegent://open/feedback` |

### Forms (`wegent://form/*`)

Open creation/edit dialogs.

| Scheme URL | Description | Auth Required |
|------------|-------------|---------------|
| `wegent://form/create-task` | Open create task dialog | ✅ |
| `wegent://form/create-team` | Open create agent dialog | ✅ |
| `wegent://form/create-bot` | Open create bot dialog | ✅ |
| `wegent://form/add-repository` | Open add repository dialog | ✅ |
| `wegent://form/create-subscription` | Open create subscription dialog | ✅ |

**Prefilling Form Data:**

You can prefill the subscription form by passing a `data` parameter with JSON-encoded form data:

```
wegent://form/create-subscription?data={"displayName":"Daily News","description":"Collect daily news","triggerType":"cron"}
```

**Supported fields in `data` parameter:**
- `displayName` (string): Subscription display name
- `description` (string): Subscription description
- `taskType` (string): Task type (`collection`, `analysis`, `notification`)
- `triggerType` (string): Trigger type (`cron`, `interval`, `one_time`, `event`)
- `promptTemplate` (string): Prompt template for the subscription
- `retryCount` (number): Number of retries on failure
- `timeoutSeconds` (number): Timeout in seconds
- `enabled` (boolean): Whether the subscription is enabled
- `preserveHistory` (boolean): Whether to preserve execution history
- `visibility` (string): Visibility (`private`, `public`, `unlisted`)

### Actions (`wegent://action/*`)
### Actions (`wegent://action/*`)

Execute operations.

| Scheme URL | Description | Parameters | Auth Required | Implementation |
|------------|-------------|------------|---------------|----------------|
| `wegent://action/send-message` | Send message automatically | `text`, `team` (optional) | ✅ | Dispatches event to chat input |
| `wegent://action/prefill-message` | Prefill message input | `text`, `team` (optional) | ✅ | Dispatches event to chat input |
| `wegent://action/share` | Generate and copy share link | `type` (optional), `id` (optional) | ✅ | Generates share link and copies to clipboard. Uses current task if id not provided |
| `wegent://action/export-chat` | Export chat via share link | `taskId` (optional) | ✅ | Generates share link and copies to clipboard. Uses current task if taskId not provided |
| `wegent://action/export-task` | Export task via share link | `taskId` (optional) | ✅ | Generates share link and copies to clipboard. Uses current task if taskId not provided |
| `wegent://action/export-code` | Export code via share link | `taskId` (optional), `fileId` (optional) | ✅ | Generates share link and copies to clipboard. Uses current task if taskId not provided |

**Note:** If `taskId` or `id` parameters are not provided, the system will automatically use the currently open task. Export actions generate a shareable link that can be used to view and export the task content. The link is automatically copied to the clipboard.

## Usage

### In React Components

```typescript
import { useSchemeURL } from '@/lib/scheme'

function MyComponent() {
  const { navigate } = useSchemeURL(user)

  return (
    <button onClick={() => navigate('wegent://open/chat?team=123')}>
      Open Chat
    </button>
  )
}
```

### In HTML Links

```html
<a href="wegent://open/chat?team=123">Open Chat</a>
```

### From External Sources

```bash
# Open from command line (macOS/Linux)
open "wegent://open/chat?team=123"

# Windows
start "wegent://open/chat?team=123"
```

## Event System

The system uses custom DOM events for component communication:

### Dialog Events

```typescript
// Listen for dialog open requests
window.addEventListener('wegent:open-dialog', (e) => {
  const { type, params } = e.detail
  // Open the appropriate dialog
})
```

### Message Events

```typescript
// Listen for send-message action
window.addEventListener('wegent:send-message', (e) => {
  const { text, team } = e.detail
  // Send the message
})

// Listen for prefill-message action
window.addEventListener('wegent:prefill-message', (e) => {
  const { text, team } = e.detail
  // Prefill the input
})
```

### Export Events

```typescript
// Listen for export actions
window.addEventListener('wegent:export', (e) => {
  const { type, taskId, fileId } = e.detail
  // Trigger the export
})
```

## Adding New Scheme URLs

### 1. Register the Handler

```typescript
import { registerScheme } from '@/lib/scheme'

registerScheme('my-custom-action', {
  pattern: 'wegent://action/my-action',
  handler: (context) => {
    const { params, router, user } = context
    // Implement your logic here
  },
  requireAuth: true,
  description: 'My custom action',
  examples: ['wegent://action/my-action?param=value'],
})
```

### 2. Update Type Definitions

Add your new URL to `types.ts`:

```typescript
export type ActionSchemeURL =
  | `wegent://action/my-action?${string}`
  | ... // existing types
```

### 3. Add i18n Translations

Add translations to `scheme.json` files:

```json
{
  "scheme_url": {
    "my_action": "My Action"
  }
}
```

## Error Handling

The system follows a **silent failure** approach:

- Invalid URLs are logged to console but don't interrupt user flow
- Missing handlers are logged as warnings
- Auth failures silently cancel the operation
- Errors during handler execution are caught and logged

This ensures a smooth user experience even when scheme URLs fail.

## Development Tools

In development mode, access debugging utilities via:

```javascript
window.__wegentScheme__.debug()        // List all schemes
window.__wegentScheme__.generateDocs() // Generate markdown docs
window.__wegentScheme__.validate()     // Validate required schemes
```

## Security

- Authentication is checked via the `requireAuth` flag
- Unauthenticated requests for protected URLs are silently ignored
- All URLs are validated before execution
- No sensitive data should be passed in URL parameters

## Browser Support

The system requires:
- ES6+ JavaScript support
- `CustomEvent` API
- `URLSearchParams` API
- `Next.js` router

## Testing

See test files in `frontend/src/__tests__/lib/scheme/` for examples.

## Future Enhancements

- System-level URL scheme registration (desktop apps)
- URL scheme versioning
- Deep linking from mobile apps
- Universal Links support (iOS/Android)
