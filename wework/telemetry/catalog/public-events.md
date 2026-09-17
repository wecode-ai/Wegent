# Wework Public Telemetry Event Catalog

Generated from `src/telemetry/registry/smartAppRegistry.json`.

| Event                            | 名称               | Name                       | 中文说明                   | Description                               | Public properties         |
| -------------------------------- | ------------------ | -------------------------- | -------------------------- | ----------------------------------------- | ------------------------- |
| `smart_app_marketplace_opened`   | 打开智能工作台市场 | Open Smart App marketplace | 用户进入智能工作台市场入口 | The user enters the Smart App marketplace | `domain`                  |
| `smart_app_owned_opened`         | 打开我的智能工作台 | Open owned Smart Apps      | 用户进入我的智能工作台     | The user enters owned Smart Apps          | `domain`                  |
| `smart_app_opened`               | 打开智能工作台     | Open Smart App             | 用户打开一个智能工作台     | The user opens a Smart App                | `domain`                  |
| `smart_app_install_succeeded`    | 安装智能工作台     | Install Smart App          | 用户安装智能工作台         | The user installs a Smart App             | `domain`                  |
| `smart_app_install_failed`       | 安装智能工作台     | Install Smart App          | 用户安装智能工作台         | The user installs a Smart App             | `domain`, `failure_stage` |
| `smart_app_update_succeeded`     | 更新智能工作台     | Update Smart App           | 用户更新智能工作台         | The user updates a Smart App              | `domain`                  |
| `smart_app_update_failed`        | 更新智能工作台     | Update Smart App           | 用户更新智能工作台         | The user updates a Smart App              | `domain`, `failure_stage` |
| `smart_app_zip_import_succeeded` | 导入智能工作台 ZIP | Import Smart App ZIP       | 用户导入智能工作台 ZIP     | The user imports a Smart App ZIP          | `domain`                  |
| `smart_app_zip_import_failed`    | 导入智能工作台 ZIP | Import Smart App ZIP       | 用户导入智能工作台 ZIP     | The user imports a Smart App ZIP          | `domain`, `failure_stage` |
