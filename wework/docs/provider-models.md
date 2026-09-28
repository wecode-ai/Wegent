# Local provider connections

## 中文

模型设置新增 Provider 服务连接。连接地址、Key 和默认协议只填写一次，所属模型共同使用；云端下发模型、原有 Codex 账号来源及远程执行权限保持独立。

### 使用

1. 添加或编辑服务连接，填写 Base URL 和 API Key。
2. 点击“获取模型列表”，直接使用当前表单配置，无需先保存连接。获取列表不会自动保存配置。
3. 在需要的模型旁点击“添加”，或手动添加单个模型。
4. 在模型编辑区域直接调整模型能力和最大上下文；协议与工具兼容设置保留在低频设置中。
5. 点击“保存连接”统一生效。取消未保存的编辑不会创建服务连接。

常规页面不展示 YAML 文件路径、选择文件、打开文件编辑、文件重新加载或批量粘贴模型 ID 模块。已有本地模型可通过“迁移已有模型”整理为共享连接，保留原模型 ID 和能力配置；不会迁移云端目录。

### 存储与兼容性

底层配置仍由原生配置服务保存，默认位置为应用用户数据目录下的 `model-connections/model.yml`。页面采用文件版本检查及原子写入；外部编辑冲突不会被覆盖，无效文件保留上一份有效配置并报错。当前版本不自动监听外部文件变化，页面也不提供文件管理入口。

支持 `openai-responses`、`openai-chat-completions`、`anthropic-messages`。模型默认继承连接协议，也可以用 `api_format` / `request_path` 单独覆盖。模型 `id` 是稳定的本地身份，`model_id` 是发给上游的标识；改名称时不要更改 `id`。模型级 `catalog_entry` 保留能力配置。获取模型列表仅返回候选项，不代表推理或工具调用已经验证；列表不可用时仍可手动添加。

页面不回显完整 Key，不把新 Key 写入 localStorage。页面保存使用已有桌面安全存储，YAML 中记录 `api_key_ref`。文件格式兼容显式 `api_key`，但这是明文，不要提交或分享；页面保存会将其换为本机凭据引用。凭据引用不能跨机器直接使用。

迁移按地址、Key、协议和路径分组，先持久化 Provider 配置，再清除对应旧记录。更改模型能力后沿用现有目录同步与空闲重启/确认机制，不强制中断正在运行的任务，也不会因为读取本地配置就自动上传全部连接或 Key。

## English

Local provider connections share one endpoint, credential, and default API format across multiple models. Cloud-delivered models, existing Codex account sources, and remote execution permissions remain separate.

Add or edit a connection, enter its Base URL and API key, and fetch models directly from the current form without saving first. Add each candidate individually, or add a model manually. Model capabilities and maximum context are directly editable; protocol and tool compatibility options remain under less-frequent settings. Save the connection to apply the changes. Discovery does not persist the draft or verify inference/tool execution.

The regular settings UI intentionally omits YAML file controls and batch-paste inputs. Existing standalone local models can be explicitly migrated while preserving their IDs and capabilities. Cloud catalogs are not migrated.

The native configuration service still persists `model-connections/model.yml` under the application user-data directory. Revision checks reject stale form saves, writes are atomic, and malformed files retain the last-known-good configuration. External files are not watched automatically. File-management capabilities remain internal rather than being exposed in the regular settings UI.

Keys entered in the UI use the existing native secure value store, with machine-local `api_key_ref` values in YAML. Inline `api_key` values are supported by the file format for compatibility but must never be committed or shared. Existing catalog synchronization, runtime-idle handling, and restart confirmation remain in place.
