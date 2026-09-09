---
sidebar_position: 36
---

# Wework 会话与配置云同步

Wework 使用内置 Core DSH 插件 `@wegent/dsh-transcript-sync` 同步已完成的会话
turn 和可跨设备复用的偏好。同步层只负责可靠传输和存储，不分析会话语义；后续分析能力
直接消费 Backend 中的同一份数据。

## 数据边界

同步对象分为三类：

- 已完成的用户消息、模型回复、思考摘要、用量和完成状态，按 turn 增量同步。
- 活跃会话的标题、当前序号、归档位置和单写租约等元数据。
- 主题、语言、上下文阈值、监督设置和快捷短语等可移植偏好。

云端连接、访问令牌、本机 Harness、附件本地路径、工作区绝对路径和系统凭据不会作为
可移植偏好上传。同步 transcript 也不等于复制 Git 工作区或模型提供方的原生 session
文件；需要在另一台设备继续执行时，执行层仍需准备可用工作区。下载的 finalized turn
会由 Executor 注入该任务绑定的原生 Codex thread，后续模型请求直接使用这条原生会话
历史，不再维护一份旁路 transcript 正文。

## 热表与冷文件

Backend 使用三张表：

| 表                           | 用途                                                           |
| ---------------------------- | -------------------------------------------------------------- |
| `wework_transcripts`         | 每个用户、每个稳定 transcript 的元数据、当前 sequence 和写租约 |
| `wework_transcript_turns`    | 活跃会话尚未归档的 finalized turn                              |
| `wework_transcript_archives` | 不可变归档段的序号范围、对象 key、SHA-256 和大小               |

客户端不会按 token 或流式 chunk 写数据库。一个 turn 完成后才写入一条增量记录，并通过
`baseSequence`、连续 `sequence` 和稳定 `turnId` 保证幂等。

本地 turn 序号只描述单台设备上的执行顺序，云端 `sequence` 则是 transcript 的全局
顺序。turn 完成时，客户端根据本地已知的云端 head 持久化 `baseSequence`。如果上传时
head 已变化，客户端先拉取冲突位置：相同 `turnId` 表示前一次提交已成功，只需完成幂等
确认；不同 turn 表示两台设备基于同一旧上下文并行执行，不能安全线性合并，此时自动创建
新 transcript 分支。分支只记录 `parentTranscriptId`、`forkedAtSequence` 和分叉后的
turn，不复制父会话正文。

归档时，Backend 先把热 turn 编码为 JSON Lines，再压缩为 `jsonl.zst` 并写入私有对象
存储。只有对象上传成功后才删除对应热表记录。归档文件的对象 key 使用 transcript ID
摘要，不暴露原始标识；下载恢复时会重新校验 SHA-256。归档后的新 turn 继续写热表，
形成“冷历史 + 热尾”。

## 单写与离线恢复

写入前，客户端必须获取带 fencing token 的短租约。另一个客户端持有有效租约时，
Backend 拒绝写入；过期或被替换的 token 也不能提交 turn。插件在一次 finalized turn
提交完成后立即释放租约，不需要为每个 turn 重新上传整个 transcript 文件。

插件先把待上传 turn 的定位信息原子写入 `DSH_HOME` 下的 SQLite outbox，再尝试访问
Backend。outbox 只保存 `sessionId`、本地/云端序号、稳定 `turnId`、目标 transcript 和
Executor turn 标识和分支路由，不重复保存消息正文；上传时通过
`runtime.tasks.transcript` 直接从 Executor 的权威会话存储分页读取对应 turn。同步插件
不会再持久化一份 DSH Session 正文。下载时，已有原生 thread 的任务先恢复 thread 再
注入增量；冷设备上的任务如果尚未创建 thread，Executor 会先创建并绑定原生 Codex
thread，再按云端 sequence 注入。只有成功注入后才推进本地 `importedThrough` 游标，
因此重启和响应丢失不会让模型历史重复或越序。启动时尚未连接云端也不会丢数据；连接
建立后，轮询会自动补传 outbox，并拉取其他设备写入的热 turn。连续失败采用最长 60 秒
的指数退避，单次 Backend 请求最长 30 秒，不阻塞本地任务执行。首次恢复已归档会话时，
插件先读取归档段，再追加归档之后的热尾。

如果两台设备从同一个云端 head 并行产生不同 turn，冲突 turn 自动进入独立 transcript
分支。主线设备不会把该分支注入自己的原生 thread；设备绑定到分支后，模型请求只携带
父级分叉点之前的历史和该分支自己的后续 turn。

每个 Wework 安装都是平等的同步客户端。云端 Executor 只是任务的执行位置，不作为一个
额外同步设备参与租约竞争。

## API

认证 API 前缀为 `/api/wework-transcripts`：

| 方法与路径                                | 用途                                   |
| ----------------------------------------- | -------------------------------------- |
| `GET /`                                   | 列出当前用户的 transcript 和归档元数据 |
| `POST /{id}/lease`                        | 创建 transcript 或获取写租约           |
| `PUT /{id}/lease/{token}`                 | 续租                                   |
| `POST /{id}/lease/release`                | 释放租约                               |
| `POST /{id}/turns`                        | 追加连续 finalized turn                |
| `GET /{id}/turns`                         | 按 sequence 拉取热尾                   |
| `POST /{id}/archive`                      | 把当前热 turn 转为不可变冷归档         |
| `GET /{id}/archives/{archiveId}/turns`    | 校验并分页读取归档 turn                |
| `GET /{id}/archives/{archiveId}/download` | 获取短期签名下载地址                   |

可移植偏好复用 `/api/v1/dsh-plugin-storage`，存储单元为
`@wegent/dsh-transcript-sync` 的 `portable_preferences`。

## 部署配置

归档复用 Backend 的 `ATTACHMENT_S3_*` MinIO/S3 连接配置，并增加：

| 环境变量                                        | 默认值               | 说明                        |
| ----------------------------------------------- | -------------------- | --------------------------- |
| `WEWORK_TRANSCRIPT_S3_BUCKET`                   | `wework-transcripts` | 私有 transcript 归档 bucket |
| `WEWORK_TRANSCRIPT_DOWNLOAD_URL_EXPIRE_SECONDS` | `900`                | 签名下载地址有效期          |

部署前必须执行 Alembic migration。对象存储不可用时，归档 API 返回失败并保留热表数据；
普通活跃 turn 同步不依赖归档成功。
