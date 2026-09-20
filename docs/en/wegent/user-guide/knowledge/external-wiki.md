---
sidebar_position: 12
---

# External Wiki Sync

External Wiki connectors let you bind Wiki.js pages, GitLab repository files, or
GitLab project Wiki pages to a knowledge base. Bound resources become regular
knowledge documents that participate in general RAG retrieval. A scheduled job
checks remote versions and automatically updates content and indexes when a
resource changes.

## Supported Connectors

| Connector       | Importable content                     | Selection flow                | Credential                   |
| --------------- | -------------------------------------- | ----------------------------- | ---------------------------- |
| **Wiki.js**     | Wiki.js pages                          | Page or directory             | Wiki.js API key              |
| **GitLab Repo** | Supported files in GitLab repositories | Repository, branch, and files | GitLab AppKey / Access Token |
| **GitLab Wiki** | GitLab project Wiki pages              | Repository and Wiki pages     | GitLab AppKey / Access Token |

Wiki.js currently supports **2.x starting at version 2.5.300**. Wiki.js 3.x and
versions older than 2.5.300 are outside the current compatibility range.

GitLab Repo supports these file extensions:

```text
pdf, doc, docx, ppt, pptx, xls, xlsx, csv, txt, md, markdown
```

Directories are used only for browsing and are not imported as documents.
Empty files, unsupported file types, and files over the knowledge base upload
size limit cannot be bound. Git LFS pointer files are rejected because the
repository API response does not contain the referenced binary content.

---

## How It Works

External Wiki sync consists of three parts:

| Part                      | Location                                      | Description                                                                   |
| ------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------- |
| **Connection management** | Settings → Integrations → External Wiki       | Stores the connector type, site URL, and encrypted credentials                |
| **Resource binding**      | Knowledge Base → Add Document → External Wiki | Select remote pages or files; each resource becomes one synchronized document |
| **Scheduled sync**        | Background scheduled task                     | Compares remote versions and updates only changed documents                   |

Unlike a one-time web import, an external Wiki resource maintains a continuous
binding. Binding the same connection, repository, branch, and resource again
reuses the existing document instead of creating a duplicate.

Imported content uses the standard knowledge base indexing and retrieval
pipeline. Wiki.js and GitLab do not require a dedicated retrieval Skill.

---

## Prerequisites

### General

- The Wegent backend can reach the target Wiki.js or GitLab address.
- `EXTERNAL_DOC_SYNC_ENABLED` is enabled. It is enabled by default.
- The current user has edit permission on the target knowledge base.
- The target can use HTTP or HTTPS; the site URL must be reachable from the
  backend.

### Wiki.js

- Wiki.js 2.x at version 2.5.300 or later.
- An API key created under **Admin → API** whose permission group includes:
  - `read:pages`
  - `read:source`
  - `manage:pages`, or a permission group containing `delete:pages`

### GitLab Repo and GitLab Wiki

- A GitLab Access Token that can read the target projects. The product UI calls
  this credential **GitLab AppKey / Access Token**.
- The recommended minimum scope is `read_api`.
- The token can read the target projects. GitLab Repo also requires repository,
  branch, and file access; GitLab Wiki requires project Wiki access.
- GitLab.com and self-managed GitLab instances are supported over HTTP or
  HTTPS.

The token is sent through the `PRIVATE-TOKEN` request header and stored
encrypted on the server. It is never appended to URLs or exposed in knowledge
documents.

---

## Configure an External Wiki Connection

1. Go to **Settings → Integrations** and find **External Wiki**.
2. Click **New Connection**.
3. Enter a connection name and select a connector type.
4. Enter the site URL and credential required by that connector.
5. Click **Test Connection**.
6. Save the connection after the test succeeds.

### Configure Wiki.js

- **Connector type**: `Wiki.js`
- **Site URL**: The Wiki root, such as `https://wiki.example.com`, without
  `/graphql`
- **API Key**: The API key created in Wiki.js
- **Default locale (optional)**: Used to resolve paths on multilingual sites,
  such as `zh`

The connection test checks page listing, page resolution, and body reading, not
network reachability alone.

### Configure GitLab Repo

- **Connector type**: `GitLab Repo`
- **Site URL**: The GitLab root, such as `https://gitlab.example.com` or
  `http://gitlab.internal`, without `/api/v4`
- **API Key**: GitLab AppKey / Access Token

The connection test calls the GitLab API and lists projects visible to the
token. If the connection works but no projects are accessible, the test reports
that the current AppKey has no accessible projects.

### Configure GitLab Wiki

- **Connector type**: `GitLab Wiki`
- **Site URL**: The GitLab root, without `/api/v4`
- **API Key**: GitLab AppKey / Access Token

