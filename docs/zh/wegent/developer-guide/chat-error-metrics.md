---
sidebar_position: 55
---

# 对话错误分类与 P0 指标

Backend 和 Executor 共用 wegent_protocol::chat_errors；Python 执行路径使用
shared.utils.error_classifier。实时错误事件与持久化结果携带 error_info，包含
code、category、stage 和 retry_policy。Web 与桌面错误卡片展示中英文处理建议，
保留原始错误详情、手动重试和模型选择。P0 不增加自动重试。

## 分类约定

具体业务错误码优先；历史 generic_error 和 llm_error 可根据明确原因细分。
未注册错误码在指标中统一为 generic_error/unknown。额度耗尽区别于普通限流，
单独的 502 状态也不证明发生超时。

| 类别      | 常见错误码                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------- |
| model     | rate_limit、quota_exceeded、server_overloaded、model_unavailable、provider_error                                            |
| input     | context_length_exceeded、payload_too_large、invalid_parameter、llm_unsupported                                              |
| access    | forbidden、permission_denied、authentication_expired                                                                        |
| policy    | content_filter                                                                                                              |
| runtime   | skills_unmanaged_entries、skill_deploy_failed、executor_start_failed、workspace_unavailable、container_oom、container_error |
| tool      | tool_execution_failed、connector_unavailable、plugin_load_failed                                                            |
| transport | network_error、timeout_error、stream_protocol_error                                                                         |
| platform  | internal_error、storage_error、dispatch_error                                                                               |
| unknown   | generic_error                                                                                                               |

Agent Skills directory contains unmanaged entries 对应
skills_unmanaged_entries/runtime/prepare/after_change。该错误来自目录内容与管理记录
不一致；先修复管理状态再重试。分类和埋点不删除目录内容、不放宽校验。

重试策略为 after_backoff（等待后重试）、after_change（修复配置、输入或环境后重试）、
none、unknown。阶段仅使用有明确证据的 validate/dispatch/prepare/model/tool/stream/persist，
其余为 unknown。

## 现有 /metrics

三个进程累计 Counter 接入 Rust Backend 原有 /metrics：

    wegent_chat_runs_total{outcome,entrypoint,shell,execution_mode}
    wegent_chat_run_failures_total{error_category,error_code,stage,entrypoint,shell,execution_mode}
    wegent_chat_requests_total{outcome,entrypoint}

执行单位是一次助手执行尝试，多机器人分别计数。结果为 success/failed/cancelled，
请求准入为 accepted/rejected。entrypoint 限定为 web/wework/api/automation/other；
shell 为 Codex/ClaudeCode/Agno/Dify/Chat/unknown；execution_mode 为 local/remote/unknown。
已解析 Shell 随原有 RUNNING 写入保存为服务端元数据；终态读取已锁定的行，
不增加分类所需的 Bot/Shell 查询。未解析的上下文使用 unknown。

终态仅在数据库保护的状态转换提交成功后计数。重复回调、error 后的 done、刷新及旧
事件重放不再次计数；同 ID 的人工重试重置状态后形成新尝试。失败结果和失败原因
在同一锁内递增，抓取不清空累计值。客户端断开不主动转为失败，执行中自行恢复的
临时错误不计入最终失败。

P0 覆盖 Rust 对话准入、标准助手 completion、dispatch 失败和已提交的 Wework
runtime execution 终态。HTTP 准入从进入处理器开始，不包含框架提前拒绝的认证或
JSON 解析。Wework API 以设备确认准入为 accepted，等待输出失败不改写准入结果。
没有服务端执行记录的纯本地个人任务、尚未迁移的 Python REST 取消直接写入路径
不纳入此进程计数；P0 不迁移这些 API。

标签不包含 Task、Subtask、用户、设备、模型名称、路径或原始错误文本。
原有 Redis TaskRunMetrics 继续表达当前失败状态，与累计 Counter 分开。
进程重启会重置 Counter；提交后、计数前崩溃可能漏记。P0 不承诺账务级精确性，
不增加 outbox 或数据库迁移。

## 查询示例

每秒最终失败数：

    sum by (error_category, error_code) (rate(wegent_chat_run_failures_total[5m]))

失败率（分母排除主动取消）：

    sum(rate(wegent_chat_runs_total{outcome="failed"}[5m]))
    / clamp_min(sum(rate(wegent_chat_runs_total{outcome=~"success|failed"}[5m])), 1e-9)

最近一小时的 Skills 管理冲突次数：

    sum(increase(wegent_chat_run_failures_total{error_code="skills_unmanaged_entries"}[1h]))
