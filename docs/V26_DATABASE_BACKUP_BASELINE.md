# Site v26 数据库备份中心基线

核对日期：2026-08-24

## 唯一来源关系

- 正式 Site：`TG 内容工具箱`，Sites 版本 `v26`。
- 实际 Site 源码提交：`124e80b491eb4b7a3dee5f3e8eb44aeffc317f9e`。
- 实际 Site 源码树：`13c743aa695e1b4dde953c993a1bc8517edb8090`。
- 候选开发分支：`codex/cloud/v26-database-backup-center`，直接从上述 v26 实际源码建立。
- 数据库来源：该正式 Site 绑定的现有 D1 `DB`。Sites 数据库概览返回完整清单，`truncated=false`、遗漏表数为 0。
- GitHub 历史分支只用于追溯，不作为本候选源码或数据库状态的推测来源。

## 正式 D1 业务表清单

1. `app_logs`
2. `app_settings`
3. `content_results`
4. `content_runs`
5. `data_snapshot_items`
6. `data_snapshots`
7. `import_batch_chunks`
8. `import_batches`
9. `import_changes`
10. `input_sources`
11. `permanent_records`
12. `script_generations`
13. `sync_transactions`
14. `task_inbox`
15. `telegram_accounts`
16. `telegram_auth_flows`
17. `telegram_bot_state`
18. `telegram_connections`
19. `telegram_message_fingerprints`
20. `telegram_messages`
21. `telegram_migration_runs`
22. `telegram_read_states`
23. `telegram_sync_runs`
24. `telegram_tool_queue`
25. `tool_source_bindings`

正式 D1 当前没有任何 `cloud_sync_*` 表。v26 实际源码只包含 `0000` 至 `0004` 迁移，不包含或执行 `0006`。

## 候选能力与边界

- 备份格式：`tg-content-toolbox-d1-backup/v1`。
- 完整导出上述 25 表；清单记录逐表行数、主键和 SHA-256，并记录总行数与总清单 SHA-256。
- 恢复前重新计算逐表与总清单摘要，并与目标 D1 的 25 表列定义核对。
- Telegram `encrypted_session`、`session_encrypted`、`encrypted_challenge` 等字段只按原值作为不透明加密密文备份和恢复；界面不显示任何备份行内容，不调用解密逻辑。
- 恢复需要显式输入 `RESTORE 25 TABLES`。候选开发与测试仅对临时 D1 执行恢复；没有对正式 D1 发起备份写入、恢复、迁移或同步。
- 10 万行演练使用内存临时 D1，完成完整备份、恢复和恢复后 SHA-256 复核。
- 本候选不新增 D1 表，不包含 `0006`，不启动同步，不读取或修改 Secret。