GitLab Repo and GitLab Wiki may use the same GitLab instance and token, but they
are separate connections and expose different resources in the picker.

### Connection Management Notes

- When changing only non-target fields such as the connection name or enabled
  state, leave the API key blank to retain it. Changing the site URL or
  connector requires re-entering the API key; the old credential is never sent
  to the new target.
- Disabling a connection stops remote reads and synchronization. The most
  recently synchronized local content and index remain available.
- All synchronized documents referencing a connection must be unbound before
  the connection can be deleted.
- The connector type determines resource identity and parsing behavior. To
  switch connector types, create a new connection and bind resources again
  instead of repurposing an existing connection.

---

## Add Wiki.js Pages

1. Open the target knowledge base and click
   **Add Document → External Wiki**.
2. Select a Wiki.js connection.
3. Select pages in the page tree.
4. Click **Bind Selected**.

The picker supports title and path search, select all, clear selection, and
directory selection. If the site exceeds the server-side browsing limit, the
picker displays a truncation warning and loads the most recently updated pages.

---

## Add GitLab Repo Files

1. Open the target knowledge base and click
   **Add Document → External Wiki**.
2. Select a `GitLab Repo` connection.
3. Select the target project from **Repository**.
4. Select a branch from **Branch**. The project default branch is preferred.
5. Expand directories and select the files to synchronize.
6. Click **Bind Selected**.

The picker enables only supported file types. Directories are for navigation
and cannot be imported as knowledge documents. Resource identity includes the
connection, repository, branch, and file path:

- The same path on different branches becomes a different synchronized
  document.
- Renaming a file is treated as deletion of the old path and creation of a new
  resource. Bind the new path explicitly.
- Changing the selected project or branch clears temporary selections from the
  previous scope.

After binding, Wegent downloads the original file and reuses the existing
attachment parsing, conversion, and indexing pipeline.

---

## Add GitLab Wiki Pages

1. Open the target knowledge base and click
   **Add Document → External Wiki**.
2. Select a `GitLab Wiki` connection.
3. Select the target project from **Repository**.
4. Select pages from the Wiki page list.
5. Click **Bind Selected**.

GitLab project Wikis do not require branch selection. A page enters the
knowledge indexing pipeline as Markdown, AsciiDoc, or text according to its
GitLab Wiki format.

If the project has no Wiki, the Wiki is empty, or the token cannot read it, the
page list is empty or displays the corresponding error.

---

## Binding Results and Document Display

| Result                  | Description                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------- |
| **Bound N**             | New synchronized documents were created and background reading and indexing started |
| **Re-synced N**         | Existing resources triggered a content refresh                                      |
| **Processing, skipped** | Documents are still converting or indexing, so no duplicate work was dispatched     |

The knowledge document list displays:

- The file type, such as `MD` or `PDF`;
- The connector type and icon, such as `wikijs`, `gitlab-repo`, or
  `gitlab-wiki`;
- The time of the most recent successful index.

Under **Add Document → External Wiki → Bound documents**, every document also
shows its own connector name and icon. Changing the selected connection does
not change connector labels on other bound documents.

---

## Scheduled Sync

By default, the background inspection runs daily at 19:00 UTC:

1. Scan synchronized external Wiki documents in batches.
2. Call the appropriate connector, grouped by connection and resource scope.
3. Compare the remote version, downloaded content version, and indexed
   version.
4. Dispatch work only for changed resources or missing indexes.

Each connector uses a different remote version:

| Connector   | Version source                                                  |
| ----------- | --------------------------------------------------------------- |
| Wiki.js     | Page `updatedAt`                                                |
| GitLab Repo | File Blob ID                                                    |
| GitLab Wiki | A content hash calculated from the page title, format, and body |

| Remote state                                        | System behavior                                                |
| --------------------------------------------------- | -------------------------------------------------------------- |
| Version unchanged and index healthy                 | No document update                                             |
| Remote content changed                              | Download the body again and rebuild the index                  |
| Content is current but the index is missing         | Rebuild from the existing body                                 |
| Page or file deleted                                | Mark the source missing and preserve the last successful index |
| Repository or branch inaccessible                   | Mark synchronization failed and preserve existing content      |
| Connection failure, permission error, or rate limit | Mark synchronization failed and retry in a later inspection    |

When an update is detected, task logs include the document ID, knowledge base
ID, document name, connector, connection ID, resource path, previous and remote
versions, and the chosen update action. API keys and document bodies are not
logged.

You can also click **Sync** in document details to fetch remote content
immediately. If the document is already processing, duplicate work is skipped.

---

## Deleted or Moved Source Resources

Deleting a remote page or file does not automatically delete the local
knowledge document. The source is marked missing:

- The latest successfully synchronized content and index remain available, so
  agents can still retrieve historical content.
