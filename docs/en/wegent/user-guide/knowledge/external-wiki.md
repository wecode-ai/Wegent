---
sidebar_position: 12
---

# External Wiki Sync

Bind pages from a self-hosted Wiki.js site to a knowledge base as synchronized documents that participate in RAG retrieval. Once bound, the system checks remote page versions daily, automatically re-fetches updated content, and rebuilds the index — no manual maintenance required.

> **Connector support**: The current compatibility matrix supports **Wiki.js 2.x starting at 2.5.300**. Wiki.js 3.x and releases older than 2.5.300 are not currently supported.

---

## Overview

The external wiki feature consists of three parts:

| Part | Location | Description |
|------|----------|-------------|
| **Wiki connection** | Settings → Integrations → External Wiki | Stores the Wiki.js site URL and API key (encrypted server-side) |
| **Page binding** | Knowledge Base → Add Document → External Wiki | Select pages to sync; each page becomes one synchronized document |
| **Daily sync** | Background scheduled task | Compares remote versions automatically and updates changed documents |

Difference from web scraping: web scraping is a one-time import with manual refresh; external wiki is a **continuous binding** — remote page updates sync automatically, and binding the same page again reuses the existing document instead of creating a duplicate.

---

## Prerequisites

- An accessible **Wiki.js 2.x site at version 2.5.300 or later**.
- An API key created in the wiki admin console (**Admin → API**) whose permission group includes:
  - `read:pages` (page reading)
  - `read:source` (source reading; page bodies cannot be fetched without it)
  - `manage:pages` (the Wiki.js 2.x `single` resolver requires it; a group containing `delete:pages` also satisfies the upstream check)
- The environment switch `EXTERNAL_DOC_SYNC_ENABLED` is on (default). When disabled, the binding entry reports "external document sync is not enabled".

---

## Configure a Wiki Connection

1. Go to **Settings → Integrations** and find the **External Wiki** card.
2. Click **New Connection** and fill in:
   - **Connection name**: A display name to distinguish multiple wiki sites.
   - **Connector type**: Wiki.js (the only option today; the system is built on a pluggable connector architecture and future releases will add connectors for more wiki systems).
   - **Site URL**: The root address used to browse the wiki, e.g. `https://wiki.mycompany.com`, without `/graphql`.
   - **API Key**: Shown only once at creation; stored encrypted afterwards. Leave blank when editing to keep the current value.
   - **Default locale (optional)**: Used for path resolution on multilingual sites, e.g. `zh`.
3. Click **Test Connection** to verify; a success message with the version number means it works.
4. Click **Save**.

Notes:

- Turning off the **Enable connection** switch stops remote page reads and synchronization. Existing bindings and their last successfully synchronized local content and index remain available.
- A connection cannot be deleted while synchronized documents still reference it; remove those documents first. The rejection message lists the referencing knowledge bases.
- The connection test exercises page listing, path resolution, and body reading rather than network reachability alone. A site with no published pages and no readable version does not pass the connection test.

---

## Bind Wiki Pages to a Knowledge Base

1. Open the target knowledge base and click **Add Document → External Wiki**.
2. Select a configured connection in the **Wiki connection** dropdown (if none exists, you are prompted to create one under Settings → Integrations first).
3. Check the pages to bind in the page tree. Supported:
   - Search by title or path;
   - Select all / clear selection;
   - Select an entire directory (binds the pages directly under it, not recursively).
   - If the site exceeds the server-side browsing limit, the picker shows a truncation warning and only the most recently updated pages.
4. Click **Bind Selected**.

The result falls into three categories:

| Result | Description |
|--------|-------------|
| **Bound N** | Newly bound pages; background fetching and indexing start |
| **Re-synced N** | Previously bound pages; a refresh was triggered |
| **Processing, skipped** | Previously bound pages still in the indexing pipeline; no duplicate work is dispatched |

After binding, documents appear in the list with a "Synced Wiki" badge and the "External Wiki" document type.

---

## Daily Sync Mechanism

After binding, a background job runs a daily inspection (default 19:00 UTC) with no manual steps:

1. **Scan**: Iterate all bound wiki documents in batches (a Redis cursor records progress; at most 10,000 documents per run, resuming the next day on timeout).
2. **Inspect**: Query remote page metadata in bulk via GraphQL (500 pages per request).
3. **Compare**: Compare the remote version (page `updatedAt`) against three local version fields (observed / content / indexed).
4. **Update decision**:

