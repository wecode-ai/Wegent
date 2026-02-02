# Frontend Open Source Migration Guide

## Overview

This document records the tasks required to migrate from the internal version to the open source version.

## Changes:

### 1. Modify import statements

Replace all `@wecode/` imports with corresponding `@/features/` paths:

**File: `src/app/(tasks)/devices/page.tsx`**

```typescript
// Remove
import { LocalExecutorGuide } from '@wecode/components/devices/LocalExecutorGuide'

// Replace with
import { LocalExecutorGuide } from '@/features/devices/components/LocalExecutorGuide'
```

### 2. Delete the wecode directory

```bash
rm -rf frontend/wecode/
```

### 3. Remove wecode path alias from tsconfig.json

**File: `tsconfig.json`**

```json
// Remove this line from "paths"
"@wecode/*": ["./wecode/*"]

// Remove "wecode/**/*.ts", "wecode/**/*.tsx" from "include"
```

### 4. Remove wecode translation loading from i18n setup (optional)

**File: `src/i18n/setup.ts`**

The `loadWecodeTranslations` function will silently fail when wecode directory doesn't exist,
so no changes are required. However, you can optionally remove it for cleaner code.
