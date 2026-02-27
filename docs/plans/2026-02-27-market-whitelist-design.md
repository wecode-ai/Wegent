---
sidebar_position: 1
---

# Subscription Market 白名单可见设计

## 概述

本设计为订阅市场（`visibility=market`）增加“仅白名单用户可见/可租用”能力。

目标：
- 订阅可发布到市场，但仅白名单用户可见。
- 白名单用户可租用后，以租用者身份执行任务。
- 白名单为空时，保持当前行为：市场全员可见。

已确认的产品规则：
- 白名单录入方式：邮箱搜索并确认用户存在后添加。
- 非白名单访问市场详情：返回 `403`（而非 `404`）。
- 首版范围：仅用户白名单（不含 namespace 白名单）。

## 现状与约束

- `market` 列表与详情由 `SubscriptionMarketService` 提供。
- 当前市场可见性仅基于 `visibility=market`，无额外可见控制。
- 租用后执行身份已是租用者（现有逻辑满足目标，无需改执行身份主链路）。

## 方案选择

本次采用方案 1：将白名单直接存储在订阅 JSON（`_internal`）。

### 备选方案对比

1. JSON 内存储白名单（本次采用）
- 优点：改动小，无需新表。
- 缺点：查询过滤在应用层执行，后续扩展与性能弹性一般。

2. 复用 follow/invitation 模型承载可见白名单
- 优点：无新存储结构。
- 缺点：语义耦合严重（关注关系与可见权限混淆），不采用。

3. 新增独立 whitelist 表
- 优点：语义清晰，查询与扩展更优。
- 缺点：需要 migration 与更多改造，本次不采用。

## 数据模型

### 后端 Schema 变更

在以下模型增加字段：
- `SubscriptionCreate.market_whitelist_user_ids?: number[]`
- `SubscriptionUpdate.market_whitelist_user_ids?: number[]`
- `SubscriptionInDB.market_whitelist_user_ids?: number[]`

### 持久化位置

订阅 JSON 的 `_internal` 新增：
- `_internal.market_whitelist_user_ids: number[]`

规则：
- 去重后存储。
- 仅保存有效用户 ID。
- 当 `visibility != market` 时字段可保留但不生效。

## 访问控制规则

新增统一判定函数（服务层）：
- `can_view_market(subscription, current_user_id) -> bool`

判定逻辑：
1. 若 `visibility != market`：`False`
2. 若 `current_user_id == owner_user_id`：`True`
3. 若白名单为空：`True`
4. 否则：`current_user_id in market_whitelist_user_ids`

## API 行为变更

### 1) 创建/更新订阅

- `POST /api/subscriptions`
- `PUT /api/subscriptions/{id}`

行为：
- 接收并校验 `market_whitelist_user_ids`。
- 仅接受存在且可用的用户 ID。
- 过滤非法 ID、去重后写入 `_internal.market_whitelist_user_ids`。

### 2) 市场列表

- `GET /api/market/subscriptions`

行为：
- 现有 `visibility=market` 过滤后，增加 `can_view_market` 过滤。
- 非白名单用户在列表中不可见。

### 3) 市场详情

- `GET /api/market/subscriptions/{id}`

行为：
- 若订阅不存在或非市场订阅：维持现有 `404`。
- 若为市场订阅但不在白名单：返回 `403`。

### 4) 租用市场订阅

- `POST /api/market/subscriptions/{id}/rent`

行为：
- 在现有可租校验前增加 `can_view_market` 判定。
- 非白名单用户返回 `403`。
- 白名单用户正常租用，执行身份保持租用者。

## 前端交互设计

### 交互流程（ASCII）

```text
[Open Subscription Form]
          |
          v
[Visibility Selector]
   | private/public -> [No whitelist UI]
   |
   +-- market -------> [Show Market Whitelist Section]
                              |
                              v
                    [Input email keyword]
                              |
                              v
                 [Call GET /users/search?q=...]
                              |
                +-------------+-------------+
                |                           |
                v                           v
         [No matched user]           [Matched user list]
                |                           |
        [Show "not found"]          [Select one user]
                |                           |
                +-------------+-------------+
                              v
                   [Click "Add to whitelist"]
                              |
                              v
                [Render whitelist chips/tags list]
                              |
                   +----------+----------+
                   |                     |
                   v                     v
          [Remove chip/tag]       [Keep editing]
                   |                     |
                   +----------+----------+
                              v
                      [Click Save]
                              |
                              v
[POST/PUT /subscriptions with market_whitelist_user_ids[]]
                              |
                +-------------+-------------+
                |                           |
                v                           v
            [Success]                    [Error]
                |                           |
      [Close + refresh list]        [Show toast error]
```

### UI 结构（ASCII）

```text
+----------------------------------------------------------------------------------+
| 新建订阅器                                                                       |
|----------------------------------------------------------------------------------|
| 名称:        [ 每日行业情报 ]                                                    |
| 描述:        [ 抓取并总结 AI 行业动态 ]                                          |
| ... 其他配置 ...                                                                  |
|                                                                                  |
| 可见性                                                                           |
| [ 私有 ]   [ 公开 ]   [ 市场 ]  <- 已选                                          |
|                                                                                  |
| 市场白名单（仅白名单用户可见并可租用）                                          |
| 白名单为空时：市场全员可见                                                       |
|                                                                                  |
| +--------------------------------------+   +------------+                        |
| | 输入邮箱搜索用户（如: alice@xx.com） |   | 搜索       |                        |
| +--------------------------------------+   +------------+                        |
|                                                                                  |
| 搜索结果                                                                          |
| +--------------------------------------------------------------------------+      |
| | alice  (alice@xx.com)                                [ 添加到白名单 ]    |      |
| | bob    (bob@xx.com)                                  [ 添加到白名单 ]    |      |
| +--------------------------------------------------------------------------+      |
|                                                                                  |
| 已添加白名单                                                                      |
| [ alice@xx.com  x ]   [ bob@xx.com  x ]                                          |
|                                                                                  |
|----------------------------------------------------------------------------------|
|                                           [ 取消 ]   [ 保存 ]                    |
+----------------------------------------------------------------------------------+
```

### 组件建议

- 在 `SubscriptionForm` 中新增 `MarketWhitelistSection`（仅 `visibility=market` 显示）。
- 使用 `GET /users/search` 按邮箱搜索用户并选中。
- 本地维护：
  - `marketWhitelistUsers[]`（用于展示）
  - `marketWhitelistUserIds[]`（用于提交）

## 边界与回归点

- Owner 永远可见。
- 白名单为空 => 全员可见（兼容当前行为）。
- 非白名单访问市场详情/租用 => `403`。
- `market -> private/public`：白名单保留但不生效。
- 切回 `market`：白名单重新生效。

## 测试策略

### 后端

- `discover_market_subscriptions`：
  - 白名单为空可见
  - 白名单命中可见
  - 白名单未命中不可见
- `get_market_subscription_detail`：
  - 非白名单返回 `403`
- `rent_subscription`：
  - 非白名单返回 `403`
  - 白名单用户可成功租用
- 创建/更新：
  - 白名单去重
  - 非法 user_id 过滤或报错

### 前端

- 邮箱检索并添加白名单成功。
- 重复添加拦截。
- 保存后回显白名单。
- `403` 错误提示正确展示。

## 后续扩展

- namespace 白名单（第二阶段）。
- 从 JSON 存储迁移到独立白名单表（当性能或治理需求提升时）。
