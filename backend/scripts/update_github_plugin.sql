-- 更新 GitHub 插件的图标和中文描述

-- 更新 plugins 表
UPDATE plugins
SET
    interface_json = JSON_SET(
        COALESCE(interface_json, '{}'),
        '$.logo', 'https://github.githubassets.com/assets/GitHub-Mark-ea2971cee799.png',
        '$.composerIcon', 'https://github.githubassets.com/assets/GitHub-Mark-ea2971cee799.png',
        '$.displayName', 'GitHub',
        '$.shortDescription', '通过连接器优先的工作流检查仓库、审查拉取请求、处理反馈、调试失败的 Actions 检查，并准备代码更改以供审查，使用有针对性的 CLI 回退。',
        '$.longDescription', '使用 GitHub 检查存储库、审查拉取请求、处理反馈、调试失败的 Actions 检查，并通过连接器优先的工作流准备代码更改以供审查，使用有针对性的 CLI 回退。',
        '$.category', 'Developer Tools',
        '$.developerName', 'OpenAI'
    ),
    display_name = 'GitHub',
    summary = '通过连接器优先的工作流检查仓库、审查拉取请求、处理反馈、调试失败的 Actions 检查',
    description_md = '使用 GitHub 检查存储库、审查拉取请求、处理反馈、调试失败的 Actions 检查，并通过连接器优先的工作流准备代码更改以供审查，使用有针对性的 CLI 回退。'
WHERE name = 'github';

-- 更新 plugin_releases 表
UPDATE plugin_releases
SET
    interface_json = JSON_SET(
        COALESCE(interface_json, '{}'),
        '$.logo', 'https://github.githubassets.com/assets/GitHub-Mark-ea2971cee799.png',
        '$.composerIcon', 'https://github.githubassets.com/assets/GitHub-Mark-ea2971cee799.png',
        '$.displayName', 'GitHub',
        '$.shortDescription', '通过连接器优先的工作流检查仓库、审查拉取请求、处理反馈、调试失败的 Actions 检查，并准备代码更改以供审查，使用有针对性的 CLI 回退。',
        '$.longDescription', '使用 GitHub 检查存储库、审查拉取请求、处理反馈、调试失败的 Actions 检查，并通过连接器优先的工作流准备代码更改以供审查，使用有针对性的 CLI 回退。',
        '$.category', 'Developer Tools',
        '$.developerName', 'OpenAI'
    )
WHERE plugin_id = (SELECT id FROM plugins WHERE name = 'github' LIMIT 1);

SELECT
    '✓ 已更新 GitHub 插件数据' AS message,
    name,
    display_name,
    JSON_EXTRACT(interface_json, '$.logo') AS logo,
    JSON_EXTRACT(interface_json, '$.shortDescription') AS description
FROM plugins
WHERE name = 'github';
