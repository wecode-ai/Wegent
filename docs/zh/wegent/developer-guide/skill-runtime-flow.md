---
sidebar_position: 11
---

# 技能传递链路

本文描述 Wegent 在不同执行场景中的技能选择、解析、传递与消费方式，重点说明为什么技能相关逻辑必须由 backend 统一收敛，以及 sandbox / 本地设备为什么不能只依赖技能名称。

## 两层语义

Wegent 里的技能数据要区分两层：

| 层级 | 代表字段 | 含义 |
| --- | --- | --- |
| 原始选择 | `Ghost.spec.skills`、`Ghost.spec.preload_skills`、`Task.additional_skills`、`Subscription.spec.skillRefs` | 谁“要求”本次任务带哪些技能 |
| 解析结果 | `ExecutionRequest.skill_refs`、`ExecutionRequest.preload_skill_refs`、`GET /tasks/{id}/skills` 返回的 `skill_refs` / `preload_skill_refs` | backend 根据当前可见性和命名空间解析出的最终技能引用 |

只传名字不够，因为同名技能可能同时存在于：

- 用户私有空间 `default`
- 团队命名空间
- 公共技能空间

因此运行时下载技能时，必须优先使用 `skill_id + namespace + is_public` 这一组精确引用。

## 统一原则

技能链路现在遵循以下规则：

1. backend 是唯一的技能解析方
2. executor、sandbox、本地设备只消费 backend 已经解析好的 refs
3. `skills` / `preload_skills` 继续保留，兼容旧调用方
4. 新调用方应优先读取 `skill_refs` / `preload_skill_refs`

这条边界很重要。否则每个执行端都会各自实现一套“同名技能该解析成谁”的规则，最终不可维护。

## 核心字段

### Ghost

Ghost 是静态技能来源：

- `spec.skills`
- `spec.preload_skills`
- `spec.skill_refs`
- `spec.preload_skill_refs`

其中 `skill_refs` / `preload_skill_refs` 是创建或更新 Bot/Ghost 时就写入的精确引用。

### Chat / Chat Shell

用户在单次消息里显式勾选技能时，入口字段是：

- `payload.additional_skills`

这组数据会在 `build_execution_request()` 中与已有 `preload_skills` 合并，再由 `TaskRequestBuilder` 统一解析到：

- `ExecutionRequest.skill_names`
- `ExecutionRequest.preload_skills`
- `ExecutionRequest.user_selected_skills`
- `ExecutionRequest.skill_refs`
- `ExecutionRequest.preload_skill_refs`

其中：

- `user_selected_skills` 用于技能提示强化
- `skill_refs` / `preload_skill_refs` 用于执行端精确下载

### Task 持久化

当前任务级持久化仍保留历史兼容行为：

- `Task.metadata.labels.additionalSkills`
- `Task.metadata.labels.requestedSkillRefs`

其中：

- `additionalSkills` 是历史兼容的名字列表
- `requestedSkillRefs` 是新的原始选择，保存 `name/namespace/is_public`

这里仍然不会保存派生出来的 `skill_id`。原因是 `skill_id` 属于解析结果，会随资源变更而过期，不适合作为持久化真相源。

### Subscription

订阅的显式技能来源于：

- `Subscription.spec.skillRefs`

这组数据不会写进 Task labels。任务级回查时，backend 通过：

`Task -> BackgroundExecution(task_id) -> Subscription(subscription_id)`

重新读取订阅配置，再解析成当前有效的 skill refs。

这样可以避免把订阅执行期的派生状态缓存到 Task 上。

## 各场景链路

### 1. 普通 Chat / Chat Shell

链路如下：

1. Ghost 提供默认技能和 refs
2. 消息级 `additional_skills` 合并进请求期 `preload_skills`
3. `TaskRequestBuilder` 统一解析并生成 `ExecutionRequest.*refs`
4. Claude Code 等执行端基于 request 中的 refs 下载技能

这条链路同时负责技能提示强化，因为 `user_selected_skills` 只在请求构造阶段产生。

### 2. 订阅执行

链路如下：

1. `Subscription.spec.skillRefs` 转成请求期显式技能
2. `build_execution_request()` 调用 `TaskRequestBuilder`
3. backend 生成 `ExecutionRequest.skill_refs` / `preload_skill_refs`
4. 首次执行时，执行端可直接用 request 中的 refs

如果后续是 sandbox 重启或延迟初始化，不能假设还拿得到原始 request，因此需要任务级回查接口补齐同样的 refs。

### 3. Sandbox / 本地设备启动期

这类场景不会复用最初的 `ExecutionRequest`，而是重新调用：

- `GET /tasks/{task_id}/skills`

现在这个接口会动态汇总以下来源：

- Ghost 默认技能
- Ghost 预置 refs
- Task labels 里的 `additionalSkills`
- Subscription 的 `spec.skillRefs`

并返回：

- `skills`
- `preload_skills`
- `skill_refs`
- `preload_skill_refs`

这样 sandbox / 本地设备即使只知道 `task_id`，也能拿到与请求期一致的精确技能引用。

## 技能提示与技能下载的边界

这次问题里最容易混淆的是“技能提示”和“技能下载”。

### 技能提示

技能提示强化依赖：

- `ExecutionRequest.user_selected_skills`

Claude Code 侧的 `build_skill_emphasis_prompt()` 只消费这组字段，用于强调“用户显式选择了哪些技能”。

### 技能下载

技能下载依赖：

- `skill_refs`
- `preload_skill_refs`

如果没有 ref，只能退回按名字查询，这在同名技能、多命名空间技能或订阅技能场景下都不可靠。

因此：

- 修复 `/tasks/{id}/skills` 返回 refs 不会改变技能提示逻辑
- 它只修复 sandbox / 本地设备的技能下载精度

## 兼容策略

当前实现保留以下兼容行为：

1. `/tasks/{id}/skills` 仍返回 `skills` / `preload_skills`
2. 历史 Task 里只有 `additionalSkills` 名称列表时，backend 会在查询时补解析 refs
3. 新 Task 会同时写入 `requestedSkillRefs`，保证普通聊天在 sandbox / 本地设备启动期也能找回用户当时选择的命名空间信息
4. 历史 Ghost 没有写入 `skill_refs` 时，backend 会按当前查找规则回填 refs

因此老任务、老 Ghost 和老执行端都不会立刻失效；只是新执行端应优先消费 refs。

## 维护建议

后续新增技能来源时，遵守下面两条即可：

1. 新来源只保存“原始选择”，不要持久化派生 `skill_id`
2. 所有运行期精确解析都进入 backend 的统一 resolver，再由执行端被动消费

只要守住这两个边界，Chat、Subscription、Sandbox、本地设备之间的技能行为就会保持一致。
