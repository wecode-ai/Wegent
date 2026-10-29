---
sidebar_position: 27
title: Rust 认证兼容性
---

# Rust 认证兼容性

Rust 已接管的 API 以对应 Python 认证依赖为兼容性标准。路由归属仍由活动路由配置决定；
修改认证公共模块不会迁移或切换其他 API。

## 会话 JWT

会话入口复用 backend-rs/src/auth.rs 与 jwt_compat.rs，不应独立使用 JWT 库的默认校验配置。

校验顺序为签名及配置算法、声明、会话用途、用户查询与激活状态。签名使用当前密钥，
同时支持配置中的历史只读密钥。轮换密钥不能绕过声明校验；多凭证入口的每个候选分支
都必须执行该类令牌自己的签名、时间和用途校验。

python-jose 会话规则如下：

- scope 采用 Python 真值规则：缺失、null、false、0、空字符串、空数组和空对象均为假值。
  非空 scope 不属于用户会话；token_use 仅允许缺失、null 或 wework_access。
- exp、nbf 和 iat 默认都不是必填项；存在时按 Python int() 语义转换。
- exp 小于当前整秒时间时过期；nbf 大于当前时间时尚未生效；不设置过期宽限。
  iat 检查能否转换为整数，普通会话校验不额外拒绝未来 iat。
- sub 和 jti 存在时必须为字符串。会话认证还要求有效用户名称及激活用户。
- 当前会话解码没有配置 audience 或 access_token，因此存在 aud 或 at_hash 的令牌被拒绝。

## 认证入口与其他令牌

标准 OAuth2 和可选 OAuth2 入口接受大小写不敏感的 Bearer scheme，不接受裸 JWT。
缺少或错误 scheme 与提供了无效 Bearer 令牌是不同的认证失败。

多凭证入口保留对应 Python 依赖的顺序及 header 解析：X-API-Key、Authorization API Key、
会话 JWT、Task Token。不能将标准 OAuth2 的解析规则直接覆盖到多凭证入口。

Task Token 和 Skill 身份令牌按 PyJWT 规则校验，不能套用会话的用途规则：
PyJWT 拒绝未来 iat，且 exp 等于当前时间也视为过期；它不执行 at_hash 校验。
Task Token 的各回退入口要求 task_id、subtask_id、user_id 和 user_name 字段存在，
且 type 为 task_token。技能身份令牌保留自己的字段和用途检查。
设备证明保留自己的签名、请求绑定、时间窗和设备检查。

标准用户查询的数据库异常返回服务端错误，不得伪装成无效凭证 401。
可选认证按 Python 返回匿名结果；业务入口仍负责匿名访问的权限检查。

## 验证

Python 对照样例使用固定时钟和测试密钥，不包含实际令牌或用户数据。重新生成：

    uv run --no-project --with python-jose==3.5.0 --with PyJWT==2.10.1 python backend-rs/tests/fixtures/generate_jwt_python_cases.py

Rust 单元测试验证样例，并检查认证入口接线、过期令牌拒绝、历史密钥、错误签名和算法、
不同用途令牌及数据库失败分类。它们由现有 Rust CI 的 cargo test --locked 执行。
现有 Responses HTTP E2E 还在真实网关、MySQL 和 Redis 中覆盖会话声明及 Task 回退边界，
由同一 Rust CI 中的 responses_large_json 套件执行。
日志和提交内容不得包含 JWT、API Key、签名密钥或认证文件内容。
