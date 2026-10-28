---
sidebar_position: 1
---

# 钉钉 OAuth 导入闭环测试

本套件允许模拟钉钉外部 OAuth、MCP 和文件下载服务，以及模型服务。
Wegent API、OAuth 会话与回调、MySQL、Redis、Celery、Chat Shell、对象存储、
知识运行时和 Qdrant 全部真实运行，不加载 `backend/tests/conftest.py` 中的单测替身。
OAuth 通过 HTTP 客户端走发现、动态客户端注册、PKCE 授权码兑换、浏览器绑定
Cookie、回调和轮询，不宣称覆盖浏览器界面的点击交互。

**没有钉钉测试账号，真实钉钉兼容性仍未验证。模拟器通过不代表真实钉钉授权通过。**

## 覆盖范围

| 要求             | 场景及最终断言                                                                                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ① 授权与导入     | Docs 授权后导入正文；修改外部版本后通过正式扫描 API、真实队列和 worker 自动更新同一文档及索引。Table、AI Table 缺少自身授权时失败，授权后原地重试成功，实际 XLSX 单元格内容进入索引。签名下载请求不携带 MCP 凭据；个人 URL 模式可用且不刷新 OAuth。 |
| ② 并发刷新       | 两次导入与真实 Chat 任务竞争同一过期授权，观察 InnoDB 至少两个锁等待后释放刷新，断言仅刷新一次，正文及模型收到的工具结果正确；跨服务并发刷新后两份轮换凭据均保留。                                                                                  |
| ③ 重新授权与失效 | 刷新成功和 `invalid_grant` 均保留待完成的新授权；授权完成后最终凭据匹配新签发结果。失效授权阻止上游读取和正文落库，不借用另一用户或另一服务的有效凭据。                                                                                             |
| ④ 旧回调与竞争   | 暂停旧回调的授权码兑换，分别断开、保存配置（含 A → B → A）、完成替代授权，再放行旧回调；旧回调得到 409 且不能恢复凭据。真实 MySQL 锁忙返回 503，原凭据不变，释放锁后可恢复。回调中授权码已兑换时通过新授权恢复，不重放旧授权码。                    |

每个场景创建独立用户与资源，清理失败会使测试失败；不跳过、不重跑。
并发通过模拟器暂停点和数据库报告的真实锁等待协调，不用固定等待制造交错。
仅安排到期元数据和持有测试行锁，不向数据库注入授权 token，不替换 Wegent 方法。

## CI 与运行

`.github/workflows/e2e-tests.yml` 的平台 E2E 第一个分片显式运行本套件，
并上传 JUnit 与脱敏证据：最终凭据指纹、文档状态、正文指纹及外部服务调用记录。

CI 在一次性容器的网络命名空间中为回环接口增加 `11.255.255.254/32`，并信任
一次性测试证书，提供真实 HTTPS 下载。该地址不访问外网。生产代码中的 HTTPS、
证书和公网地址检查保持启用，没有添加下载白名单或测试旁路。
准备步骤为 `.github/scripts/setup-dingtalk-oauth-e2e.sh`，依赖容器的 `NET_ADMIN`。

启动工作流已有服务、准备证书和下载地址后，在 `backend/` 执行：

```bash
PYTHONPATH=..:. uv run --no-sync python e2e_checks/check_dingtalk_provider.py
DINGTALK_OAUTH_E2E=1 PYTHONPATH=..:. uv run --no-sync pytest \
  e2e_checks/dingtalk_oauth -n 0 --junitxml=reports/dingtalk-oauth-e2e.xml
```

需要与应用进程一致的 `DATABASE_URL`、`REDIS_URL`、加密配置，以及
`E2E_BOOTSTRAP_ADMIN_PASSWORD`、`E2E_API_URL`、`E2E_QDRANT_URL`、
`KNOWLEDGE_RUNTIME_URL`、`MOCK_MODEL_SERVER_URL`。
下载夹具必须设置 `DINGTALK_E2E_DOWNLOAD_ORIGIN`、`DINGTALK_E2E_TLS_CERT`、
`DINGTALK_E2E_TLS_KEY`，应用和 worker 必须信任该证书。
测试数据库须为本机或 CI MySQL 服务上的专用测试库。缺失服务、凭据或配置会失败。

`check_dingtalk_provider.py` 仅校验模拟器的 OAuth/MCP 协议行为，不能代替上述 E2E。
