
INSERT INTO `agents` (`id`, `name`, `config`, `created_at`, `updated_at`)
VALUES
	('1', 'ClaudeCode', '{\"mode_filter\": [\"claude\"]}', '2025-09-23 10:20:24', '2025-09-23 02:47:27'),
	('2', 'Agno', '{\"mode_filter\": []}', '2025-09-23 10:21:24', '2025-09-23 02:45:53');

INSERT INTO `models` (`id`, `name`, `config`, `is_active`, `created_at`, `updated_at`)
VALUES
	('1', 'wecode-china-auto', '{\"env\": {\"model\": \"openai\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"ali-deepseek-v3.1\"}}', '1', '2025-10-11 15:26:13', '2025-10-11 15:26:13'),
	('2', 'wecode-global-auto', '{\"env\": {\"model\": \"openai\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"wecode-gpt-4.1\"}}', '1', '2025-10-11 15:26:13', '2025-10-11 15:26:13'),
	('3', 'sina-qwen3-coder', '{\"env\": {\"model\": \"openai\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"sina-qwen3-coder\"}}', '1', '2025-10-11 15:26:13', '2025-10-11 15:26:13'),
	('4', 'sina-glm-4.5', '{\"env\": {\"model\": \"openai\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"sina-glm-4.5\"}}', '1', '2025-10-11 15:26:14', '2025-10-11 15:26:14'),
	('5', 'openai-o3', '{\"env\": {\"model\": \"openai\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"o3\"}}', '1', '2025-10-11 15:26:14', '2025-10-11 15:26:14'),
	-- ('6', 'ali-kimi-k2', '{\"env\": {\"model\": \"openai\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"ali-kimi-k2\"}}', '1', '2025-10-11 15:26:14', '2025-10-11 15:26:14'),
	('7', 'ali-qwen3-coder-plus', '{\"env\": {\"model\": \"openai\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"ali-qwen3-coder-plus\"}}', '1', '2025-10-11 15:26:14', '2025-10-11 15:26:14'),
	('8', 'wecode-claude3.7', '{\"env\": {\"model\": \"claude\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"wecode-claude3.7\"}}', '1', '2025-10-11 15:26:14', '2025-10-11 15:26:14'),
	('9', 'wecode-claude-sonnet-4', '{\"env\": {\"model\": \"claude\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"wecode-claude-sonnet-4\"}}', '1', '2025-10-11 15:26:14', '2025-10-11 15:26:14'),
	('10', 'wecode-claude-opus-4.1', '{\"env\": {\"model\": \"claude\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"wecode-claude-opus-4.1\"}}', '1', '2025-10-11 15:26:14', '2025-10-11 15:26:14'),
	('11', 'huoshan-deepseek-v3', '{\"env\": {\"model\": \"openai\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"deepseek-chat\"}}', '1', '2025-10-11 15:26:14', '2025-10-11 15:26:14'),
	('12', 'ali-deepseek-v3.1', '{\"env\": {\"model\": \"openai\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"ali-deepseek-v3.1\"}}', '1', '2025-10-11 15:26:14', '2025-10-11 15:26:14'),
	('13', 'wecode-gemini-2.5', '{\"env\": {\"model\": \"openai\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"wecode-gemini-2.5\"}}', '1', '2025-10-11 15:26:14', '2025-10-11 15:26:14'),
	('14', 'wecode-gpt-4.1', '{\"env\": {\"model\": \"openai\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"wecode-gpt-4.1\"}}', '1', '2025-10-11 15:26:14', '2025-10-11 15:26:14'),
	('15', 'wecode-gpt-4.1-mini', '{\"env\": {\"model\": \"openai\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"wecode-gpt-4.1-mini\"}}', '1', '2025-10-11 15:26:14', '2025-10-11 15:26:14'),
	('16', 'thudm-glm-4.5', '{\"env\": {\"model\": \"openai\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"thudm-glm-4.5\"}}', '1', '2025-10-11 15:26:14', '2025-10-11 15:26:14'),
	('17', 'openai-gpt-5', '{\"env\": {\"model\": \"openai\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"gpt-5-2025-08-07\"}}', '1', '2025-10-11 15:26:14', '2025-10-11 15:26:14'),
	('18', 'wecode-claude-sina-glm-4.5', '{\"env\": {\"model\": \"claude\", \"api_key\": \"sk-wecode-proxy-claude-code-sk\", \"base_url\": \"https://ccr-copilot.weibo.com\", \"model_id\": \"wecode,sina-glm-4.5\"}}', '1', '2025-10-11 15:26:14', '2025-10-11 15:26:14'),
	('19', 'claude-sonnet-4-20250514', '{\"env\": {\"model\": \"claude\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com\", \"model_id\": \"claude-sonnet-4-20250514\"}}', '1', '2025-10-11 15:26:14', '2025-10-11 15:26:14');