# Frontend Open Source Migration Guide

## Overview

This document records the tasks required to migrate from the internal version to the open source version.

## Code Differences

The only difference between internal and external versions is the import path in `devices/page.tsx`:

```typescript
// Internal (GitLab)
import { LocalExecutorGuide } from '@wecode/components/devices/LocalExecutorGuide'

// External (GitHub)
import { LocalExecutorGuide } from '@/features/devices/components/LocalExecutorGuide'
```

This is similar to `backend/app/api/api.py` which has `import wecode.api` only in internal version.

## Sync Conflict Resolution

When syncing from GitHub to GitLab (`sync_github_main.sh`), if conflict occurs in `devices/page.tsx`:

- **Keep the internal version** (`@wecode/...`)

## Changes for Open Source Release

### 1. Modify import in devices/page.tsx

**File: `src/app/(tasks)/devices/page.tsx`**

```typescript
// Change from
import { LocalExecutorGuide } from '@wecode/components/devices/LocalExecutorGuide'

// To
import { LocalExecutorGuide } from '@/features/devices/components/LocalExecutorGuide'
```

### 2. Delete the wecode directory

```bash
rm -rf frontend/wecode/
```

### 3. Remove wecode path alias from tsconfig.json

**File: `tsconfig.json`**

```json
// Remove from "paths"
"@wecode/*": ["./wecode/*"]

// Remove from "include"
"wecode/**/*.ts", "wecode/**/*.tsx"
```

### 4. No changes needed for i18n setup

The `src/i18n/setup.ts` uses dynamic import with try-catch for `@wecode/i18n` module.
When wecode directory doesn't exist, it will silently skip.
