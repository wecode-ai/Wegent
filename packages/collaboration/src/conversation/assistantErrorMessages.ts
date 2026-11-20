export const assistantErrorMessages: Record<
  "zh-CN" | "en",
  Record<string, string>
> = {
  "zh-CN": {
    "conversation.assistant_error.details": "错误详情",
    "conversation.assistant_error.git_access.title": "Git 仓库访问失败",
    "conversation.assistant_error.git_access.credentials-required":
      "{{domain}} 需要目标设备上的 Git 凭据。请在设置 → 集成 → Git 账户配置对应域；本机执行请配置本机 Git 或 SSH 后重试。",
    "conversation.assistant_error.git_access.authentication-failed":
      "{{domain}} 的 Git 认证被拒绝。请检查设置 → 集成 → Git 账户中的令牌或目标设备的 SSH 密钥后重试。",
    "conversation.assistant_error.git_access.ssh-authentication-failed":
      "{{domain}} 的 SSH 认证被拒绝。请配置目标设备的 SSH 密钥后重试，云端 Git 令牌不能替代 SSH 密钥。",
    "conversation.assistant_error.git_access.repository-inaccessible":
      "请检查仓库地址和账户的仓库访问权限；不一定是登录问题。",
    "conversation.assistant_error.git_access.network-error":
      "请检查目标设备网络、代理、TLS 证书和 SSH 主机信任后重试。",
    "conversation.assistant_error.git_access.git-unavailable":
      "目标设备无法启动 Git，请安装或修复 Git 后重试。",
    "conversation.assistant_error.git_access.invalid-url":
      "请使用不含凭据或查询参数的合法仓库地址。",
    "conversation.assistant_error.git_access.clone-failed":
      "仓库访问检查已通过，但克隆失败。请检查分支、目标目录、磁盘空间和设备权限。",
    "conversation.assistant_error.actions.switch_model_retry": "切换模型并重试",
    "conversation.assistant_error.actions.retry": "重试",
    "conversation.assistant_error.actions.retry_after_change": "修复后重试",
    "conversation.assistant_error.types.context_length_exceeded.title":
      "对话内容超出当前模型的上下文长度限制",
    "conversation.assistant_error.types.context_length_exceeded.description":
      "建议切换到支持更大上下文的模型，或开始一个新对话。",
    "conversation.assistant_error.types.quota_exceeded.title":
      "当前模型的使用额度已耗尽",
    "conversation.assistant_error.types.quota_exceeded.description":
      "请切换到其他可用模型，或稍后在额度恢复后继续。",
    "conversation.assistant_error.types.rate_limit.title":
      "请求过于频繁，请稍后再试",
    "conversation.assistant_error.types.rate_limit.description":
      "请等待片刻后重试，或切换到其他可用模型。",
    "conversation.assistant_error.types.payload_too_large.title":
      "内容过长：对话历史或附件超出限制，请开始新对话或减小附件大小",
    "conversation.assistant_error.types.payload_too_large.description":
      "请减少附件或上下文内容后重试。",
    "conversation.assistant_error.types.model_service_connection_error.title":
      "无法连接模型服务",
    "conversation.assistant_error.types.model_service_connection_error.description":
      "连接错误：向模型服务发送请求失败。请检查网络或 VPN 连接后重试。",
    "conversation.assistant_error.types.network_error.title":
      "网络连接失败：请检查网络连接后重试",
    "conversation.assistant_error.types.network_error.description":
      "当前连接中断或服务暂时不可达，请稍后重试。",
    "conversation.assistant_error.types.timeout_error.title": "等待响应超时",
    "conversation.assistant_error.types.timeout_error.description":
      "本次请求未能及时收到响应。请重试或切换模型。",
    "conversation.assistant_error.types.timeout_error.description_with_seconds":
      "本次请求在 {{seconds}} 秒内未收到模型或工具进展。请重试或切换模型。",
    "conversation.assistant_error.types.server_overloaded.title":
      "模型服务繁忙",
    "conversation.assistant_error.types.server_overloaded.description":
      "模型服务当前过载。请稍后重试或切换模型。",
    "conversation.assistant_error.types.llm_error.title":
      "模型调用失败：模型暂时不可用，请稍后重试",
    "conversation.assistant_error.types.llm_error.description":
      "模型服务当前不可用，可以稍后重试或切换模型。",
    "conversation.assistant_error.types.model_unavailable.title":
      "当前选择的模型暂不可用",
    "conversation.assistant_error.types.model_unavailable.description":
      "请稍后重试或切换其他模型。",
    "conversation.assistant_error.types.llm_unsupported.title":
      "当前模型不支持此请求，请更换其他模型",
    "conversation.assistant_error.types.llm_unsupported.description":
      "当前输入或附件类型不被该模型支持，请切换兼容模型。",
    "conversation.assistant_error.types.invalid_parameter.title":
      "参数错误：请求参数不正确，请检查输入内容",
    "conversation.assistant_error.types.invalid_parameter.description":
      "请求参数与模型要求不匹配，请调整输入后重试。",
    "conversation.assistant_error.types.forbidden.title":
      "访问被拒绝：您没有使用此资源的权限",
    "conversation.assistant_error.types.forbidden.description":
      "请确认账号、设备或模型权限后重试。",
    "conversation.assistant_error.types.container_oom.title":
      "执行环境内存不足",
    "conversation.assistant_error.types.container_oom.description":
      "请开始新对话重试，或联系管理员增加执行环境内存。",
    "conversation.assistant_error.types.container_error.title": "执行环境异常",
    "conversation.assistant_error.types.container_error.description":
      "容器或本地任务服务暂时不可用，请稍后重试。",
    "conversation.assistant_error.types.content_filter.title":
      "内容触发安全审核，请修改敏感内容后重试",
    "conversation.assistant_error.types.content_filter.description":
      "请调整输入中可能触发安全策略的内容。",
    "conversation.assistant_error.types.provider_error.title":
      "模型服务异常，请稍后再试",
    "conversation.assistant_error.types.provider_error.description":
      "上游模型服务返回异常，可以稍后重试或切换模型。",
    "conversation.assistant_error.types.image_too_large.title":
      "图片超出大小限制，请压缩图片后重试",
    "conversation.assistant_error.types.image_too_large.description":
      "请压缩图片或减少图片数量后重新发送。",
    "conversation.assistant_error.types.model_protocol_error.title":
      "模型与当前运行协议不匹配",
    "conversation.assistant_error.types.model_protocol_error.description":
      "当前模型不支持此请求格式。请切换兼容模型后重试。",
    "conversation.assistant_error.types.model_protocol_error.description_with_model":
      "{{model}} 不支持当前运行协议。请切换兼容模型后重试。",
    "conversation.assistant_error.types.invalid_role.title":
      "模型参数异常：消息角色格式不兼容",
    "conversation.assistant_error.types.invalid_role.description":
      "当前模型不支持此消息格式，建议切换模型后重试。",
    "conversation.assistant_error.types.permission_denied.title":
      "无权限使用当前模型，请切换到有权限的模型",
    "conversation.assistant_error.types.permission_denied.description":
      "请确认模型访问权限，或切换到权限范围内的模型。",
    "conversation.assistant_error.types.authentication_expired.title":
      "登录或凭据已失效",
    "conversation.assistant_error.types.authentication_expired.description":
      "请查看错误详情，在对应账户或连接器中重新认证后重试。",
    "conversation.assistant_error.types.skills_unmanaged_entries.title":
      "Skills 目录与管理记录不一致",
    "conversation.assistant_error.types.skills_unmanaged_entries.description":
      "执行环境准备失败。请检查 Skills 目录中未纳入管理的目录项，修复目录状态后重试；直接重复请求不会解决冲突。",
    "conversation.assistant_error.types.skill_deploy_failed.title":
      "技能准备失败",
    "conversation.assistant_error.types.skill_deploy_failed.description":
      "请查看错误详情，检查技能配置和执行环境后重试。",
    "conversation.assistant_error.types.executor_start_failed.title":
      "执行器启动失败",
    "conversation.assistant_error.types.executor_start_failed.description":
      "请查看错误详情，检查执行环境和启动配置，修复后重试。",
    "conversation.assistant_error.types.workspace_unavailable.title":
      "工作区不可用",
    "conversation.assistant_error.types.workspace_unavailable.description":
      "请检查工作区状态和访问权限，确认工作区可访问后重试。",
    "conversation.assistant_error.types.tool_execution_failed.title":
      "工具执行失败",
    "conversation.assistant_error.types.tool_execution_failed.description":
      "请查看错误详情，检查工具输入和配置，再决定是否重试。",
    "conversation.assistant_error.types.connector_unavailable.title":
      "连接器暂时不可用",
    "conversation.assistant_error.types.connector_unavailable.description":
      "请检查连接器的连接状态，稍后重试；反复失败时请保留错误详情供排查。",
    "conversation.assistant_error.types.plugin_load_failed.title":
      "插件加载失败",
    "conversation.assistant_error.types.plugin_load_failed.description":
      "请查看错误详情，检查插件安装状态和配置，修复后重试。",
    "conversation.assistant_error.types.stream_protocol_error.title":
      "响应流解析失败",
    "conversation.assistant_error.types.stream_protocol_error.description":
      "请稍后重试；反复失败时请提供错误详情和任务信息供排查。",
    "conversation.assistant_error.types.internal_error.title": "平台内部错误",
    "conversation.assistant_error.types.internal_error.description":
      "请稍后重试；反复发生时请提供错误详情和任务信息供排查。",
    "conversation.assistant_error.types.storage_error.title":
      "对话数据读写失败",
    "conversation.assistant_error.types.storage_error.description":
      "请先检查本次内容是否已保存，再稍后重试；反复失败时请保留错误详情供排查。",
    "conversation.assistant_error.types.dispatch_error.title": "任务调度失败",
    "conversation.assistant_error.types.dispatch_error.description":
      "请稍后重试；反复失败时请检查执行资源状态并提供错误详情。",
    "conversation.assistant_error.types.generic_error.title": "消息生成失败",
    "conversation.assistant_error.types.generic_error.description":
      "请求未能完成。你可以稍后重试，或查看错误详情。",
    "conversation.assistant_error.types.generic_error.description_without_details":
      "请求未能完成。你可以稍后重试。",
  },
  en: {
    "conversation.assistant_error.details": "Error details",
    "conversation.assistant_error.git_access.title":
      "Git repository access failed",
    "conversation.assistant_error.git_access.credentials-required":
      "{{domain}} requires Git credentials on the selected device. Configure the domain under Settings → Integrations → Git accounts; for local execution, configure local Git or SSH and retry.",
    "conversation.assistant_error.git_access.authentication-failed":
      "Git authentication for {{domain}} was rejected. Check the token under Settings → Integrations → Git accounts or the device SSH key, then retry.",
    "conversation.assistant_error.git_access.ssh-authentication-failed":
      "SSH authentication for {{domain}} was rejected. Configure the target device SSH key and retry; cloud Git tokens cannot replace SSH keys.",
    "conversation.assistant_error.git_access.repository-inaccessible":
      "Check the repository URL and account access; this is not necessarily a login problem.",
    "conversation.assistant_error.git_access.network-error":
      "Check the device network, proxy, TLS certificate and SSH host trust, then retry.",
    "conversation.assistant_error.git_access.git-unavailable":
      "Git cannot start on the selected device. Install or repair Git and retry.",
    "conversation.assistant_error.git_access.invalid-url":
      "Use a valid repository URL without credentials or query parameters.",
    "conversation.assistant_error.git_access.clone-failed":
      "Repository access passed, but cloning failed. Check the branch, destination, disk space and device permissions.",
    "conversation.assistant_error.actions.switch_model_retry":
      "Switch model and retry",
    "conversation.assistant_error.actions.retry": "Retry",
    "conversation.assistant_error.actions.retry_after_change":
      "Retry after fixing",
    "conversation.assistant_error.types.context_length_exceeded.title":
      "The conversation is too long for this model's context window",
    "conversation.assistant_error.types.context_length_exceeded.description":
      "Try a model with a larger context window, or start a fresh conversation.",
    "conversation.assistant_error.types.quota_exceeded.title":
      "The model's usage quota has been exhausted",
    "conversation.assistant_error.types.quota_exceeded.description":
      "Switch to another available model, or continue after quota is restored.",
    "conversation.assistant_error.types.rate_limit.title":
      "Too many requests. Please wait a moment before trying again",
    "conversation.assistant_error.types.rate_limit.description":
      "Wait briefly and retry, or switch to another available model.",
    "conversation.assistant_error.types.payload_too_large.title":
      "Content too large: conversation history or attachment exceeds the limit",
    "conversation.assistant_error.types.payload_too_large.description":
      "Reduce attachments or context content, then retry.",
    "conversation.assistant_error.types.model_service_connection_error.title":
      "Unable to connect to the model service",
    "conversation.assistant_error.types.model_service_connection_error.description":
      "Connection error: The request could not be sent to the model service. Check your network or VPN connection and retry.",
    "conversation.assistant_error.types.network_error.title":
      "Network error: Please check your connection and try again",
    "conversation.assistant_error.types.network_error.description":
      "The connection was interrupted or the service is temporarily unreachable.",
    "conversation.assistant_error.types.timeout_error.title":
      "Timed out waiting for a response",
    "conversation.assistant_error.types.timeout_error.description":
      "The request did not receive a response in time. Retry or switch models.",
    "conversation.assistant_error.types.timeout_error.description_with_seconds":
      "No model or tool progress was received within {{seconds}} seconds. Retry or switch models.",
    "conversation.assistant_error.types.server_overloaded.title":
      "Model service is busy",
    "conversation.assistant_error.types.server_overloaded.description":
      "The model service is overloaded. Retry later or switch models.",
    "conversation.assistant_error.types.llm_error.title":
      "Model error: The model is temporarily unavailable",
    "conversation.assistant_error.types.llm_error.description":
      "The model service is unavailable. Try again later or switch models.",
    "conversation.assistant_error.types.model_unavailable.title":
      "The selected model is unavailable",
    "conversation.assistant_error.types.model_unavailable.description":
      "Try again later or switch to another model.",
    "conversation.assistant_error.types.llm_unsupported.title":
      "Current model does not support this request",
    "conversation.assistant_error.types.llm_unsupported.description":
      "This input or attachment type is not supported by the model. Switch to a compatible model.",
    "conversation.assistant_error.types.invalid_parameter.title":
      "Invalid parameter: Request parameters are incorrect",
    "conversation.assistant_error.types.invalid_parameter.description":
      "The request does not match the model requirements. Adjust the input and retry.",
    "conversation.assistant_error.types.forbidden.title":
      "Access denied: You do not have permission to use this resource",
    "conversation.assistant_error.types.forbidden.description":
      "Check your account, device, or model permissions and retry.",
    "conversation.assistant_error.types.container_oom.title":
      "Executor out of memory",
    "conversation.assistant_error.types.container_oom.description":
      "Start a new conversation to retry, or contact an administrator to increase memory.",
    "conversation.assistant_error.types.container_error.title":
      "Task service error",
    "conversation.assistant_error.types.container_error.description":
      "The container or runtime task service is temporarily unavailable. Try again later.",
    "conversation.assistant_error.types.content_filter.title":
      "Content triggered security review and was rejected",
    "conversation.assistant_error.types.content_filter.description":
      "Modify the parts that may trigger the safety policy and retry.",
    "conversation.assistant_error.types.provider_error.title":
      "Model service error. Please try again later",
    "conversation.assistant_error.types.provider_error.description":
      "The upstream model service returned an error. Retry later or switch models.",
    "conversation.assistant_error.types.image_too_large.title":
      "Image exceeds size limit. Please compress the image and retry",
    "conversation.assistant_error.types.image_too_large.description":
      "Compress the image or reduce the number of images, then send again.",
    "conversation.assistant_error.types.model_protocol_error.title":
      "Model and runtime protocol do not match",
    "conversation.assistant_error.types.model_protocol_error.description":
      "The current model does not support this request format. Switch to a compatible model and retry.",
    "conversation.assistant_error.types.model_protocol_error.description_with_model":
      "{{model}} does not support the current runtime protocol. Switch to a compatible model and retry.",
    "conversation.assistant_error.types.invalid_role.title":
      "Model parameter error: Message role format is incompatible",
    "conversation.assistant_error.types.invalid_role.description":
      "The current model does not support this message format. Switch models and retry.",
    "conversation.assistant_error.types.permission_denied.title":
      "No permission to use the current model",
    "conversation.assistant_error.types.permission_denied.description":
      "Check model access permissions, or switch to a model within your permissions.",
    "conversation.assistant_error.types.authentication_expired.title":
      "Login or credentials have expired",
    "conversation.assistant_error.types.authentication_expired.description":
      "View the error details and authenticate again in the relevant account or connector before retrying.",
    "conversation.assistant_error.types.skills_unmanaged_entries.title":
      "Skills directory does not match its managed records",
    "conversation.assistant_error.types.skills_unmanaged_entries.description":
      "Environment preparation failed. Check the unmanaged entries in the Skills directory and fix the directory state before retrying. Repeating the request alone will not resolve the conflict.",
    "conversation.assistant_error.types.skill_deploy_failed.title":
      "Skill preparation failed",
    "conversation.assistant_error.types.skill_deploy_failed.description":
      "View the error details, check the skill configuration and execution environment, then retry.",
    "conversation.assistant_error.types.executor_start_failed.title":
      "Executor could not start",
    "conversation.assistant_error.types.executor_start_failed.description":
      "View the error details and check the execution environment and startup configuration before retrying.",
    "conversation.assistant_error.types.workspace_unavailable.title":
      "Workspace is unavailable",
    "conversation.assistant_error.types.workspace_unavailable.description":
      "Check the workspace state and access permissions, then retry once it is accessible.",
    "conversation.assistant_error.types.tool_execution_failed.title":
      "Tool execution failed",
    "conversation.assistant_error.types.tool_execution_failed.description":
      "View the error details and check the tool input and configuration before deciding whether to retry.",
    "conversation.assistant_error.types.connector_unavailable.title":
      "Connector is temporarily unavailable",
    "conversation.assistant_error.types.connector_unavailable.description":
      "Check the connector's connection state and retry later. Keep the error details for investigation if it fails again.",
    "conversation.assistant_error.types.plugin_load_failed.title":
      "Plugin could not load",
    "conversation.assistant_error.types.plugin_load_failed.description":
      "View the error details and check the plugin installation and configuration before retrying.",
    "conversation.assistant_error.types.stream_protocol_error.title":
      "Response stream could not be parsed",
    "conversation.assistant_error.types.stream_protocol_error.description":
      "Retry later. If it fails again, provide the error details and task information for investigation.",
    "conversation.assistant_error.types.internal_error.title":
      "Internal platform error",
    "conversation.assistant_error.types.internal_error.description":
      "Retry later. If it happens again, provide the error details and task information for investigation.",
    "conversation.assistant_error.types.storage_error.title":
      "Conversation data could not be read or saved",
    "conversation.assistant_error.types.storage_error.description":
      "Check whether your content was saved before retrying later. Keep the error details for investigation if it fails again.",
    "conversation.assistant_error.types.dispatch_error.title":
      "Task dispatch failed",
    "conversation.assistant_error.types.dispatch_error.description":
      "Retry later. If it fails again, check the execution resources and provide the error details.",
    "conversation.assistant_error.types.generic_error.title":
      "Message generation failed",
    "conversation.assistant_error.types.generic_error.description":
      "The request could not be completed. Try again later, or view the error details.",
    "conversation.assistant_error.types.generic_error.description_without_details":
      "The request could not be completed. Try again later.",
  },
};