| Remote state | System behavior |
|--------------|-----------------|
| Version unchanged | No action |
| Page content updated | Re-fetch the body and rebuild the index |
| Body unchanged but index missing | Rebuild the index from the existing body |
| Page deleted | See the next section |
| Connection unavailable / permission failure | Document marked "synchronization failed"; existing content is kept and retried next round |

Besides the automatic inspection, you can trigger **Sync** from the document detail at any time to force-fetch the latest body (a busy document asks you to retry later).

---

## What Happens When a Source Page Is Deleted

When a wiki page is deleted, the system **does not delete the local document**; it marks it as "Wiki source document missing":

- Documents with a successfully built index **keep the last successfully synced index**, so agents can still retrieve the pre-deletion content.
- The state persists until the page is restored or you unbind manually.
- If the source page is restored, the next inspection detects it and resumes syncing automatically — no re-binding needed.

To remove the content for good, use **Unbind** in the knowledge base document list; the local document and its index are deleted.

---

## Management Operations

| Operation | Location | Description |
|-----------|----------|-------------|
| View bindings | Add Document → External Wiki → Bound documents | Shows path, locale, page update time, index status |
| Unbind | Bound documents → Unbind | Deletes the local synchronized document and its index |
| Manual sync | Document detail → Sync | Immediately fetches the latest body and re-indexes |
| Disable connection | Settings → Integrations → External Wiki | Stop remote reads and synchronization; bindings and last synchronized local content remain available |
| Delete connection | Settings → Integrations → External Wiki | All referencing documents must be unbound first |

### Permissions

- Wiki connection management: every signed-in user manages **their own** connections (connections are per-user and not visible to others).
- Binding/unbinding pages: requires **edit** permission on the target knowledge base (creator or admin).
- Synchronized documents follow the knowledge base member visibility, same as ordinary documents.

---

## FAQ

**Q: The document stays in "Queued" after binding?**
Background tasks execute from a queue; wait a moment. If the state does not change after 30 minutes, the inspection task marks it failed — check the error in the detail view and retry.

**Q: What is the difference between "Wiki source document missing" and "Synchronization failed"?**
"Wiki source document missing" means the remote API confirmed that the page no longer exists. "Synchronization failed" means the system could not complete the check or refresh, for example because the connection was unavailable or permission was denied. In both cases the last successfully synchronized local content and index are preserved; transient failures are retried automatically.

**Q: How long until a remote update reaches the knowledge base?**
At most the next daily inspection (default 19:00 UTC). Use manual **Sync** on the document for immediate effect.

**Q: Can the same page be bound to multiple knowledge bases?**
Yes. Each knowledge base binding is an independent synchronized document with its own index.

---

## Server-Side Configuration Reference

| Environment variable | Default | Description |
|----------------------|---------|-------------|
| `EXTERNAL_DOC_SYNC_ENABLED` | `true` | Master switch for external document sync |
| `EXTERNAL_DOC_SYNC_CRON` | `0 19 * * *` | Inspection schedule (UTC crontab) |
| `EXTERNAL_DOC_SYNC_SCAN_BATCH_SIZE` | `500` | Local documents scanned per batch |
| `EXTERNAL_DOC_SYNC_RUN_MAX_DOCUMENTS` | `10000` | Maximum documents per run |
| `EXTERNAL_DOC_SYNC_TIME_BUDGET_SECONDS` | `2700` | Per-run time budget (seconds) |
| `WIKI_SYNC_REMOTE_BATCH_SIZE` | `500` | Pages probed per GraphQL request |
| `WIKI_TREE_MAX_PAGES` | `5000` | Most recently updated pages loaded by the picker before it warns about truncation |
| `KNOWLEDGE_ATTACHMENT_ORPHAN_RETENTION_HOURS` | `24` | Safety retention before an orphaned knowledge attachment may be deleted |
| `KNOWLEDGE_ATTACHMENT_ORPHAN_SCAN_BATCH_SIZE` | `200` | Maximum orphan candidates per scan |
| `KNOWLEDGE_ATTACHMENT_ORPHAN_SCAN_INTERVAL_SECONDS` | `3600` | Orphan scan interval in seconds |

---

## 🔗 Related Documentation

- [Document Management](./document-management.md) - Common document management operations
- [Knowledge Base Guide](./knowledge-base-guide.md) - Complete knowledge base guide
- [Configuring Retrievers](./configuring-retrievers.md) - Document indexing and retrieval configuration
