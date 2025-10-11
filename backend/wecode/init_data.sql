
INSERT INTO `agents` (`id`, `name`, `config`, `created_at`, `updated_at`)
VALUES
	('1', 'ClaudeCode', '{\"mode_filter\": [\"claude\"]}', '2025-09-23 10:20:24', '2025-09-23 02:47:27'),
	('2', 'Agno', '{\"mode_filter\": []}', '2025-09-23 10:21:24', '2025-09-23 02:45:53');

INSERT INTO `models` (`id`, `name`, `config`, `is_active`, `created_at`, `updated_at`)
VALUES
	('1', 'sina-glm-4.5(内网)', '{\"env\": {\"model\": \"openai\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"sina-glm-4.5\"}}', '1', '2025-10-11 18:05:16', '2025-10-11 18:05:16'),
	('2', 'wecode-claude-sina-glm-4.5(内网)', '{\"env\": {\"model\": \"claude\", \"api_key\": \"sk-wecode-proxy-claude-code-sk\", \"base_url\": \"https://ccr-copilot.weibo.com\", \"model_id\": \"wecode,sina-glm-4.5\"}}', '1', '2025-10-11 18:05:17', '2025-10-11 18:05:17'),
	('3', 'thudm-glm-4.5(国内)', '{\"env\": {\"model\": \"openai\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"thudm-glm-4.5\"}}', '1', '2025-10-11 18:05:17', '2025-10-11 18:05:17'),
	('4', 'ali-qwen3-coder-plus(国内)', '{\"env\": {\"model\": \"openai\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"ali-qwen3-coder-plus\"}}', '1', '2025-10-11 18:05:17', '2025-10-11 18:05:17'),
	('5', 'openai-o3(海外)', '{\"env\": {\"model\": \"openai\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"o3\"}}', '1', '2025-10-11 18:05:17', '2025-10-11 18:05:17'),
	('6', 'wecode-claude3.5(海外)', '{\"env\": {\"model\": \"claude\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com\", \"model_id\": \"claude-3-5-sonnet-20241022\"}}', '1', '2025-10-11 18:05:17', '2025-10-11 18:05:17'),
	('7', 'wecode-claude3.7(海外)', '{\"env\": {\"model\": \"claude\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com\", \"model_id\": \"claude-3-7-sonnet-20250219\"}}', '1', '2025-10-11 18:05:17', '2025-10-11 18:05:17'),
	('8', 'wecode-claude-sonnet-4(海外)', '{\"env\": {\"model\": \"claude\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com\", \"model_id\": \"claude-sonnet-4-20250514\"}}', '1', '2025-10-11 18:05:18', '2025-10-11 18:05:18'),
	('9', 'wecode-claude-opus-4.1(海外)', '{\"env\": {\"model\": \"claude\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com\", \"model_id\": \"claude-opus-4-1-20250805\"}}', '1', '2025-10-11 18:05:18', '2025-10-11 18:05:18'),
	('10', 'huoshan-deepseek-v3(海外)', '{\"env\": {\"model\": \"openai\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"deepseek-chat\"}}', '1', '2025-10-11 18:05:18', '2025-10-11 18:05:18'),
	('11', 'ali-deepseek-v3.1(国内)', '{\"env\": {\"model\": \"openai\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"ali-deepseek-v3.1\"}}', '1', '2025-10-11 18:05:18', '2025-10-11 18:05:18'),
	('12', 'wecode-gemini-2.5(海外)', '{\"env\": {\"model\": \"gemini\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com\", \"model_id\": \"gemini-2.5-pro-exp-03-25\"}}', '1', '2025-10-11 18:05:18', '2025-10-11 18:05:18'),
	('13', 'wecode-gpt-4.1(海外)', '{\"env\": {\"model\": \"openai\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"gpt-4.1\"}}', '1', '2025-10-11 18:05:18', '2025-10-11 18:05:18'),
	('14', 'wecode-gpt-4.1-mini(海外)', '{\"env\": {\"model\": \"openai\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"gpt-4.1-mini\"}}', '1', '2025-10-11 18:05:19', '2025-10-11 18:05:19'),
	('15', 'openai-gpt-5(海外)', '{\"env\": {\"model\": \"openai\", \"api_key\": \"${WECODE_USER_API_KEY}\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"gpt-5-2025-08-07\"}}', '1', '2025-10-11 18:05:19', '2025-10-11 18:05:19');
