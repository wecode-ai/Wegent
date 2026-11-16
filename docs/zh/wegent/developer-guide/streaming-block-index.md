---
sidebar_position: 90
---

# 流式块索引

Python 和 Rust 共用 `chat:streaming:blocks:{subtask_id}` 列表，以及
`chat:streaming:blocks_index:{subtask_id}` 派生索引。索引的业务字段统一使用
`block:{完整业务 ID}`，水位字段为 `_watermark` 和 `_watermark_id`。
业务 ID 不设保留字：`_watermark_id`、`_watermark`、`block:a` 都是合法 ID。

追加成功后根据 `RPUSH` 返回的列表长度记录位置。命中时只读取一个块；未命中时
从水位开始补齐索引，因此没有索引的旧列表和其他写入端的追加仍可更新。
位置校验失败或水位边界不匹配时重建索引。索引和列表使用相同的一小时 TTL，
完成时一起清理。Rust 的普通查找与带偏移量文本追加复用同一个 Lua 查找函数。

索引减少全列表网络传输和 JSON 解析；Redis `LINDEX`、`LSET` 访问列表中部仍是
线性成本，不保证任意历史块更新为 O(1)。

最低验证服务端版本为 Redis 4.0.11。租约确认在同一个 Lua 脚本中读取剩余
`PTTL`，再使用 `SET XX PX` 更新令牌，保持原来的过期时间；不依赖 Redis 6
才提供的 `KEEPTTL`，也不放宽过期租约或旧持有人的校验。

## 验收用户故事

作为用户，我希望长时间运行的智能体能持续更新工具结果，保留文本和思考顺序，
并在流式执行结束后仍能读到完整内容。

| 场景 | 关键断言 | CI 套件 |
| --- | --- | --- |
| 特殊 ID 的重复更新 | 只更新原位置，块数和顺序不变 | Python 单测、真实 Redis 集成、Rust Redis 集成 |
| Python/Rust 共用索引，旧端只追加列表 | 补齐遗漏索引，更新远离尾部的块不产生重复 | Python/Rust Redis 集成 |
| 索引过期和清理 | 过期后从原列表恢复，清理同时删除列表与索引 | Python/Rust Redis 集成 |
| 长流式 HTTP 回调 | 40 轮工具、思考、文本交替及特殊 ID 更新；最终 MySQL 内容、顺序和状态完整 | `responses_large_json` HTTP E2E |

测试复用现有 CI 的 MySQL、Redis 和 Responses HTTP 服务，不新增 CI 服务或分片。
