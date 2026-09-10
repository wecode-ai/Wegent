---
sidebar_position: 32
---

# 小信 HR 知识同步发布与验收

小信 HR 知识同步把小信全量快照投影为固定知识库中的一份外部 `FAQ.md`。初始化、
变更通知和每日兜底都复用同一个固定目标服务及现有外部文档导入、附件和索引链路。

## 配置

拉取地址 `http://xiaoxinop.erp.sina.com.cn/api/robot/knowledge/pull` 和 App ID
`robot` 是小信协议的固定值，直接定义在代码中。部署时通过运行时环境变量注入以下值：

```dotenv
XIAOXIN_SYNC_ENABLED=true
XIAOXIN_SYNC_TOKEN=<notification-bearer-token>
XIAOXIN_SIGN_SECRET=<xiaoxin-sign-secret>
XIAOXIN_TARGET_KB_ID=<knowledge-base-id>
XIAOXIN_SYNC_USER_ID=<sync-user-id>
```

同步用户必须启用、能管理目标知识库文档，目标知识库必须启用且具有 RAG 配置。
现有 Beat 每天北京时间 03:00（UTC 19:00）投递一次
`app.tasks.xiaoxin_knowledge_tasks.sync_xiaoxin_hr_knowledge`。多实例同时触发时，
任务通过 Redis 分布式锁确保只有一个实例实际提交同步。

## 初始化

配置生效后，通过正式通知入口初始化，不使用专用脚本或第二条发布路径。以下命令
只包含占位凭证：

```bash
curl --request POST 'https://<wegent-host>/api/integrations/xiaoxin/knowledge-sync/notify' \
  --header 'Authorization: Bearer <notification-bearer-token>' \
  --header 'Content-Type: application/json' \
  --data '{
    "domains": ["HR"],
    "sync_time": "2026-08-31 09:00:00",
    "operator": "<operator>",
    "pull_api": "https://<compatibility-only-placeholder>"
  }'
```

HTTP 202 表示刷新已提交，或同一外部文档正在处理中；它不表示拉取和索引已经完成。
请求中的 `pull_api` 仅用于协议兼容，Wegent 永远只访问代码中定义的小信固定拉取地址。

## 运维定位

按 `provider=xiaoxin`、`external_resource_id=HR` 和目标知识库定位唯一文档，并复用
以下现有字段：

- `index_status`：当前处理状态，失败时为 `FAILED`。
- `index_generation`：当前尝试的 generation。
- `processing_error`：稳定失败阶段、错误码和可重试语义。
- `is_active`：刷新期间为 `false`。
- 外部 metadata：`source_total`、`filtered_count`、`generated_qa_count`。

同步提交日志记录 `trigger_source=notification|daily`。异步拉取、投影和索引阶段
通过请求时间、文档 ID、`index_generation` 和现有状态字段定位，包含数量、耗时、
失败阶段和稳定错误码。日志不包含 Token、签名、完整响应或答案正文。

## 一期发布边界

- 刷新开始后，旧文档会短暂不可检索；一期不是原子发布或持续可用方案。
- 拉取、转换或索引失败进入现有 `FAILED` 状态，不自动回滚旧 generation。
- 下一次通知或每日任务可刷新同一外部文档；漏通知的兜底边界最长约 24 小时。
- 处理中收到通知不会补投第二个任务；该次可能遗漏的变化由下一次通知或每日同步
  兜底。
- 不新增锁、dirty flag、事件表、补偿队列、同步历史表或管理页面。
- 小信提供知识级 `updated_at`，FAQ 中每个问答块显示该知识的权威更新时间；地域或
  员工类型答案展开出的多个问答块复用同一更新时间。

## 发布验收

发布前确认小信聚焦测试、外部导入/索引回归、Black、isort 和 `git diff --check`
全部通过。初始化后确认只有一份外部 `FAQ.md`，“商保体检”和“ER政策法规”未进入
内容，每个问答块包含更新时间，文档最终进入 `SUCCESS`；再验证失败可见且后续通知
或每日任务能推进同一文档的新 generation。