- If the source is restored, a later inspection resumes synchronization.
- To remove it permanently, unbind it from the bound document list.

For GitLab Repo, moving or renaming a file makes the old path a missing source.
The new path has a new resource identity and must be bound explicitly.

If a GitLab project, branch, or Wiki permission becomes unavailable, the
document is marked as a synchronization failure rather than being deleted.
Synchronization retries after access is restored.

---

## Management Operations

| Operation          | Location                                       | Description                                                 |
| ------------------ | ---------------------------------------------- | ----------------------------------------------------------- |
| View bindings      | Add Document → External Wiki → Bound documents | View document names, connectors, and synchronization states |
| Unbind             | Bound documents → Unbind                       | Delete the local synchronized document and its index        |
| Manual sync        | Document details → Sync                        | Fetch remote content and rebuild the index immediately      |
| Disable connection | Settings → Integrations → External Wiki        | Stop remote reads and scheduled synchronization             |
| Delete connection  | Settings → Integrations → External Wiki        | All referencing documents must be unbound first             |

Each user manages their own external Wiki connections. Binding and unbinding
require edit permission on the target knowledge base. Synchronized documents
follow the same knowledge base visibility rules as ordinary documents.

---

## FAQ

**Q: The GitLab connection succeeds, but no repositories are available.**

Verify that the token has the `read_api` scope and can read the target projects.
The project list includes only projects visible to the current token.

**Q: A file is missing from the GitLab Repo picker.**

Verify the selected repository and branch, then check whether the file
extension is supported. Directories, empty files, extensionless files, and
files over the knowledge base upload size limit cannot be imported.

**Q: Why does GitLab Wiki not ask for a branch?**

A GitLab project Wiki is managed through a separate Wiki API and is not selected
from a code repository branch.

**Q: Are HTTP or private-network GitLab instances supported?**

Yes. GitLab is not required to use HTTPS, and Wegent does not restrict it to
specific domains or network ranges. The backend only needs network access to
the address, and the token must have permission.

**Q: How long until a remote update is synchronized?**

At most until the next daily inspection. Use **Sync** in document details when
the update must take effect immediately.

**Q: The document remains in "Queued."**

Background tasks run through a queue. If the state has not changed after 30
minutes, inspect the failure reason in document details and retry.

**Q: Can the same resource be bound to multiple knowledge bases?**

Yes. Each knowledge base has an independent synchronized document and index.

---

## Server-Side Configuration Reference

| Environment variable                                | Default      | Description                                                       |
| --------------------------------------------------- | ------------ | ----------------------------------------------------------------- |
| `EXTERNAL_DOC_SYNC_ENABLED`                         | `true`       | Master switch for external document synchronization               |
| `EXTERNAL_DOC_SYNC_CRON`                            | `0 21 * * *` | Inspection schedule in UTC crontab format                         |
| `EXTERNAL_DOC_SYNC_SCAN_BATCH_SIZE`                 | `500`        | Local documents scanned per batch                                 |
| `EXTERNAL_DOC_SYNC_RUN_MAX_DOCUMENTS`               | `10000`      | Maximum documents processed per run                               |
| `EXTERNAL_DOC_SYNC_TIME_BUDGET_SECONDS`             | `2700`       | Time budget per run in seconds                                    |
| `WIKI_SYNC_REMOTE_BATCH_SIZE`                       | `500`        | Maximum remote resources inspected per batch                      |
| `WIKI_TREE_MAX_PAGES`                               | `5000`       | Wiki.js page picker loading limit                                 |
| `MAX_UPLOAD_FILE_SIZE_MB`                           | `100`        | Per-file size limit for GitLab Repo and other knowledge documents |
| `REPOSITORY_READ_TIMEOUT_SECONDS`                   | `15`         | Timeout for one GitLab API read in seconds                        |
| `EXTERNAL_WIKI_DOWNLOAD_TIMEOUT_SECONDS`            | `300`        | Timeout for downloading one GitLab file or Wiki page              |
| `KNOWLEDGE_ATTACHMENT_ORPHAN_RETENTION_HOURS`       | `24`         | Safety retention before an orphaned attachment may be deleted     |
| `KNOWLEDGE_ATTACHMENT_ORPHAN_SCAN_BATCH_SIZE`       | `200`        | Maximum orphan candidates per scan                                |
| `KNOWLEDGE_ATTACHMENT_ORPHAN_SCAN_INTERVAL_SECONDS` | `3600`       | Orphan scan interval in seconds                                   |

---

## 🔗 Related Documentation

- [Document Management](./document-management.md) - Common knowledge document
  management operations
- [Knowledge Base Guide](./knowledge-base-guide.md) - Complete knowledge base
  guide
- [Configuring Retrievers](./configuring-retrievers.md) - Document indexing and
  retrieval configuration
