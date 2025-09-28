
INSERT INTO `agents` (`id`, `name`, `config`, `created_at`, `updated_at`)
VALUES
	('1', 'ClaudeCode', '{\"mode_filter\": [\"claude\"]}', '2025-09-23 10:20:24', '2025-09-23 02:47:27'),
	('2', 'Agno', '{\"mode_filter\": []}', '2025-09-23 10:21:24', '2025-09-23 02:45:53');

INSERT INTO `models` (`id`, `name`, `config`, `is_active`, `created_at`, `updated_at`)
VALUES
	('1', 'wecode-gpt-4.1-mini', '{\"env\": {\"model\": \"openai\", \"api_key\": \"7a7edbdef9eab85c8x\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"gpt-4.1-mini\"}}', '1', '2025-09-23 10:26:27', '2025-09-23 10:26:27'),
	('2', 'wecode-claude-sonnet-4', '{\"env\": {\"model\": \"claude\", \"api_key\": \"sk-7a7edbdef9eab85c8x\", \"base_url\": \"https://copilot.weibo.com\", \"model_id\": \"wecode-claude-sonnet-4\"}}', '1', '2025-09-23 10:26:47', '2025-09-23 10:26:47'),
	('3', 'wecode-gpt-4.1', '{\"env\": {\"model\": \"openai\", \"api_key\": \"7a7edbdef9eab85c8x\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"wecode-gpt-4.1\"}}', '1', '2025-09-25 10:29:57', '2025-09-25 10:29:57'),
	('4', 'thudm-glm-4.5', '{\"env\": {\"model\": \"openai\", \"api_key\": \"7a7edbdef9eab85c8x\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"thudm-glm-4.5\"}}', '1', '2025-09-25 10:29:57', '2025-09-25 10:29:57'),
	('5', 'openai-gpt-5', '{\"env\": {\"model\": \"openai\", \"api_key\": \"7a7edbdef9eab85c8x\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"gpt-5-2025-08-07\"}}', '1', '2025-09-25 10:29:58', '2025-09-25 10:29:58'),
	('6', 'wecode-china-auto', '{\"env\": {\"model\": \"openai\", \"api_key\": \"7a7edbdef9eab85c8x\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"ali-deepseek-v3.1\"}}', '1', '2025-09-25 10:30:51', '2025-09-25 10:30:51'),
	('7', 'wecode-global-auto', '{\"env\": {\"model\": \"openai\", \"api_key\": \"7a7edbdef9eab85c8x\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"wecode-gpt-4.1\"}}', '1', '2025-09-25 10:30:51', '2025-09-25 10:30:51'),
	('8', 'sina-qwen3-coder', '{\"env\": {\"model\": \"openai\", \"api_key\": \"7a7edbdef9eab85c8x\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"sina-qwen3-coder\"}}', '1', '2025-09-25 10:30:51', '2025-09-25 10:30:51'),
	('9', 'sina-glm-4.5', '{\"env\": {\"model\": \"openai\", \"api_key\": \"7a7edbdef9eab85c8x\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"sina-glm-4.5\"}}', '1', '2025-09-25 10:30:51', '2025-09-25 10:30:51'),
	('10', 'openai-o3', '{\"env\": {\"model\": \"openai\", \"api_key\": \"7a7edbdef9eab85c8x\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"o3\"}}', '1', '2025-09-25 10:30:51', '2025-09-25 10:30:51'),
	('11', 'ali-kimi-k2', '{\"env\": {\"model\": \"openai\", \"api_key\": \"7a7edbdef9eab85c8x\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"ali-kimi-k2\"}}', '1', '2025-09-25 10:30:51', '2025-09-25 10:30:51'),
	('12', 'ali-qwen3-coder-plus', '{\"env\": {\"model\": \"openai\", \"api_key\": \"7a7edbdef9eab85c8x\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"ali-qwen3-coder-plus\"}}', '1', '2025-09-25 10:30:51', '2025-09-25 10:30:51'),
	('13', 'wecode-claude3.7', '{\"env\": {\"model\": \"claude\", \"api_key\": \"7a7edbdef9eab85c8x\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"wecode-claude3.7\"}}', '1', '2025-09-25 10:30:51', '2025-09-25 10:30:51'),
	('14', 'wecode-claude-opus-4.1', '{\"env\": {\"model\": \"claude\", \"api_key\": \"7a7edbdef9eab85c8x\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"wecode-claude-opus-4.1\"}}', '1', '2025-09-25 10:30:52', '2025-09-25 10:30:52'),
	('15', 'huoshan-deepseek-v3', '{\"env\": {\"model\": \"openai\", \"api_key\": \"7a7edbdef9eab85c8x\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"deepseek-chat\"}}', '1', '2025-09-25 10:30:52', '2025-09-25 10:30:52'),
	('16', 'ali-deepseek-v3.1', '{\"env\": {\"model\": \"openai\", \"api_key\": \"7a7edbdef9eab85c8x\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"ali-deepseek-v3.1\"}}', '1', '2025-09-25 10:30:52', '2025-09-25 10:30:52'),
	('17', 'wecode-gemini-2.5', '{\"env\": {\"model\": \"openai\", \"api_key\": \"7a7edbdef9eab85c8x\", \"base_url\": \"https://copilot.weibo.com/v1\", \"model_id\": \"wecode-gemini-2.5\"}}', '1', '2025-09-25 10:30:52', '2025-09-25 10:30:52');

