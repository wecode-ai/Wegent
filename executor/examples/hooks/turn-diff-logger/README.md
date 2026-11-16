---
sidebar_position: 1
---

# 每轮 Git Diff 本地日志 Hook

需要 Node.js 18 或更新版本、Git 2.41 或更新版本，并确保 `node` 和 `git` 在 Wework 执行设备的 `PATH` 中。无需安装 npm 依赖。

在支持 v2 `TurnCompleted` 文件描述符的 Wework 中，打开 **设置 → 编码 → Hooks → 导入**，选择本目录并保持插件启用。插件在后台把每个主 agent turn 的元数据和完整 Git 变更归档到：

```text
~/.wegent/logs/turn-diff/records/<event_id 的 SHA-256>/
  record.json
  diff.patch
  files.jsonl
```

`record.json` 保存 UTC 时间戳、原始 Hook 输入和归档文件描述符。`diff.patch` 保存完整原始补丁字节，`files.jsonl` 保存完整文件列表。插件按 64 KiB 缓冲流式复制，同时校验文件字节数和 SHA-256，不把补丁或完整文件列表载入内存。临时目录中的所有文件完成后，目录原子发布；采集失败且没有描述符时，只保存 `record.json`。Unix 新目录权限为 `0700`，文件权限为 `0600`。

`event_id` 决定唯一归档目录。相同事件重试会校验已保存的元数据和文件，返回原有路径，不新增记录；同一 ID 的元数据冲突或文件损坏会报错。并发事件独立归档，同一事件并发重试也只发布一份。`sequence` 保留宿主分配的持久序号；后台完成顺序可能不同，不能按时间戳跳过晚完成的日志。

修改已安装插件目录中的 `config.json`，即可指定其他绝对日志路径；也支持 `~/`。可以从 Hook 条目的 **在文件夹中显示** 打开已安装副本。配置在每次执行时读取。日志目录必须位于 Git 工作区外，指向工作区内部的符号链接同样会被拒绝，避免后续轮次把日志本身统计进代码变更。

输入协议仅支持 v2：顶层包含稳定的 `event_id`、`sequence`，`file_changes` 包含 `version: 2`、状态、仓库路径、文件数、增删行数，以及以下描述符。`diff_artifact.format` 为 `git-patch`，`files_artifact.format` 为 `jsonl`；每个描述符包含绝对 `path`、`size_bytes` 和十六进制 `sha256`。旧版内联 `diff` 和 `files` 不再接受。

```json
{
  "file_changes": {
    "version": 2,
    "status": "active",
    "workspace_path": "/path/to/repository",
    "file_count": 1,
    "additions": 2,
    "deletions": 1,
    "diff_artifact": {
      "path": "/path/to/host-artifacts/diff.patch",
      "size_bytes": 128,
      "sha256": "<64 个十六进制字符>",
      "format": "git-patch"
    },
    "files_artifact": {
      "path": "/path/to/host-artifacts/files.jsonl",
      "size_bytes": 64,
      "sha256": "<64 个十六进制字符>",
      "format": "jsonl"
    }
  }
}
```

Hook 记录连续采集快照之间的净 diff，包括同一工作区内子 agent、Shell 等产生的改动。非 Git 目录由执行器跳过；空轮次保存空文件，采集失败保留 `file_changes.status = "error"`。输入缺少仓库路径时，通过 Git 解析实际仓库根目录；无法确认则报错。**测试 Hook** 使用执行器当前目录，为每次测试生成唯一事件 ID 和合成的 v2 错误元数据（`file_changes.status = "error"`），不生成真实补丁。仅该目录位于 Git 仓库时，插件能归档这份测试元数据；要验证真实 diff，请在 Git 工作区实际运行一轮 agent。

同一次执行中的连续轮次沿用上次成功落库的结束快照，覆盖通知之间的写入；采集或落库失败后，后续成功记录合并补齐累计净变更。新的用户请求重新建立基线。官方 Codex 的通知可能晚于下一轮写入，因此允许相邻轮次合并记录，不保证精确逐轮归属或保留快照之间的中间版本。停用或删除插件会暂停待投递项并保留数据；重新启用或以相同 ID 重装后继续投递。

插件不发送网络请求，不计算 AI 占比，也不实现上报、游标或接收确认。标准输出仅返回成功标记、记录 ID、日志路径和是否命中已有记录。日志不会自动删除，需要时可自行归档或删除。

# Local turn Git diff logs

Requires Node.js 18 or newer and Git 2.41 or newer, with `node` and `git` on the Wework execution device's `PATH`. No npm dependencies are needed.

In a Wework build supporting v2 `TurnCompleted` artifact descriptors, open **Settings → Coding → Hooks → Import**, select this directory, and keep the plugin enabled. The background hook archives each main agent turn at:

```text
~/.wegent/logs/turn-diff/records/<SHA-256 of event_id>/
  record.json
  diff.patch
  files.jsonl
```

`record.json` contains a UTC timestamp, the original Hook input, and descriptors for the archived files. `diff.patch` preserves the complete patch bytes, and `files.jsonl` preserves the complete file list. Copying and SHA-256/byte-count verification use 64 KiB streaming buffers. The patch and full file list are never loaded into memory. A temporary directory is atomically published only after every file is complete. Capture errors without descriptors produce only `record.json`. New Unix directories/files use `0700`/`0600` permissions.

`event_id` determines the unique archive directory. A retry validates existing metadata and files and returns the existing path without adding a record. Conflicting metadata for the same ID or damaged artifacts fail explicitly. Concurrent events are independent; simultaneous retries publish one archive. `sequence` preserves the host's durable sequence number. Background completion order may differ, so timestamp filters can miss late records.

Edit `config.json` in the installed plugin directory to choose an absolute log path, or one beginning with `~/`. Open that copy using the Hook's **Show in folder** action. Configuration is read for every invocation. The destination must remain outside the Git workspace, including after resolving symbolic links, so later turns do not capture the logs themselves.

Only v2 input is supported: top-level `event_id` and `sequence`; `file_changes.version: 2`, status, workspace path, file count, additions/deletions; and `diff_artifact` / `files_artifact` descriptors. Each descriptor contains an absolute `path`, `size_bytes`, hexadecimal `sha256`, and `format` (`git-patch` or `jsonl`, respectively). The JSON example above illustrates these descriptors. Legacy inline `diff` and `files` are rejected.

The event represents the net diff between consecutive captured snapshots, including subagent and shell changes in the same workspace. The executor skips non-Git directories. Empty turns archive empty files; capture failures retain `file_changes.status = "error"`. When no workspace path is supplied, Git resolves the actual root; failure to determine it rejects the event. **Test Hook** uses the executor's current directory and creates a unique event ID with synthetic v2 error metadata (`file_changes.status = "error"`) for each test, without a real patch. The plugin can archive this test metadata only when that directory belongs to a Git repository. To verify a real diff, run an actual agent turn in a Git workspace.

Consecutive turns within one execution reuse the last durably queued ending snapshot, covering writes between notifications. After capture or enqueue failures, a later successful record includes the accumulated net changes. A new user request establishes a fresh baseline. Official Codex notifications can lag behind writes for the next turn, so adjacent turns may be coalesced; exact per-turn attribution and intermediate versions between snapshots are not guaranteed. Disabling or deleting the plugin pauses pending deliveries while retaining their data; re-enabling or reinstalling the same ID resumes delivery.

The plugin makes no network requests and implements no AI attribution, reporting, cursors, or delivery acknowledgments. Stdout contains only success, record ID, log path, and deduplication status. Logs remain until you archive or delete them.
