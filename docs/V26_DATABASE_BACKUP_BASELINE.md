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

- 候选 Site 版本：v29；只保存，不部署。v27、v28 未获部署批准，正式 Site 仍为 v26。
- v29 将完整备份拆成浏览器驱动的多请求协议：清单 2 次查询，每个游标分页请求 2 次查询，完成探针 1 次查询；服务端无状态且全程只读。
- 备份格式：`tg-content-toolbox-d1-backup-ndjson/v2`。
- 页面加载仅查询 Schema 与逐表 `COUNT(*)`；不会自动读取全部业务行或生成完整备份。
- 完整导出必须由所有者显式触发。Worker 使用 250 行有界分页流式输出，不在内存中保留全库。
- 每页参与 SHA-256 链，清单记录逐表行数、主键和 SHA-256，并记录总行数与总清单 SHA-256。
- 完整输出后再对源库执行第二遍有界扫描；两遍摘要不一致时完成标记为无效，文件校验必须失败。
- 校验器流式复算格式、25 表顺序、列定义、分页顺序、逐表行数、逐表 SHA-256、总清单 SHA-256 与一致性完成标记；不会写入 D1。
- Telegram `encrypted_session`、`session_encrypted`、`encrypted_challenge` 等字段只按原值作为不透明加密密文导出；界面不显示任何备份行内容，不调用解密逻辑。
- 生产恢复按钮、生产恢复 API 和生产写入实现全部移除。JSON/NDJSON 恢复仅在测试夹具中针对 25 表全空的全新临时 D1 演练。
- Workers/Miniflare D1 10 万行测试完成流式备份与全量校验；另有中途失败零写入、并发变化一致性和未获准访问测试。
- 正式迁移前必须按 `docs/D1_TIME_TRAVEL_ROLLBACK_RUNBOOK.md` 记录正式 D1 Time Travel bookmark；本候选没有执行该动作。
- 本候选不新增 D1 表，不包含 `0006`，不启动同步，不读取或修改 Secret。
