-- 检查现有的 github 插件
SELECT id, name, slug, owner_user_id, status, visibility, created_at
FROM plugins
WHERE slug = 'github';

-- 如果存在，有两个选择：

-- 选择 1: 删除现有的插件（如果它是测试数据）
-- DELETE FROM plugin_releases WHERE plugin_id = (SELECT id FROM plugins WHERE slug = 'github');
-- DELETE FROM plugins WHERE slug = 'github';

-- 选择 2: 更新现有插件的所有者
-- UPDATE plugins SET owner_user_id = 1 WHERE slug = 'github';

-- 然后重新运行发布脚本
