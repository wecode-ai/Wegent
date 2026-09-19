export const conversationMessages: Record<
  "zh-CN" | "en",
  Record<string, string>
> = {
  "zh-CN": {
    "conversation.workbench.scroll_to_bottom": "下拉到底",
    "conversation.workbench.loading_conversation": "正在加载会话...",
    "conversation.workbench.empty_conversation_title": "开始新的对话",
    "conversation.workbench.empty_conversation_description":
      "在下方输入问题、粘贴上下文或添加附件，WeWork 会在这里展示回复。",
    "conversation.workbench.loading_older_messages": "正在加载...",
    "conversation.workbench.load_older_messages": "加载更早记录",
    "conversation.workbench.code_comment_count": "{{count}} 个评论",
    "conversation.workbench.goal_chip": "目标",
    "conversation.user_message.collapse": "收起",
    "conversation.user_message.expand": "展开",
    "conversation.message_edit.cancel": "取消",
    "conversation.message_edit.send": "发送",
    "conversation.common.confirm": "确认",
    "conversation.workbench.browser_invalid_url":
      "请输入有效的 http 或 https 地址",
    "conversation.workbench.edit_link_text": "编辑文本",
    "conversation.workbench.edit_link_url": "编辑链接",
    "conversation.workbench.open_link": "打开链接",
    "conversation.workbench.remove_link_preview": "移除链接预览",
    "conversation.continue_in_new_task": "在新任务中继续",
    "conversation.assistant_status.stopped": "已停止",
    "conversation.assistant_status.stopped_after": "你在 {{duration}} 后停止了",
    "conversation.assistant_error.details": "错误详情",
    "conversation.assistant_error.actions.switch_model_retry": "切换模型并重试",
    "conversation.assistant_error.actions.retry": "重试",
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
    "conversation.assistant_error.types.model_service_connection_error.description_with_endpoint":
      "连接错误：向 {{endpoint}} 发送请求失败。请检查网络或 VPN 连接后重试。",
    "conversation.assistant_error.types.network_error.title":
      "网络连接失败：请检查网络连接后重试",
    "conversation.assistant_error.types.network_error.description":
      "当前连接中断或服务暂时不可达，请稍后重试。",
    "conversation.assistant_error.types.timeout_error.title":
      "请求超时：服务响应时间过长，请稍后重试",
    "conversation.assistant_error.types.timeout_error.description":
      "服务暂时没有及时响应，可以稍后重新发送。",
    "conversation.assistant_error.types.llm_error.title":
      "模型调用失败：模型暂时不可用，请稍后重试",
    "conversation.assistant_error.types.llm_error.description":
      "模型服务当前不可用，可以稍后重试或切换模型。",
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
    "conversation.assistant_error.types.generic_error.title": "消息生成失败",
    "conversation.assistant_error.types.generic_error.description":
      "请求未能完成。你可以稍后重试，或查看错误详情。",
    "conversation.assistant_error.types.generic_error.description_without_details":
      "请求未能完成。你可以稍后重试。",
    "conversation.message_actions.copy": "复制",
    "conversation.message_actions.copied": "已复制",
    "conversation.message_actions.copy_message": "复制消息",
    "conversation.message_actions.edit": "编辑",
    "conversation.message_actions.edit_message": "编辑消息",
    "conversation.processing_complete": "已处理",
    "conversation.assistant_status.working": "处理中",
    "conversation.assistant_status.working_for": "已处理 {{duration}}",
    "conversation.assistant_status.worked_for": "用时 {{duration}}",
    "conversation.message_time.month_day": "{{month}}月{{day}}日",
    "conversation.message_time.year_date": "{{year}}年{{date}} {{time}}",
    "conversation.message_time.weekday_0": "星期日",
    "conversation.message_time.weekday_1": "星期一",
    "conversation.message_time.weekday_2": "星期二",
    "conversation.message_time.weekday_3": "星期三",
    "conversation.message_time.weekday_4": "星期四",
    "conversation.message_time.weekday_5": "星期五",
    "conversation.message_time.weekday_6": "星期六",
    "conversation.workbench.im_source_label": "即时通讯",
    "conversation.workbench.im_channel_dingtalk": "钉钉",
    "conversation.workbench.im_channel_telegram": "Telegram",
    "conversation.workbench.im_channel_discord": "Discord",
    "conversation.workbench.code_comment_selected_text": "选中内容",
    "conversation.workbench.browser_annotation_adjustment_text": "文本",
    "conversation.workbench.browser_annotation_adjustment_color": "文本颜色",
    "conversation.workbench.browser_annotation_adjustment_background-color":
      "背景颜色",
    "conversation.workbench.browser_annotation_adjustment_opacity": "透明度",
    "conversation.workbench.browser_annotation_adjustment_font-family": "字体",
    "conversation.workbench.browser_annotation_adjustment_font-size": "字号",
    "conversation.workbench.browser_annotation_adjustment_font-weight": "字重",
    "conversation.workbench.browser_annotation_adjustment_width": "宽度",
    "conversation.workbench.browser_annotation_adjustment_height": "高度",
    "conversation.workbench.browser_annotation_adjustment_padding": "内边距",
    "conversation.workbench.browser_annotation_adjustment_margin": "外边距",
    "conversation.workbench.browser_annotation_adjustment_border-radius":
      "圆角",
    "conversation.workbench.browser_annotation_adjustment_border-color":
      "边框颜色",
    "conversation.workbench.browser_annotation_adjustment_border-width":
      "边框宽度",
    "conversation.workbench.browser_annotation_more_adjustments":
      "另有 {{count}} 项调整",
    "conversation.codex_references.kind": "文档",
    "conversation.codex_references.kind_with_extension": "文档 · {{extension}}",
    "conversation.codex_references.open_label": "打开 {{path}}",
    "conversation.codex_references.open_with": "打开方式",
    "conversation.codex_references.preview_label": "打开预览",
    "conversation.codex_references.show_less": "收起文件",
    "conversation.codex_references.show_more": "显示另外 {{count}} 个",
    "conversation.codex_references.title": "引用文件",
    "conversation.file_changes.artifact_missing": "变更文件已不存在",
    "conversation.file_changes.binary_file": "二进制文件",
    "conversation.file_changes.cancel": "取消",
    "conversation.file_changes.close": "关闭",
    "conversation.file_changes.confirm_revert": "确认撤销",
    "conversation.file_changes.confirm_revert_description":
      "仅当反向补丁可安全应用时才会修改工作区，不会覆盖后续变更。",
    "conversation.file_changes.confirm_revert_title": "撤销本轮文件变更？",
    "conversation.file_changes.conflicted": "存在后续冲突，未修改工作区",
    "conversation.file_changes.created_file": "已创建 {{filename}}",
    "conversation.file_changes.deleted_file": "已删除 {{filename}}",
    "conversation.file_changes.device_offline": "设备离线，无法审核或撤销",
    "conversation.file_changes.edited_file": "已编辑 {{filename}}",
    "conversation.file_changes.edited_files": "已编辑 {{count}} 个文件",
    "conversation.file_changes.preview_file_label": "预览 {{path}} 的文件变更",
    "conversation.file_changes.previous_turn_label": "上轮对话",
    "conversation.file_changes.renamed_file": "已重命名 {{filename}}",
    "conversation.file_changes.revert": "撤销",
    "conversation.file_changes.revert_failed": "撤销文件变更失败",
    "conversation.file_changes.reverted": "已撤销",
    "conversation.file_changes.reverting": "撤销中",
    "conversation.file_changes.review": "审核",
    "conversation.file_changes.show_less": "收起文件",
    "conversation.file_changes.show_more": "再显示 {{count}} 个文件",
    "conversation.file_changes.view_changes": "查看更改",
    "conversation.memory_citations.line_label": "{{range}} 行",
    "conversation.memory_citations.open_label": "打开 {{path}}",
    "conversation.memory_citations.summary": "{{count}} 条记忆引用",
    "conversation.message_navigation.gap_missing": "部分记录未加载",
    "conversation.message_navigation.jump_to_message":
      "跳转到第 {{index}} 条发言",
    "conversation.message_navigation.label": "历史发言导航",
    "conversation.message_navigation.loading_gap": "正在加载缺失记录...",
    "conversation.message_navigation.loading_target": "正在加载目标位置...",
    "conversation.plan_card.close": "关闭计划",
    "conversation.plan_card.copy": "复制计划",
    "conversation.plan_card.copy_success": "已复制",
    "conversation.plan_card.download": "下载计划",
    "conversation.plan_card.expand": "全屏查看计划",
    "conversation.plan_card.generating": "正在生成",
    "conversation.plan_card.title": "计划",
    "conversation.process_text.running": "正在处理",
    "conversation.request_user_input.approval_allow_execpolicy":
      "允许此命令规则",
    "conversation.request_user_input.approval_allow_execpolicy_description":
      "以后不再询问符合此规则的命令：{{detail}}",
    "conversation.request_user_input.approval_allow_network_host":
      "始终允许 {{host}}",
    "conversation.request_user_input.approval_allow_network_host_description":
      "添加一条持久网络规则，允许访问 {{host}}。",
    "conversation.request_user_input.approval_allow_once": "仅允许一次",
    "conversation.request_user_input.approval_allow_once_description":
      "仅批准本次请求。",
    "conversation.request_user_input.approval_allow_session": "本会话允许",
    "conversation.request_user_input.approval_allow_session_description":
      "在本次会话剩余时间内批准同类访问。",
    "conversation.request_user_input.approval_allow_turn_strict_review":
      "允许并严格审查",
    "conversation.request_user_input.approval_allow_turn_strict_review_description":
      "在当前轮次授予这些权限，并逐一审查后续每条命令。",
    "conversation.request_user_input.approval_cancel": "停止",
    "conversation.request_user_input.approval_cancel_description":
      "拒绝本次请求，并停止当前执行。",
    "conversation.request_user_input.approval_command":
      "是否允许运行此命令？\n{{detail}}",
    "conversation.request_user_input.approval_decline": "拒绝",
    "conversation.request_user_input.approval_decline_description":
      "拒绝本次请求，并让 Codex 继续。",
    "conversation.request_user_input.approval_deny_network_host":
      "始终拒绝 {{host}}",
    "conversation.request_user_input.approval_deny_network_host_description":
      "添加一条持久网络规则，拒绝访问 {{host}}。",
    "conversation.request_user_input.approval_file_change":
      "是否允许此文件变更？\n{{detail}}",
    "conversation.request_user_input.approval_no_detail":
      "Codex 请求访问当前权限边界之外的资源。",
    "conversation.request_user_input.approval_permissions":
      "是否授予请求的权限？\n{{detail}}",
    "conversation.request_user_input.approval_title": "需要审批",
    "conversation.request_user_input.asked_count": "已询问 {{count}} 个问题",
    "conversation.request_user_input.custom_placeholder": "输入你的回答",
    "conversation.request_user_input.ignore": "取消",
    "conversation.request_user_input.submit": "提交",
    "conversation.subagent.active_count": "进行中 · {{count}}",
    "conversation.subagent.activity": "子代理活动",
    "conversation.subagent.agent": "子代理",
    "conversation.subagent.back": "返回主对话",
    "conversation.subagent.back_to_list": "返回子代理列表",
    "conversation.subagent.done_count": "已完成 · {{count}}",
    "conversation.subagent.group_failed": "执行失败",
    "conversation.subagent.group_finished": "已完成",
    "conversation.subagent.group_interrupted": "已中断",
    "conversation.subagent.group_started": "开始工作",
    "conversation.subagent.group_updated": "有新进展",
    "conversation.subagent.history_load_failed": "加载子代理历史消息失败",
    "conversation.subagent.loading_history": "正在加载子代理历史消息…",
    "conversation.subagent.no_active": "没有正在运行的子代理",
    "conversation.subagent.no_output": "此子代理没有可显示的消息",
    "conversation.subagent.open_agent": "打开 {{name}} 子代理",
    "conversation.subagent.open_panel": "打开子代理（{{count}}）",
    "conversation.subagent.others": "及其他 {{count}} 个子代理",
    "conversation.subagent.status_done": "已完成",
    "conversation.subagent.status_failed": "失败",
    "conversation.subagent.status_interrupted": "已中断",
    "conversation.subagent.status_summary": "{{agents}}，{{status}}",
    "conversation.subagent.status_working": "工作中",
    "conversation.subagent.summary_active": "{{count}} 工作中",
    "conversation.subagent.summary_done": "{{count}} 已完成",
    "conversation.subagent.summary_mixed":
      "{{active}} 工作中 · {{done}} 已完成",
    "conversation.subagent.waiting_for_output": "子代理正在工作…",
    "conversation.subagent.working": "正在工作",
    "conversation.thinking.running": "正在思考",
    "conversation.tool_activity.call_done": "调用 {{name}}",
    "conversation.tool_activity.call_error": "调用 {{name}} 失败",
    "conversation.tool_activity.call_running": "调用 {{name}}",
    "conversation.tool_activity.chatgpt_network_unavailable":
      "当前正在使用 ChatGPT 模型，网络连接不可用。是否设置代理？",
    "conversation.tool_activity.command": "命令",
    "conversation.tool_activity.command_action": "运行命令",
    "conversation.tool_activity.create_action": "创建文件",
    "conversation.tool_activity.created_file": "创建 {{filename}}",
    "conversation.tool_activity.deleted_file": "删除 {{filename}}",
    "conversation.tool_activity.edit": "编辑",
    "conversation.tool_activity.edit_action": "编辑文件",
    "conversation.tool_activity.edit_summary_other": "编辑 {{count}} 个文件",
    "conversation.tool_activity.edited_file": "编辑 {{filename}}",
    "conversation.tool_activity.file": "读取",
    "conversation.tool_activity.file_action": "读取文件",
    "conversation.tool_activity.file_count": "{{count}} 个文件",
    "conversation.tool_activity.file_done": "读取 {{name}}",
    "conversation.tool_activity.file_fallback": "文件",
    "conversation.tool_activity.image_generation_alt": "生成的图片",
    "conversation.tool_activity.image_generation_done": "图片已生成",
    "conversation.tool_activity.image_generation_error": "图片生成失败",
    "conversation.tool_activity.image_generation_running": "正在生成图片",
    "conversation.tool_activity.image_preview_alt": "工具查看的图片",
    "conversation.tool_activity.image_view": "查看 {{filename}}",
    "conversation.tool_activity.image_view_fallback": "查看图片",
    "conversation.tool_activity.javascript_done": "运行 JavaScript",
    "conversation.tool_activity.javascript_error": "运行 JavaScript 失败",
    "conversation.tool_activity.javascript_running": "正在运行 JavaScript",
    "conversation.tool_activity.mixed_summary_other":
      "{{toolSummary}}，编辑 {{count}} 个文件",
    "conversation.tool_activity.open_proxy_settings": "设置代理",
    "conversation.tool_activity.other": "其他工具",
    "conversation.tool_activity.other_action": "调用工具",
    "conversation.tool_activity.reconnecting": "连接中断，正在重连…",
    "conversation.tool_activity.renamed_file": "重命名 {{filename}}",
    "conversation.tool_activity.search": "搜索",
    "conversation.tool_activity.search_action": "搜索代码",
    "conversation.tool_activity.search_done": "搜索代码",
    "conversation.tool_activity.search_error": "搜索代码失败",
    "conversation.tool_activity.search_running": "正在搜索代码",
    "conversation.tool_activity.sources": "来源",
    "conversation.tool_activity.summary_other": "调用 {{count}} 个工具",
    "conversation.tool_activity.tool_input": "输入",
    "conversation.tool_activity.tool_no_output": "工具未返回内容",
    "conversation.tool_activity.tool_output": "输出",
    "conversation.tool_activity.wait_done": "等待工具结果",
    "conversation.tool_activity.wait_error": "等待工具结果失败",
    "conversation.tool_activity.wait_running": "等待工具结果",
    "conversation.workbench.add_selection_to_conversation": "添加到对话",
    "conversation.workbench.ask_selection_in_sidebar": "在侧边栏中提问",
    "conversation.file_changes.editing_files": "正在编辑 {{count}} 个文件",
    "conversation.file_changes.creating_files": "正在创建 {{count}} 个文件",
    "conversation.file_changes.deleting_files": "正在删除 {{count}} 个文件",
    "conversation.file_changes.renaming_files": "正在重命名 {{count}} 个文件",
    "conversation.file_changes.editing_file": "正在编辑 {{filename}}",
    "conversation.file_changes.creating_file": "正在创建 {{filename}}",
    "conversation.file_changes.deleting_file": "正在删除 {{filename}}",
    "conversation.file_changes.renaming_file": "正在重命名 {{filename}}",
    "conversation.file_changes.created_files": "已创建 {{count}} 个文件",
    "conversation.file_changes.deleted_files": "已删除 {{count}} 个文件",
    "conversation.file_changes.renamed_files": "已重命名 {{count}} 个文件",
    "conversation.file_changes.review_title": "本轮文件变更",
    "conversation.file_changes.copy_code": "复制代码",
    "conversation.file_changes.confirm_partial_revert_description":
      "确定撤销选中的变更吗？仅当反向补丁可安全应用时才会修改工作区。",
    "conversation.file_changes.applying": "处理中",
    "conversation.file_changes.comment_placeholder": "说明这里需要如何修改",
    "conversation.file_changes.add_comment": "添加评论",
    "conversation.file_changes.loading_diff": "正在从设备加载变更...",
    "conversation.file_changes.empty_diff": "没有可展示的文本变更",
    "conversation.file_changes.changes_label": "变更",
    "conversation.file_changes.unstaged_label": "未暂存",
    "conversation.file_changes.staged_label": "已暂存",
    "conversation.file_changes.commit_label": "提交",
    "conversation.file_changes.branch_label": "分支",
    "conversation.file_changes.branch_unknown": "当前工作区",
    "conversation.file_changes.large_diff_single_file_notice":
      "此差异较大，每次仅显示一个文件",
    "conversation.file_changes.file_list_label": "变更文件",
    "conversation.file_changes.file_search_placeholder": "筛选文件...",
    "conversation.file_changes.file_search_empty": "没有匹配的文件",
    "conversation.file_changes.all_files_diff_label": "全部文件变更",
    "conversation.file_changes.review_failed": "加载文件变更失败",
  },
  en: {
    "conversation.workbench.scroll_to_bottom": "Scroll to bottom",
    "conversation.workbench.loading_conversation": "Loading conversation...",
    "conversation.workbench.empty_conversation_title":
      "Start a new conversation",
    "conversation.workbench.empty_conversation_description":
      "Ask a question, paste context, or add attachments below. WeWork responses will appear here.",
    "conversation.workbench.loading_older_messages": "Loading...",
    "conversation.workbench.load_older_messages": "Load older messages",
    "conversation.workbench.code_comment_count": "{{count}} comments",
    "conversation.workbench.goal_chip": "Goal",
    "conversation.user_message.collapse": "Collapse",
    "conversation.user_message.expand": "Expand",
    "conversation.message_edit.cancel": "Cancel",
    "conversation.message_edit.send": "Send",
    "conversation.common.confirm": "Confirm",
    "conversation.workbench.browser_invalid_url":
      "Enter a valid http or https URL",
    "conversation.workbench.edit_link_text": "Edit text",
    "conversation.workbench.edit_link_url": "Edit link",
    "conversation.workbench.open_link": "Open link",
    "conversation.workbench.remove_link_preview": "Remove link preview",
    "conversation.continue_in_new_task": "Continue in new task",
    "conversation.assistant_status.stopped": "Stopped",
    "conversation.assistant_status.stopped_after":
      "You stopped after {{duration}}",
    "conversation.assistant_error.details": "Error details",
    "conversation.assistant_error.actions.switch_model_retry":
      "Switch model and retry",
    "conversation.assistant_error.actions.retry": "Retry",
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
    "conversation.assistant_error.types.model_service_connection_error.description_with_endpoint":
      "Connection error: The request could not be sent to {{endpoint}}. Check your network or VPN connection and retry.",
    "conversation.assistant_error.types.network_error.title":
      "Network error: Please check your connection and try again",
    "conversation.assistant_error.types.network_error.description":
      "The connection was interrupted or the service is temporarily unreachable.",
    "conversation.assistant_error.types.timeout_error.title":
      "Request timeout: Service response time exceeded",
    "conversation.assistant_error.types.timeout_error.description":
      "The service did not respond in time. Try sending the message again later.",
    "conversation.assistant_error.types.llm_error.title":
      "Model error: The model is temporarily unavailable",
    "conversation.assistant_error.types.llm_error.description":
      "The model service is unavailable. Try again later or switch models.",
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
    "conversation.assistant_error.types.generic_error.title":
      "Message generation failed",
    "conversation.assistant_error.types.generic_error.description":
      "The request could not be completed. Try again later, or view the error details.",
    "conversation.assistant_error.types.generic_error.description_without_details":
      "The request could not be completed. Try again later.",
    "conversation.message_actions.copy": "Copy",
    "conversation.message_actions.copied": "Copied",
    "conversation.message_actions.copy_message": "Copy message",
    "conversation.message_actions.edit": "Edit",
    "conversation.message_actions.edit_message": "Edit message",
    "conversation.processing_complete": "Processed",
    "conversation.assistant_status.working": "Working",
    "conversation.assistant_status.working_for": "Working for {{duration}}",
    "conversation.assistant_status.worked_for": "Worked for {{duration}}",
    "conversation.message_time.month_day": "{{month}}/{{day}}",
    "conversation.message_time.year_date": "{{date}}/{{year}} {{time}}",
    "conversation.message_time.weekday_0": "Sun ",
    "conversation.message_time.weekday_1": "Mon ",
    "conversation.message_time.weekday_2": "Tue ",
    "conversation.message_time.weekday_3": "Wed ",
    "conversation.message_time.weekday_4": "Thu ",
    "conversation.message_time.weekday_5": "Fri ",
    "conversation.message_time.weekday_6": "Sat ",
    "conversation.workbench.im_source_label": "IM",
    "conversation.workbench.im_channel_dingtalk": "DingTalk",
    "conversation.workbench.im_channel_telegram": "Telegram",
    "conversation.workbench.im_channel_discord": "Discord",
    "conversation.workbench.code_comment_selected_text": "Selection",
    "conversation.workbench.browser_annotation_adjustment_text": "Text",
    "conversation.workbench.browser_annotation_adjustment_color": "Text color",
    "conversation.workbench.browser_annotation_adjustment_background-color":
      "Background color",
    "conversation.workbench.browser_annotation_adjustment_opacity": "Opacity",
    "conversation.workbench.browser_annotation_adjustment_font-family":
      "Font family",
    "conversation.workbench.browser_annotation_adjustment_font-size":
      "Font size",
    "conversation.workbench.browser_annotation_adjustment_font-weight":
      "Font weight",
    "conversation.workbench.browser_annotation_adjustment_width": "Width",
    "conversation.workbench.browser_annotation_adjustment_height": "Height",
    "conversation.workbench.browser_annotation_adjustment_padding": "Padding",
    "conversation.workbench.browser_annotation_adjustment_margin": "Margin",
    "conversation.workbench.browser_annotation_adjustment_border-radius":
      "Corner radius",
    "conversation.workbench.browser_annotation_adjustment_border-color":
      "Border color",
    "conversation.workbench.browser_annotation_adjustment_border-width":
      "Border width",
    "conversation.workbench.browser_annotation_more_adjustments":
      "{{count}} more adjustments",
    "conversation.codex_references.kind": "Document",
    "conversation.codex_references.kind_with_extension":
      "Document · {{extension}}",
    "conversation.codex_references.open_label": "Open {{path}}",
    "conversation.codex_references.open_with": "Open with",
    "conversation.codex_references.preview_label": "Open preview",
    "conversation.codex_references.show_less": "Collapse files",
    "conversation.codex_references.show_more": "Show {{count}} more",
    "conversation.codex_references.title": "Referenced files",
    "conversation.file_changes.artifact_missing":
      "The change artifact is no longer available",
    "conversation.file_changes.binary_file": "Binary file",
    "conversation.file_changes.cancel": "Cancel",
    "conversation.file_changes.close": "Close",
    "conversation.file_changes.confirm_revert": "Confirm revert",
    "conversation.file_changes.confirm_revert_description":
      "The workspace changes only when the reverse patch applies safely. Later changes are never overwritten.",
    "conversation.file_changes.confirm_revert_title":
      "Revert this turn's file changes?",
    "conversation.file_changes.conflicted":
      "Later changes conflict, so the workspace was not modified",
    "conversation.file_changes.created_file": "Created {{filename}}",
    "conversation.file_changes.deleted_file": "Deleted {{filename}}",
    "conversation.file_changes.device_offline":
      "The device is offline. Review and revert are unavailable.",
    "conversation.file_changes.edited_file": "Edited {{filename}}",
    "conversation.file_changes.edited_files": "Edited {{count}} files",
    "conversation.file_changes.preview_file_label":
      "Preview file changes for {{path}}",
    "conversation.file_changes.previous_turn_label": "Previous turn",
    "conversation.file_changes.renamed_file": "Renamed {{filename}}",
    "conversation.file_changes.revert": "Revert",
    "conversation.file_changes.revert_failed": "Failed to revert file changes",
    "conversation.file_changes.reverted": "Reverted",
    "conversation.file_changes.reverting": "Reverting",
    "conversation.file_changes.review": "Review",
    "conversation.file_changes.show_less": "Collapse files",
    "conversation.file_changes.show_more": "Show {{count}} more files",
    "conversation.file_changes.view_changes": "View changes",
    "conversation.memory_citations.line_label": "lines {{range}}",
    "conversation.memory_citations.open_label": "Open {{path}}",
    "conversation.memory_citations.summary": "{{count}} memory citations",
    "conversation.message_navigation.gap_missing": "Some history is not loaded",
    "conversation.message_navigation.jump_to_message":
      "Jump to message {{index}}",
    "conversation.message_navigation.label": "Previous message navigation",
    "conversation.message_navigation.loading_gap": "Loading missing history...",
    "conversation.message_navigation.loading_target":
      "Loading target position...",
    "conversation.plan_card.close": "Close plan",
    "conversation.plan_card.copy": "Copy plan",
    "conversation.plan_card.copy_success": "Copied",
    "conversation.plan_card.download": "Download plan",
    "conversation.plan_card.expand": "Open plan full screen",
    "conversation.plan_card.generating": "Generating",
    "conversation.plan_card.title": "Plan",
    "conversation.process_text.running": "Working",
    "conversation.request_user_input.approval_allow_execpolicy":
      "Allow this command rule",
    "conversation.request_user_input.approval_allow_execpolicy_description":
      "Allow commands matching this rule without asking again: {{detail}}",
    "conversation.request_user_input.approval_allow_network_host":
      "Always allow {{host}}",
    "conversation.request_user_input.approval_allow_network_host_description":
      "Add a persistent network rule allowing access to {{host}}.",
    "conversation.request_user_input.approval_allow_once": "Allow once",
    "conversation.request_user_input.approval_allow_once_description":
      "Approve only this request.",
    "conversation.request_user_input.approval_allow_session":
      "Allow for session",
    "conversation.request_user_input.approval_allow_session_description":
      "Approve similar access for the rest of this session.",
    "conversation.request_user_input.approval_allow_turn_strict_review":
      "Allow with strict review",
    "conversation.request_user_input.approval_allow_turn_strict_review_description":
      "Grant these permissions for this turn and review every following command.",
    "conversation.request_user_input.approval_cancel": "Stop",
    "conversation.request_user_input.approval_cancel_description":
      "Deny this request and stop the current turn.",
    "conversation.request_user_input.approval_command":
      "Allow this command?\n{{detail}}",
    "conversation.request_user_input.approval_decline": "Deny",
    "conversation.request_user_input.approval_decline_description":
      "Deny this request and let Codex continue.",
    "conversation.request_user_input.approval_deny_network_host":
      "Always deny {{host}}",
    "conversation.request_user_input.approval_deny_network_host_description":
      "Add a persistent network rule denying access to {{host}}.",
    "conversation.request_user_input.approval_file_change":
      "Allow this file change?\n{{detail}}",
    "conversation.request_user_input.approval_no_detail":
      "Codex requested access outside the current permission boundary.",
    "conversation.request_user_input.approval_permissions":
      "Grant the requested permissions?\n{{detail}}",
    "conversation.request_user_input.approval_title": "Approval required",
    "conversation.request_user_input.asked_count":
      "Asked {{count}} question(s)",
    "conversation.request_user_input.custom_placeholder": "Type your answer",
    "conversation.request_user_input.ignore": "Cancel",
    "conversation.request_user_input.submit": "Submit",
    "conversation.subagent.active_count": "Active · {{count}}",
    "conversation.subagent.activity": "Subagent activity",
    "conversation.subagent.agent": "Subagent",
    "conversation.subagent.back": "Back to main conversation",
    "conversation.subagent.back_to_list": "Back to subagents",
    "conversation.subagent.done_count": "Done · {{count}}",
    "conversation.subagent.group_failed": "failed",
    "conversation.subagent.group_finished": "finished",
    "conversation.subagent.group_interrupted": "interrupted",
    "conversation.subagent.group_started": "started working",
    "conversation.subagent.group_updated": "updated",
    "conversation.subagent.history_load_failed":
      "Failed to load subagent history",
    "conversation.subagent.loading_history": "Loading subagent history…",
    "conversation.subagent.no_active": "No active subagents",
    "conversation.subagent.no_output":
      "This subagent has no messages to display",
    "conversation.subagent.open_agent": "Open {{name}} subagent",
    "conversation.subagent.open_panel": "Open subagents ({{count}})",
    "conversation.subagent.others_one": "and {{count}} other subagent",
    "conversation.subagent.others_other": "and {{count}} other subagents",
    "conversation.subagent.status_done": "Done",
    "conversation.subagent.status_failed": "Failed",
    "conversation.subagent.status_interrupted": "Interrupted",
    "conversation.subagent.status_summary": "{{agents}}, {{status}}",
    "conversation.subagent.status_working": "Working",
    "conversation.subagent.summary_active": "{{count}} working",
    "conversation.subagent.summary_done": "{{count}} done",
    "conversation.subagent.summary_mixed": "{{active}} working · {{done}} done",
    "conversation.subagent.waiting_for_output": "The subagent is working…",
    "conversation.subagent.working": "Working",
    "conversation.thinking.running": "Thinking",
    "conversation.tool_activity.call_done": "Called {{name}}",
    "conversation.tool_activity.call_error": "Failed to call {{name}}",
    "conversation.tool_activity.call_running": "Call {{name}}",
    "conversation.tool_activity.chatgpt_network_unavailable":
      "The current model uses ChatGPT, but the network is unavailable. Would you like to configure a proxy?",
    "conversation.tool_activity.command": "Commands",
    "conversation.tool_activity.command_action": "Run command",
    "conversation.tool_activity.create_action": "Create file",
    "conversation.tool_activity.created_file": "Created {{filename}}",
    "conversation.tool_activity.deleted_file": "Deleted {{filename}}",
    "conversation.tool_activity.edit": "Edits",
    "conversation.tool_activity.edit_action": "Edit file",
    "conversation.tool_activity.edit_summary_one": "Edited {{count}} file",
    "conversation.tool_activity.edit_summary_other": "Edited {{count}} files",
    "conversation.tool_activity.edited_file": "Edited {{filename}}",
    "conversation.tool_activity.file": "Reads",
    "conversation.tool_activity.file_action": "Read file",
    "conversation.tool_activity.file_count": "{{count}} files",
    "conversation.tool_activity.file_done": "Read {{name}}",
    "conversation.tool_activity.file_fallback": "file",
    "conversation.tool_activity.image_generation_alt": "Generated image",
    "conversation.tool_activity.image_generation_done": "Image generated",
    "conversation.tool_activity.image_generation_error":
      "Image generation failed",
    "conversation.tool_activity.image_generation_running": "Generating image",
    "conversation.tool_activity.image_preview_alt": "Image viewed by the tool",
    "conversation.tool_activity.image_view": "View {{filename}}",
    "conversation.tool_activity.image_view_fallback": "View image",
    "conversation.tool_activity.javascript_done": "Ran JavaScript",
    "conversation.tool_activity.javascript_error": "JavaScript failed",
    "conversation.tool_activity.javascript_running": "Running JavaScript",
    "conversation.tool_activity.mixed_summary_one":
      "{{toolSummary}}, edited {{count}} file",
    "conversation.tool_activity.mixed_summary_other":
      "{{toolSummary}}, edited {{count}} files",
    "conversation.tool_activity.open_proxy_settings": "Configure proxy",
    "conversation.tool_activity.other": "Other tools",
    "conversation.tool_activity.other_action": "Call tool",
    "conversation.tool_activity.reconnecting":
      "Connection interrupted. Reconnecting…",
    "conversation.tool_activity.renamed_file": "Renamed {{filename}}",
    "conversation.tool_activity.search": "Searches",
    "conversation.tool_activity.search_action": "Search code",
    "conversation.tool_activity.search_done": "Searched code",
    "conversation.tool_activity.search_error": "Failed to search code",
    "conversation.tool_activity.search_running": "Searching code",
    "conversation.tool_activity.sources": "Sources",
    "conversation.tool_activity.summary_one": "Called {{count}} tool",
    "conversation.tool_activity.summary_other": "Called {{count}} tools",
    "conversation.tool_activity.tool_input": "Input",
    "conversation.tool_activity.tool_no_output": "Tool returned no content",
    "conversation.tool_activity.tool_output": "Output",
    "conversation.tool_activity.wait_done": "Waited for tool result",
    "conversation.tool_activity.wait_error": "Failed waiting for tool result",
    "conversation.tool_activity.wait_running": "Wait for tool result",
    "conversation.workbench.add_selection_to_conversation":
      "Add to conversation",
    "conversation.workbench.ask_selection_in_sidebar": "Ask in sidebar",
    "conversation.file_changes.editing_files": "Editing {{count}} files",
    "conversation.file_changes.creating_files": "Creating {{count}} files",
    "conversation.file_changes.deleting_files": "Deleting {{count}} files",
    "conversation.file_changes.renaming_files": "Renaming {{count}} files",
    "conversation.file_changes.editing_file": "Editing {{filename}}",
    "conversation.file_changes.creating_file": "Creating {{filename}}",
    "conversation.file_changes.deleting_file": "Deleting {{filename}}",
    "conversation.file_changes.renaming_file": "Renaming {{filename}}",
    "conversation.file_changes.created_files": "Created {{count}} files",
    "conversation.file_changes.deleted_files": "Deleted {{count}} files",
    "conversation.file_changes.renamed_files": "Renamed {{count}} files",
    "conversation.file_changes.review_title": "Changes from this turn",
    "conversation.file_changes.copy_code": "Copy code",
    "conversation.file_changes.confirm_partial_revert_description":
      "Revert the selected changes? The workspace changes only when the reverse patch applies safely.",
    "conversation.file_changes.applying": "Applying",
    "conversation.file_changes.comment_placeholder":
      "Describe what should change here",
    "conversation.file_changes.add_comment": "Add comment",
    "conversation.file_changes.loading_diff":
      "Loading changes from the device...",
    "conversation.file_changes.empty_diff": "No text changes to display",
    "conversation.file_changes.changes_label": "Changes",
    "conversation.file_changes.unstaged_label": "Unstaged",
    "conversation.file_changes.staged_label": "Staged",
    "conversation.file_changes.commit_label": "Commit",
    "conversation.file_changes.branch_label": "Branch",
    "conversation.file_changes.branch_unknown": "Current workspace",
    "conversation.file_changes.large_diff_single_file_notice":
      "This diff is large, so only one file is shown at a time",
    "conversation.file_changes.file_list_label": "Changed files",
    "conversation.file_changes.file_search_placeholder": "Filter files...",
    "conversation.file_changes.file_search_empty": "No matching files",
    "conversation.file_changes.all_files_diff_label": "All file diffs",
    "conversation.file_changes.review_failed": "Failed to load file changes",
  },
};
