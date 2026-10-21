---
sidebar_position: 29
---

# Issue comment attachment regression plan

Verify that Wework uploads locally staged comment attachments before saving a cloud comment or dispatching its execution. Persisted references must belong to the current Issue and remain readable after reload.

## Environment and entry point

Use the existing desktop runner with isolated Electron, a real local Executor, Python backend, Rust gateway, MySQL, and Redis. Only model services may be mocked. Do not use personal Wework sessions or shared project data.

```bash
pnpm --filter wework e2e:desktop -- --segment collaboration-issue-comment-attachments
```

Register the checkpoint in a GitHub desktop E2E Core shard. It creates its own workspace, cloud project, and Issues when run alone. Use valid PNG files with distinct ASCII filenames so this regression does not depend on the separate non-ASCII response-header fix.

## Cases

| Case                        | Steps and expected result                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main comment with image     | Enter text, attach a PNG, wait for local staging, and click send. The comment and cloud attachment reference persist, the composer clears, and no attachment ownership error appears. |
| Reply with multiple images  | Reply to the saved comment, attach several PNG files, and send. The reply remains in its original thread, all attachments persist, and execution receives cloud attachment IDs.       |
| Reload and original content | Reload and reopen the Issue. Comment and reply references remain present; authenticated attachment reads return the original PNG bytes.                                               |
| Issue isolation             | Open another Issue in the same project. Its comments and attachment list contain none of these files.                                                                                 |
| Upload or import failure    | Focused component regressions reject upload or import. No comment is sent, text and attachments remain, an error is visible, and sending succeeds after service recovery.             |
| Local project space         | Focused component coverage confirms that local projects retain local attachments without cloud upload.                                                                                |

Focused component coverage also rejects comment submission after successful upload and import. Retrying reuses the same cloud attachment ID and avoids duplicate stored images. When part of a batch upload fails, retry only the failed files.

## Evidence and cleanup

Record the focused regression results before and after the fix, desktop checkpoint logs, and GitHub CI results. Success assertions must inspect server persistence and attachment bytes, rather than composer clearing alone. On exit, the runner stops isolated processes and cleans up its database, executor directories, and temporary attachments.
