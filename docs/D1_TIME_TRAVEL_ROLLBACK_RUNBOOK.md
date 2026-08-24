# 正式 D1 Time Travel 回滚点门槛

更新日期：2026-08-24

## 当前状态

- Site v27、v28 未获部署批准；多请求可续传的 Site v29 备份中心候选也未部署。
- 本候选没有连接 Cloudflare 管理 API，没有获取正式 D1 bookmark，也没有执行恢复、迁移或 `0006`。
- 以下步骤是未来正式迁移的强制人工门槛，不是本轮已执行事项。

## 迁移前必须记录

由所有者在已确认的 Cloudflare 账号、正确项目和正式 D1 数据库名称下执行只读查询：

```text
npx wrangler d1 time-travel info <FORMAL_DATABASE_NAME> --json
```

记录到受控发布单（不得写入 Secret）：

1. UTC 时间；
2. Cloudflare account / project 标识；
3. 正式 D1 的数据库名称与 database ID；
4. 返回的 current bookmark；
5. 待发布 Git SHA、Site 候选版本和迁移清单；
6. 操作者与复核者。

在 bookmark、数据库身份或待发布 SHA 任一缺失或不一致时，正式迁移必须停止。不要用可能变化的 binding 名称代替数据库名称。

## 回滚边界

Cloudflare 官方说明 Time Travel restore 会原地覆盖数据库，并取消执行中的查询；因此只能在所有者另行批准、停止写入并再次核对数据库身份后执行。Site UI 和生产 Worker 不提供 Time Travel restore，也不保存 Cloudflare 凭据。

正式回滚命令仅作为受控事故操作参考，本候选不得执行：

```text
npx wrangler d1 time-travel restore <FORMAL_DATABASE_NAME> --bookmark=<RECORDED_BOOKMARK>
```

官方依据：

- https://developers.cloudflare.com/d1/reference/time-travel/
- https://developers.cloudflare.com/d1/wrangler-commands/#d1-time-travel-info
