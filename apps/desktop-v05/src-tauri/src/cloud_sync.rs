use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use chrono::Utc;
use reqwest::{Client, Url};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{
    sync::oneshot,
    time::{sleep, Duration},
};

use crate::telegram_user::{protect_data, unprotect_data};

const CREDENTIAL_VERSION: u8 = 1;

#[derive(Debug, Clone)]
pub struct CloudSyncRuntime {
    credential_path: PathBuf,
    client: Client,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredDeviceCredential {
    version: u8,
    node_id: String,
    device_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingResponse {
    schema_version: u8,
    node_id: String,
    device_token: String,
    latest_sequence: i64,
}

#[derive(Debug, Deserialize)]
struct ErrorResponse {
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncEntity {
    entity_type: String,
    entity_key: String,
    record_version: i64,
    #[serde(default)]
    tombstone: bool,
    payload: Option<serde_json::Value>,
    #[serde(default)]
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotResponse {
    entities: Vec<SyncEntity>,
    next_key: String,
    has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncPreview {
    pub preview_id: String,
    pub local_count: usize,
    pub remote_count: usize,
    pub same_count: usize,
    pub local_only_count: usize,
    pub remote_only_count: usize,
    pub different_count: usize,
    pub delete_count: usize,
    pub entity_counts: BTreeMap<String, usize>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullOperation {
    sequence: i64,
    operation_id: String,
    node_id: String,
    entity_type: String,
    entity_key: String,
    action: String,
    record_version: i64,
    occurred_at: String,
    payload: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct EntityResponse {
    entity: Option<SyncEntity>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncConflict {
    pub id: i64,
    pub operation_id: String,
    pub entity_type: String,
    pub entity_key: String,
    pub reason: String,
    pub status: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictDecision {
    AcceptRemote,
    KeepLocal,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullResponse {
    operations: Vec<PullOperation>,
    next_sequence: i64,
    latest_sequence: i64,
    has_more: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushAccepted {
    operation_id: String,
    record_version: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushRejected {
    operation_id: String,
    reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushResponse {
    accepted: Vec<PushAccepted>,
    rejected: Vec<PushRejected>,
    latest_sequence: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaseResponse {
    acquired: bool,
    lease_key: String,
    lease_token: String,
    #[serde(default)]
    holder_node_id: String,
    #[serde(default)]
    expires_at: String,
}

pub struct TelegramLease {
    client: Client,
    gateway_url: String,
    device_token: String,
    lease_key: String,
    lease_token: String,
    valid: Arc<AtomicBool>,
    stop: Option<oneshot::Sender<()>>,
}

impl TelegramLease {
    pub async fn release(mut self) -> Result<(), String> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        let response = self
            .client
            .post(join_url(&self.gateway_url, "v1/leases/release"))
            .bearer_auth(&self.device_token)
            .json(&serde_json::json!({"leaseKey":self.lease_key,"leaseToken":self.lease_token}))
            .send()
            .await
            .map_err(|error| {
                format!(
                    "释放 Telegram 云端执行权失败：{}",
                    clean_network_error(&error.to_string())
                )
            })?;
        if !response.status().is_success() {
            return Err(format!(
                "释放 Telegram 云端执行权失败：HTTP {}",
                response.status().as_u16()
            ));
        }
        if !self.valid.load(Ordering::SeqCst) {
            return Err(
                "Telegram 云端执行权在操作期间失效，本次结果不会推进本地断点或已读位置".to_string(),
            );
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncDirection {
    Push,
    Pull,
    Both,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncReport {
    pub pushed: usize,
    pub pulled: usize,
    pub deleted: usize,
    pub conflicts: usize,
    pub latest_remote_sequence: i64,
    pub has_more: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRunInput {
    pub direction: SyncDirection,
    pub preview_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInput {
    pub gateway_url: String,
    pub code: String,
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncStatus {
    pub configured: bool,
    pub node_id: String,
    pub gateway_url: String,
    pub gateway_reachable: bool,
    pub latest_remote_sequence: i64,
    pub last_pulled_sequence: i64,
    pub pending_uploads: i64,
    pub open_conflicts: i64,
    pub last_push_at: String,
    pub last_pull_at: String,
    pub last_success_at: String,
    pub last_error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayHealth {
    pub reachable: bool,
    pub schema_version: i64,
    pub error: String,
}

impl CloudSyncRuntime {
    pub fn new(data_dir: &Path) -> Result<Self, String> {
        let client = Client::builder()
            .connect_timeout(std::time::Duration::from_secs(8))
            .timeout(std::time::Duration::from_secs(15))
            .user_agent("TG-Content-Toolbox-Windows/0.5")
            .build()
            .map_err(|error| format!("创建云同步网络客户端失败：{error}"))?;
        Ok(Self {
            credential_path: data_dir.join("cloud-sync-device-v1.bin"),
            client,
        })
    }

    pub fn status(&self, database_path: &Path) -> Result<CloudSyncStatus, String> {
        let connection = open(database_path)?;
        let mut status = connection
            .query_row(
                "SELECT node_id,gateway_url,last_pulled_sequence,last_push_at,last_pull_at,last_success_at,last_error,last_remote_sequence FROM cloud_sync_state WHERE singleton=1",
                [],
                |row| Ok(CloudSyncStatus {
                    configured: false,
                    node_id: row.get(0)?,
                    gateway_url: row.get(1)?,
                    gateway_reachable: false,
                    latest_remote_sequence: row.get(7)?,
                    last_pulled_sequence: row.get(2)?,
                    pending_uploads: 0,
                    open_conflicts: 0,
                    last_push_at: row.get(3)?,
                    last_pull_at: row.get(4)?,
                    last_success_at: row.get(5)?,
                    last_error: row.get(6)?,
                }),
            )
            .map_err(|error| format!("读取云同步状态失败：{error}"))?;
        status.pending_uploads = connection
            .query_row(
                "SELECT COUNT(*) FROM cloud_sync_outbox WHERE status IN ('pending','retry')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        status.open_conflicts = connection
            .query_row(
                "SELECT COUNT(*) FROM cloud_sync_conflicts WHERE status='open'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        status.configured = self.read_credential().is_ok()
            && !status.node_id.is_empty()
            && !status.gateway_url.is_empty();
        Ok(status)
    }

    pub async fn health(&self, gateway_url: &str) -> GatewayHealth {
        let base = match normalize_gateway_url(gateway_url) {
            Ok(value) => value,
            Err(error) => {
                return GatewayHealth {
                    reachable: false,
                    schema_version: 0,
                    error,
                }
            }
        };
        match self.client.get(join_url(&base, "health")).send().await {
            Ok(response) if response.status().is_success() => {
                let payload = response
                    .json::<serde_json::Value>()
                    .await
                    .unwrap_or_default();
                GatewayHealth {
                    reachable: payload
                        .get("ok")
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false),
                    schema_version: payload
                        .get("schemaVersion")
                        .and_then(|value| value.as_i64())
                        .unwrap_or(0),
                    error: String::new(),
                }
            }
            Ok(response) => GatewayHealth {
                reachable: false,
                schema_version: 0,
                error: format!("同步网关 HTTP {}", response.status().as_u16()),
            },
            Err(error) => GatewayHealth {
                reachable: false,
                schema_version: 0,
                error: clean_network_error(&error.to_string()),
            },
        }
    }

    pub async fn acquire_telegram_lease(
        &self,
        database_path: &Path,
        connection_key: &str,
        source_key: &str,
    ) -> Result<Option<TelegramLease>, String> {
        let status = self.status(database_path)?;
        if !status.configured {
            return Ok(None);
        }
        let credential = self.read_credential()?;
        let lease_key = format!(
            "telegram:{}:{}",
            safe_lease_part(connection_key),
            safe_lease_part(source_key)
        );
        let response = self
            .client
            .post(join_url(&status.gateway_url, "v1/leases/acquire"))
            .bearer_auth(&credential.device_token)
            .json(&serde_json::json!({"leaseKey":lease_key,"ttlSeconds":120}))
            .send()
            .await
            .map_err(|error| {
                format!(
                    "取得 Telegram 云端执行权失败：{}",
                    clean_network_error(&error.to_string())
                )
            })?;
        let http_status = response.status();
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        if !http_status.is_success() {
            let detail = serde_json::from_slice::<serde_json::Value>(&bytes).unwrap_or_default();
            let holder = detail
                .get("holderNodeId")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let expires = detail
                .get("expiresAt")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            return Err(if holder.is_empty() {
                response_error("取得 Telegram 云端执行权失败", http_status.as_u16(), &bytes)
            } else {
                format!("该 Telegram 来源正在由 {holder} 处理，预计执行权于 {expires} 后释放")
            });
        }
        let lease: LeaseResponse = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Telegram 执行权格式无效：{error}"))?;
        if !lease.acquired || lease.lease_token.is_empty() || lease.lease_key != lease_key {
            return Err(format!(
                "Telegram 执行权未取得（{} {}）",
                lease.holder_node_id, lease.expires_at
            ));
        }
        let valid = Arc::new(AtomicBool::new(true));
        let (stop_tx, mut stop_rx) = oneshot::channel();
        let client = self.client.clone();
        let gateway_url = status.gateway_url.clone();
        let device_token = credential.device_token.clone();
        let renew_key = lease.lease_key.clone();
        let renew_token = lease.lease_token.clone();
        let renew_valid = valid.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = sleep(Duration::from_secs(30)) => {
                        let renewed = client.post(join_url(&gateway_url, "v1/leases/renew"))
                            .bearer_auth(&device_token)
                            .json(&serde_json::json!({"leaseKey":renew_key,"leaseToken":renew_token,"ttlSeconds":120}))
                            .send().await.map(|response| response.status().is_success()).unwrap_or(false);
                        if !renewed { renew_valid.store(false, Ordering::SeqCst); break; }
                    }
                    _ = &mut stop_rx => break,
                }
            }
        });
        Ok(Some(TelegramLease {
            client: self.client.clone(),
            gateway_url: status.gateway_url,
            device_token: credential.device_token,
            lease_key: lease.lease_key,
            lease_token: lease.lease_token,
            valid,
            stop: Some(stop_tx),
        }))
    }

    pub async fn pair(
        &self,
        database_path: &Path,
        input: PairingInput,
    ) -> Result<CloudSyncStatus, String> {
        let gateway_url = normalize_gateway_url(&input.gateway_url)?;
        let code = normalize_pairing_code(&input.code);
        if code.len() != 10 {
            return Err("配对码必须是 10 位字母或数字".to_string());
        }
        let existing_node = self.status(database_path)?.node_id;
        let requested_node = if existing_node.is_empty() {
            new_node_id()?
        } else {
            existing_node
        };
        let response = self
            .client
            .post(join_url(&gateway_url, "v1/devices/exchange"))
            .json(&serde_json::json!({
                "code": code,
                "nodeId": requested_node,
                "label": input.label.trim(),
            }))
            .send()
            .await
            .map_err(|error| {
                format!(
                    "连接同步网关失败：{}",
                    clean_network_error(&error.to_string())
                )
            })?;
        let status_code = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("读取配对结果失败：{error}"))?;
        if !status_code.is_success() {
            let message = serde_json::from_slice::<ErrorResponse>(&bytes)
                .ok()
                .and_then(|value| value.error)
                .unwrap_or_else(|| format!("HTTP {}", status_code.as_u16()));
            return Err(format!("设备配对失败：{}", clean_network_error(&message)));
        }
        let paired: PairingResponse =
            serde_json::from_slice(&bytes).map_err(|error| format!("配对结果格式无效：{error}"))?;
        if paired.schema_version != 1 || paired.node_id.is_empty() || paired.device_token.len() < 20
        {
            return Err("同步网关返回了不兼容的设备凭据".to_string());
        }
        self.write_credential(&StoredDeviceCredential {
            version: CREDENTIAL_VERSION,
            node_id: paired.node_id.clone(),
            device_token: paired.device_token,
        })?;
        let now = Utc::now().to_rfc3339();
        if let Err(error) = open(database_path)?.execute(
            "UPDATE cloud_sync_state SET node_id=?1,gateway_url=?2,last_remote_sequence=?3,last_error='',updated_at=?4 WHERE singleton=1",
            params![paired.node_id, gateway_url, paired.latest_sequence, now],
        ) {
            let _ = std::fs::remove_file(&self.credential_path);
            return Err(format!("保存同步状态失败：{error}"));
        }
        let mut status = self.status(database_path)?;
        status.latest_remote_sequence = paired.latest_sequence;
        status.gateway_reachable = true;
        Ok(status)
    }

    pub async fn preview(&self, database_path: &Path) -> Result<CloudSyncPreview, String> {
        let status = self.status(database_path)?;
        if !status.configured {
            return Err("请先用网页端一次性配对码连接这台电脑".to_string());
        }
        let credential = self.read_credential()?;
        let local = collect_local_entities(database_path)?;
        let remote = self
            .fetch_snapshot(&status.gateway_url, &credential.device_token)
            .await?;
        let mut same_count = 0;
        let mut local_only_count = 0;
        let mut different_count = 0;
        let mut delete_count = 0;
        let mut entity_counts = BTreeMap::new();
        for entity in local.values() {
            *entity_counts.entry(entity.entity_type.clone()).or_insert(0) += 1;
            match remote.get(&entity.entity_key) {
                None => local_only_count += 1,
                Some(other) if entity_hash(entity) == entity_hash(other) => same_count += 1,
                Some(_) => different_count += 1,
            }
        }
        let mut remote_only_count = 0;
        for (key, entity) in &remote {
            if !local.contains_key(key) {
                remote_only_count += 1;
                if entity.tombstone {
                    delete_count += 1;
                }
            }
        }
        let local_hash = snapshot_hash(&local);
        let latest_remote_sequence = self
            .remote_latest_sequence(
                &status.gateway_url,
                &credential.device_token,
                status.last_pulled_sequence,
            )
            .await?;
        let preview_id = new_id("preview")?;
        let previewed_at = Utc::now().to_rfc3339();
        open(database_path)?.execute(
            "UPDATE cloud_sync_state SET preview_id=?1,preview_local_hash=?2,preview_remote_sequence=?3,previewed_at=?4,last_remote_sequence=?3,last_error='',updated_at=?4 WHERE singleton=1",
            params![preview_id, local_hash, latest_remote_sequence, previewed_at],
        ).map_err(|error| format!("保存同步预览状态失败：{error}"))?;
        let mut warnings = Vec::new();
        if different_count > 0 {
            warnings.push(format!(
                "有 {different_count} 条同键不同内容，执行前请确认冲突方向"
            ));
        }
        if remote_only_count > 0 {
            warnings.push(format!(
                "云端有 {remote_only_count} 条本地没有的数据；仅 Push 不会删除它们"
            ));
        }
        Ok(CloudSyncPreview {
            preview_id,
            local_count: local.len(),
            remote_count: remote.len(),
            same_count,
            local_only_count,
            remote_only_count,
            different_count,
            delete_count,
            entity_counts,
            warnings,
        })
    }

    pub fn list_conflicts(
        &self,
        database_path: &Path,
        limit: usize,
    ) -> Result<Vec<CloudSyncConflict>, String> {
        let connection = open(database_path)?;
        let mut statement = connection.prepare(
            "SELECT id,operation_id,entity_type,entity_key,reason,status,created_at FROM cloud_sync_conflicts WHERE status='open' ORDER BY id DESC LIMIT ?1",
        ).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![limit.clamp(1, 1000) as i64], |row| {
                Ok(CloudSyncConflict {
                    id: row.get(0)?,
                    operation_id: row.get(1)?,
                    entity_type: row.get(2)?,
                    entity_key: row.get(3)?,
                    reason: row.get(4)?,
                    status: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(rows)
    }

    pub async fn resolve_conflict(
        &self,
        database_path: &Path,
        conflict_id: i64,
        decision: ConflictDecision,
    ) -> Result<CloudSyncConflict, String> {
        let status = self.status(database_path)?;
        if !status.configured {
            return Err("尚未配置云同步".to_string());
        }
        let credential = self.read_credential()?;
        let connection = open(database_path)?;
        let conflict: CloudSyncConflict = connection.query_row(
            "SELECT id,operation_id,entity_type,entity_key,reason,status,created_at FROM cloud_sync_conflicts WHERE id=?1",
            params![conflict_id],
            |row| Ok(CloudSyncConflict { id:row.get(0)?,operation_id:row.get(1)?,entity_type:row.get(2)?,entity_key:row.get(3)?,reason:row.get(4)?,status:row.get(5)?,created_at:row.get(6)? }),
        ).map_err(|error| format!("找不到同步冲突：{error}"))?;
        if conflict.status != "open" {
            return Err("该冲突已经处理".to_string());
        }
        drop(connection);
        let remote = self
            .fetch_entity(
                &status.gateway_url,
                &credential.device_token,
                &conflict.entity_type,
                &conflict.entity_key,
            )
            .await?;
        let local = if matches!(decision, ConflictDecision::KeepLocal) {
            Some(collect_local_entities(database_path)?)
        } else {
            None
        };
        let mut connection = open(database_path)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let now = Utc::now().to_rfc3339();
        match decision {
            ConflictDecision::AcceptRemote => {
                let entity = remote.ok_or_else(|| "云端实体已经不存在，请重新预览".to_string())?;
                let operation = PullOperation {
                    sequence: status.last_pulled_sequence,
                    operation_id: entity.entity_key.clone(),
                    node_id: "cloud-resolution".to_string(),
                    entity_type: entity.entity_type.clone(),
                    entity_key: entity.entity_key.clone(),
                    action: if entity.tombstone {
                        "delete".to_string()
                    } else {
                        "upsert".to_string()
                    },
                    record_version: entity.record_version,
                    occurred_at: entity.updated_at.clone(),
                    payload: entity.payload.clone(),
                };
                apply_business_entity(&transaction, &operation)?;
                transaction.execute("DELETE FROM cloud_sync_outbox WHERE entity_type=?1 AND entity_key=?2 AND status IN ('pending','retry','conflict')", params![conflict.entity_type,conflict.entity_key]).map_err(|error| error.to_string())?;
                transaction.execute(
                    "INSERT INTO cloud_sync_entities(entity_type,entity_key,record_version,payload_hash,tombstone,updated_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(entity_type,entity_key) DO UPDATE SET record_version=excluded.record_version,payload_hash=excluded.payload_hash,tombstone=excluded.tombstone,updated_at=excluded.updated_at",
                    params![entity.entity_type,entity.entity_key,entity.record_version,entity.payload.as_ref().map(stable_json).map(|value|hash_text(&value)).unwrap_or_default(),entity.tombstone as i64,entity.updated_at],
                ).map_err(|error| error.to_string())?;
                transaction.execute("UPDATE cloud_sync_conflicts SET status='accepted_remote',resolved_at=?2 WHERE id=?1", params![conflict_id,now]).map_err(|error| error.to_string())?;
            }
            ConflictDecision::KeepLocal => {
                let entity = local
                    .as_ref()
                    .and_then(|values| values.get(&conflict.entity_key));
                let base_version = remote
                    .as_ref()
                    .map(|value| value.record_version)
                    .unwrap_or(0);
                let restore = remote
                    .as_ref()
                    .map(|value| value.tombstone)
                    .unwrap_or(false)
                    && entity.is_some();
                transaction.execute("DELETE FROM cloud_sync_outbox WHERE entity_type=?1 AND entity_key=?2 AND status IN ('pending','retry','conflict')", params![conflict.entity_type,conflict.entity_key]).map_err(|error| error.to_string())?;
                let (action, payload_json) = entity
                    .map(|value| {
                        (
                            "upsert",
                            stable_json(value.payload.as_ref().unwrap_or(&serde_json::Value::Null)),
                        )
                    })
                    .unwrap_or(("delete", String::new()));
                transaction.execute(
                    "INSERT INTO cloud_sync_outbox(operation_id,entity_type,entity_key,action,restore,base_version,payload_json,occurred_at,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8,?8)",
                    params![new_id(&format!("op_{}",credential.node_id))?,conflict.entity_type,conflict.entity_key,action,restore as i64,base_version,payload_json,now],
                ).map_err(|error| error.to_string())?;
                transaction.execute("UPDATE cloud_sync_conflicts SET status='kept_local',resolved_at=?2 WHERE id=?1", params![conflict_id,now]).map_err(|error| error.to_string())?;
            }
        }
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(CloudSyncConflict {
            status: match decision {
                ConflictDecision::AcceptRemote => "accepted_remote".to_string(),
                ConflictDecision::KeepLocal => "kept_local".to_string(),
            },
            ..conflict
        })
    }

    pub async fn run_sync(
        &self,
        database_path: &Path,
        input: SyncRunInput,
    ) -> Result<CloudSyncReport, String> {
        let status = self.status(database_path)?;
        if !status.configured {
            return Err("尚未配置云同步".to_string());
        }
        self.verify_preview(database_path, &status, &input.preview_id)
            .await?;
        let credential = self.read_credential()?;
        let mut report = CloudSyncReport {
            pushed: 0,
            pulled: 0,
            deleted: 0,
            conflicts: 0,
            latest_remote_sequence: status.latest_remote_sequence,
            has_more: false,
        };
        if matches!(input.direction, SyncDirection::Push | SyncDirection::Both) {
            enqueue_local_changes(database_path, &credential.node_id)?;
            let pushed = self
                .push_outbox(database_path, &status.gateway_url, &credential)
                .await?;
            report.pushed += pushed.pushed;
            report.conflicts += pushed.conflicts;
            report.latest_remote_sequence = pushed.latest_remote_sequence;
        }
        if matches!(input.direction, SyncDirection::Pull | SyncDirection::Both) {
            loop {
                let pulled = self
                    .pull_once(database_path, &status.gateway_url, &credential)
                    .await?;
                report.pulled += pulled.pulled;
                report.deleted += pulled.deleted;
                report.conflicts += pulled.conflicts;
                report.latest_remote_sequence = pulled.latest_remote_sequence;
                report.has_more = pulled.has_more;
                if !pulled.has_more {
                    break;
                }
            }
        }
        let now = Utc::now().to_rfc3339();
        open(database_path)?.execute(
            "UPDATE cloud_sync_state SET last_success_at=?1,last_remote_sequence=?2,last_error='',preview_id='',preview_local_hash='',updated_at=?1 WHERE singleton=1",
            params![now,report.latest_remote_sequence],
        ).map_err(|error| error.to_string())?;
        Ok(report)
    }

    async fn verify_preview(
        &self,
        database_path: &Path,
        status: &CloudSyncStatus,
        preview_id: &str,
    ) -> Result<(), String> {
        let connection = open(database_path)?;
        let row: (String, String, i64, String) = connection.query_row(
            "SELECT preview_id,preview_local_hash,preview_remote_sequence,previewed_at FROM cloud_sync_state WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).map_err(|error| error.to_string())?;
        drop(connection);
        if preview_id.is_empty() || row.0 != preview_id {
            return Err("同步预览无效，请重新生成差异预览".to_string());
        }
        let preview_time = chrono::DateTime::parse_from_rfc3339(&row.3)
            .map_err(|_| "同步预览时间无效".to_string())?;
        if Utc::now()
            .signed_duration_since(preview_time.with_timezone(&Utc))
            .num_minutes()
            > 30
        {
            return Err("同步预览已超过 30 分钟，请重新生成".to_string());
        }
        if snapshot_hash(&collect_local_entities(database_path)?) != row.1 {
            return Err("预览后本地数据已经变化，请重新生成预览".to_string());
        }
        let credential = self.read_credential()?;
        let latest = self
            .remote_latest_sequence(&status.gateway_url, &credential.device_token, row.2)
            .await?;
        if latest != row.2 {
            return Err("预览后云端数据已经变化，请重新生成预览".to_string());
        }
        Ok(())
    }

    async fn fetch_snapshot(
        &self,
        gateway_url: &str,
        token: &str,
    ) -> Result<HashMap<String, SyncEntity>, String> {
        let mut output = HashMap::new();
        let mut after_key = String::new();
        loop {
            let mut url = Url::parse(&join_url(gateway_url, "v1/sync/snapshot"))
                .map_err(|error| error.to_string())?;
            url.query_pairs_mut()
                .append_pair("after_key", &after_key)
                .append_pair("limit", "500");
            let response = self
                .client
                .get(url)
                .bearer_auth(token)
                .send()
                .await
                .map_err(|error| {
                    format!(
                        "读取云端快照失败：{}",
                        clean_network_error(&error.to_string())
                    )
                })?;
            let status = response.status();
            let bytes = response.bytes().await.map_err(|error| error.to_string())?;
            if !status.is_success() {
                return Err(response_error("读取云端快照失败", status.as_u16(), &bytes));
            }
            let page: SnapshotResponse = serde_json::from_slice(&bytes)
                .map_err(|error| format!("云端快照格式无效：{error}"))?;
            for entity in page.entities {
                output.insert(entity.entity_key.clone(), entity);
            }
            if !page.has_more {
                break;
            }
            if page.next_key.is_empty() || page.next_key == after_key {
                return Err("云端快照分页没有前进".to_string());
            }
            after_key = page.next_key;
        }
        Ok(output)
    }

    async fn fetch_entity(
        &self,
        gateway_url: &str,
        token: &str,
        entity_type: &str,
        entity_key: &str,
    ) -> Result<Option<SyncEntity>, String> {
        let mut url = Url::parse(&join_url(gateway_url, "v1/sync/entity"))
            .map_err(|error| error.to_string())?;
        url.query_pairs_mut()
            .append_pair("entity_type", entity_type)
            .append_pair("entity_key", entity_key);
        let response = self
            .client
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| {
                format!(
                    "读取云端冲突实体失败：{}",
                    clean_network_error(&error.to_string())
                )
            })?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        if !status.is_success() {
            return Err(response_error(
                "读取云端冲突实体失败",
                status.as_u16(),
                &bytes,
            ));
        }
        serde_json::from_slice::<EntityResponse>(&bytes)
            .map(|value| value.entity)
            .map_err(|error| format!("云端冲突实体格式无效：{error}"))
    }

    async fn remote_latest_sequence(
        &self,
        gateway_url: &str,
        token: &str,
        after: i64,
    ) -> Result<i64, String> {
        let mut url = Url::parse(&join_url(gateway_url, "v1/sync/pull"))
            .map_err(|error| error.to_string())?;
        url.query_pairs_mut()
            .append_pair("after", &after.to_string())
            .append_pair("limit", "1");
        let response = self
            .client
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| {
                format!(
                    "读取云端序列失败：{}",
                    clean_network_error(&error.to_string())
                )
            })?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        if !status.is_success() {
            return Err(response_error("读取云端序列失败", status.as_u16(), &bytes));
        }
        let payload: PullResponse =
            serde_json::from_slice(&bytes).map_err(|error| format!("云端序列格式无效：{error}"))?;
        Ok(payload.latest_sequence)
    }

    async fn push_outbox(
        &self,
        database_path: &Path,
        gateway_url: &str,
        credential: &StoredDeviceCredential,
    ) -> Result<CloudSyncReport, String> {
        let mut report = CloudSyncReport {
            pushed: 0,
            pulled: 0,
            deleted: 0,
            conflicts: 0,
            latest_remote_sequence: 0,
            has_more: false,
        };
        loop {
            let rows = {
                let connection = open(database_path)?;
                let mut statement = connection.prepare(
                    "SELECT operation_id,entity_type,entity_key,action,restore,base_version,payload_json,occurred_at
                     FROM cloud_sync_outbox WHERE status IN ('pending','retry')
                     ORDER BY CASE
                       WHEN action='upsert' AND entity_type='input_source' THEN 10
                       WHEN action='upsert' AND entity_type='content_run' THEN 15
                       WHEN action='upsert' AND entity_type IN ('tool_source_binding','telegram_checkpoint','telegram_read_state') THEN 20
                       WHEN action='upsert' AND entity_type='content_result' THEN 25
                       WHEN action='upsert' AND entity_type='telegram_message' THEN 30
                       WHEN action='upsert' AND entity_type='telegram_tool_queue' THEN 40
                       WHEN action='upsert' AND entity_type='task_inbox' THEN 45
                       WHEN action='delete' AND entity_type='task_inbox' THEN 48
                       WHEN action='delete' AND entity_type='telegram_tool_queue' THEN 50
                       WHEN action='delete' AND entity_type='telegram_message' THEN 60
                       WHEN action='delete' AND entity_type='content_result' THEN 65
                       WHEN action='delete' AND entity_type IN ('tool_source_binding','telegram_checkpoint','telegram_read_state') THEN 70
                       WHEN action='delete' AND entity_type='content_run' THEN 75
                       WHEN action='delete' AND entity_type='input_source' THEN 80
                       ELSE 25 END, created_at
                     LIMIT 200",
                ).map_err(|error| error.to_string())?;
                let raw_rows = statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, String>(6)?,
                            row.get::<_, String>(7)?,
                        ))
                    })
                    .map_err(|error| error.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| error.to_string())?;
                let operations = raw_rows.into_iter().map(|(operation_id, entity_type, entity_key, action, restore, base_version, raw, occurred_at)| {
                    let payload = if raw.is_empty() { serde_json::Value::Null } else { serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null) };
                    serde_json::json!({
                        "schemaVersion":1,"operationId":operation_id,"nodeId":credential.node_id,
                        "entityType":entity_type,"entityKey":entity_key,"action":action,
                        "restore":restore != 0,"baseVersion":base_version,"recordVersion":0,"occurredAt":occurred_at,"payload":payload,
                    })
                }).collect::<Vec<_>>();
                limit_push_batch(operations)?
            };
            if rows.is_empty() {
                break;
            }
            let response = self
                .client
                .post(join_url(gateway_url, "v1/sync/push"))
                .bearer_auth(&credential.device_token)
                .json(&serde_json::json!({"schemaVersion":1,"operations":rows}))
                .send()
                .await
                .map_err(|error| {
                    format!(
                        "上传同步数据失败：{}",
                        clean_network_error(&error.to_string())
                    )
                })?;
            let status = response.status();
            let bytes = response.bytes().await.map_err(|error| error.to_string())?;
            if !status.is_success() {
                return Err(response_error("上传同步数据失败", status.as_u16(), &bytes));
            }
            let pushed: PushResponse = serde_json::from_slice(&bytes)
                .map_err(|error| format!("同步上传结果格式无效：{error}"))?;
            let connection = open(database_path)?;
            let transaction = connection
                .unchecked_transaction()
                .map_err(|error| error.to_string())?;
            let now = Utc::now().to_rfc3339();
            for accepted in pushed.accepted {
                let outbox: Option<(String, String, String, String)> = transaction.query_row(
                    "SELECT entity_type,entity_key,action,payload_json FROM cloud_sync_outbox WHERE operation_id=?1",
                    params![accepted.operation_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
                ).optional().map_err(|error| error.to_string())?;
                if let Some((entity_type, entity_key, action, payload_json)) = outbox {
                    transaction.execute("UPDATE cloud_sync_outbox SET status='sent',last_error='',updated_at=?2 WHERE operation_id=?1", params![accepted.operation_id, now]).map_err(|error| error.to_string())?;
                    transaction.execute(
                        "INSERT INTO cloud_sync_entities(entity_type,entity_key,record_version,payload_hash,tombstone,updated_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(entity_type,entity_key) DO UPDATE SET record_version=excluded.record_version,payload_hash=excluded.payload_hash,tombstone=excluded.tombstone,updated_at=excluded.updated_at",
                        params![entity_type, entity_key, accepted.record_version, if action == "delete" { String::new() } else { hash_text(&payload_json) }, if action == "delete" { 1 } else { 0 }, now],
                    ).map_err(|error| error.to_string())?;
                    report.pushed += 1;
                }
            }
            for rejected in pushed.rejected {
                let outbox: Option<(String, String, String)> = transaction.query_row(
                    "SELECT entity_type,entity_key,payload_json FROM cloud_sync_outbox WHERE operation_id=?1",
                    params![rejected.operation_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
                ).optional().map_err(|error| error.to_string())?;
                if let Some((entity_type, entity_key, local_json)) = outbox {
                    transaction.execute("UPDATE cloud_sync_outbox SET status='conflict',attempt_count=attempt_count+1,last_error=?2,updated_at=?3 WHERE operation_id=?1", params![rejected.operation_id, rejected.reason, now]).map_err(|error| error.to_string())?;
                    transaction.execute("INSERT INTO cloud_sync_conflicts(operation_id,entity_type,entity_key,reason,local_json,created_at) VALUES(?1,?2,?3,?4,?5,?6)", params![rejected.operation_id,entity_type,entity_key,rejected.reason,local_json,now]).map_err(|error| error.to_string())?;
                    report.conflicts += 1;
                }
            }
            transaction.execute("UPDATE cloud_sync_state SET last_push_at=?1,last_error='',updated_at=?1 WHERE singleton=1", params![now]).map_err(|error| error.to_string())?;
            transaction.commit().map_err(|error| error.to_string())?;
            report.latest_remote_sequence = pushed.latest_sequence;
        }
        Ok(report)
    }

    async fn pull_once(
        &self,
        database_path: &Path,
        gateway_url: &str,
        credential: &StoredDeviceCredential,
    ) -> Result<CloudSyncReport, String> {
        let status = self.status(database_path)?;
        let mut url = Url::parse(&join_url(gateway_url, "v1/sync/pull"))
            .map_err(|error| error.to_string())?;
        url.query_pairs_mut()
            .append_pair("after", &status.last_pulled_sequence.to_string())
            .append_pair("limit", "200");
        let response = self
            .client
            .get(url)
            .bearer_auth(&credential.device_token)
            .send()
            .await
            .map_err(|error| {
                format!(
                    "下载同步数据失败：{}",
                    clean_network_error(&error.to_string())
                )
            })?;
        let http_status = response.status();
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        if !http_status.is_success() {
            return Err(response_error(
                "下载同步数据失败",
                http_status.as_u16(),
                &bytes,
            ));
        }
        let pulled: PullResponse = serde_json::from_slice(&bytes)
            .map_err(|error| format!("同步下载结果格式无效：{error}"))?;
        let mut previous_sequence = status.last_pulled_sequence;
        for operation in &pulled.operations {
            if operation.sequence <= previous_sequence || operation.node_id.is_empty() {
                return Err("云端同步序列无效或来源节点缺失".to_string());
            }
            previous_sequence = operation.sequence;
        }
        let mut operations = pulled.operations;
        operations.sort_by_key(sync_apply_priority);
        let mut connection = open(database_path)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let now = Utc::now().to_rfc3339();
        let mut report = CloudSyncReport {
            pushed: 0,
            pulled: 0,
            deleted: 0,
            conflicts: 0,
            latest_remote_sequence: pulled.latest_sequence,
            has_more: pulled.has_more,
        };
        for operation in operations {
            let pending: Option<String> = transaction.query_row(
                "SELECT payload_json FROM cloud_sync_outbox WHERE entity_type=?1 AND entity_key=?2 AND status IN ('pending','retry') ORDER BY created_at DESC LIMIT 1",
                params![operation.entity_type, operation.entity_key], |row| row.get(0),
            ).optional().map_err(|error| error.to_string())?;
            if let Some(local_json) = pending {
                transaction.execute(
                    "INSERT INTO cloud_sync_conflicts(operation_id,entity_type,entity_key,reason,local_json,remote_json,created_at) VALUES(?1,?2,?3,'local_pending',?4,?5,?6)",
                    params![operation.operation_id,operation.entity_type,operation.entity_key,local_json,serde_json::to_string(&operation.payload).unwrap_or_default(),now],
                ).map_err(|error| error.to_string())?;
                report.conflicts += 1;
            } else {
                let changed = apply_business_entity(&transaction, &operation)?;
                if changed {
                    report.pulled += 1;
                }
                if operation.action == "delete" && changed {
                    report.deleted += 1;
                }
                transaction.execute(
                    "INSERT INTO cloud_sync_entities(entity_type,entity_key,record_version,payload_hash,tombstone,updated_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(entity_type,entity_key) DO UPDATE SET record_version=excluded.record_version,payload_hash=excluded.payload_hash,tombstone=excluded.tombstone,updated_at=excluded.updated_at",
                    params![operation.entity_type,operation.entity_key,operation.record_version,operation.payload.as_ref().map(stable_json).map(|value|hash_text(&value)).unwrap_or_default(),if operation.action=="delete"{1}else{0},operation.occurred_at],
                ).map_err(|error| error.to_string())?;
            }
        }
        transaction.execute("UPDATE cloud_sync_state SET last_pulled_sequence=?1,last_remote_sequence=?2,last_pull_at=?3,last_error='',updated_at=?3 WHERE singleton=1", params![pulled.next_sequence,pulled.latest_sequence,now]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(report)
    }

    pub fn disconnect(&self, database_path: &Path) -> Result<CloudSyncStatus, String> {
        if self.credential_path.is_file() {
            std::fs::remove_file(&self.credential_path)
                .map_err(|error| format!("删除本机同步凭据失败：{error}"))?;
        }
        let now = Utc::now().to_rfc3339();
        open(database_path)?
            .execute(
                "UPDATE cloud_sync_state SET last_error='',updated_at=?1 WHERE singleton=1",
                params![now],
            )
            .map_err(|error| error.to_string())?;
        self.status(database_path)
    }

    fn write_credential(&self, credential: &StoredDeviceCredential) -> Result<(), String> {
        let plain = serde_json::to_vec(credential)
            .map_err(|error| format!("序列化同步凭据失败：{error}"))?;
        let encrypted = protect_data(&plain)?;
        let temp = self.credential_path.with_extension("bin.tmp");
        std::fs::write(&temp, encrypted).map_err(|error| format!("写入同步凭据失败：{error}"))?;
        std::fs::rename(&temp, &self.credential_path)
            .map_err(|error| format!("保存同步凭据失败：{error}"))
    }

    fn read_credential(&self) -> Result<StoredDeviceCredential, String> {
        let encrypted = std::fs::read(&self.credential_path)
            .map_err(|error| format!("读取本机同步凭据失败：{error}"))?;
        let plain = unprotect_data(&encrypted)?;
        let credential: StoredDeviceCredential = serde_json::from_slice(&plain)
            .map_err(|error| format!("解析本机同步凭据失败：{error}"))?;
        if credential.version != CREDENTIAL_VERSION
            || credential.node_id.is_empty()
            || credential.device_token.len() < 20
        {
            return Err("本机同步凭据无效".to_string());
        }
        Ok(credential)
    }
}

fn collect_local_entities(path: &Path) -> Result<HashMap<String, SyncEntity>, String> {
    let connection = open(path)?;
    let mut output = HashMap::new();
    let mut runs = HashMap::<i64, String>::new();
    {
        let mut statement = connection.prepare("SELECT id,tool,name,input_kind,original_input,start_at,end_at,status,options_json,total_count,result_count,error_count,created_at,updated_at FROM content_runs").map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, String>(12)?,
                    row.get::<_, String>(13)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (
                id,
                tool,
                name,
                input_kind,
                original_input,
                start_at,
                end_at,
                status,
                options_raw,
                total_count,
                result_count,
                error_count,
                created_at,
                updated_at,
            ) = row.map_err(|error| error.to_string())?;
            let options = safe_metadata(parse_json(&options_raw, serde_json::json!({})));
            let global_id = run_global_id(id, &tool, &created_at, &options);
            runs.insert(id, global_id.clone());
            let (original_input, original_input_truncated) =
                limited_text(&original_input, 64 * 1024);
            let payload = serde_json::json!({
                "globalId":global_id,"tool":tool,"name":name,"inputKind":input_kind,"originalInput":original_input,"originalInputTruncated":original_input_truncated,
                "startAt":start_at,"endAt":end_at,"status":status,"options":options,"totalCount":total_count,"resultCount":result_count,"errorCount":error_count,
                "createdAt":created_at,"updatedAt":updated_at
            });
            insert_entity(
                &mut output,
                "content_run",
                format!("run:{}", text(&payload, "globalId").to_lowercase()),
                payload,
            );
        }
    }
    {
        let mut statement = connection.prepare("SELECT run_id,tool,result_key,primary_value,secondary_value,status,tags_json,error,source,metadata_json,created_at,updated_at FROM content_results").map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (
                run_id,
                tool,
                result_key,
                primary_value,
                secondary_value,
                status,
                tags_raw,
                error,
                source,
                metadata_raw,
                created_at,
                updated_at,
            ) = row.map_err(|error| error.to_string())?;
            let Some(run_key) = runs.get(&run_id) else {
                continue;
            };
            let payload = serde_json::json!({
                "runKey":run_key,"tool":tool,"resultKey":result_key,"primaryValue":primary_value,"secondaryValue":secondary_value,"status":status,
                "tags":parse_json(&tags_raw,serde_json::json!([])),"error":error,"source":source,"metadata":safe_metadata(parse_json(&metadata_raw,serde_json::json!({}))),
                "createdAt":created_at,"updatedAt":updated_at
            });
            insert_entity(
                &mut output,
                "content_result",
                format!(
                    "result:{}:{}",
                    run_key.to_lowercase(),
                    result_key.to_lowercase()
                ),
                payload,
            );
        }
    }
    {
        let mut statement = connection.prepare("SELECT tool,record_key,primary_value,secondary_value,status,tags_json,actress_tags_json,genre_tags_json,source_url,missav_url,av123_url,raindrop_remote_id,raindrop_collection_id,metadata_json,created_at,updated_at FROM permanent_records").map_err(|error| error.to_string())?;
        let rows = statement.query_map([], |row| Ok(serde_json::json!({
            "tool":row.get::<_,String>(0)?,"recordKey":row.get::<_,String>(1)?,"primaryValue":row.get::<_,String>(2)?,"secondaryValue":row.get::<_,String>(3)?,"status":row.get::<_,String>(4)?,
            "tags":parse_json(&row.get::<_,String>(5)?, serde_json::json!([])),"actressTags":parse_json(&row.get::<_,String>(6)?, serde_json::json!([])),"genreTags":parse_json(&row.get::<_,String>(7)?, serde_json::json!([])),
            "sourceUrl":row.get::<_,String>(8)?,"missavUrl":row.get::<_,String>(9)?,"av123Url":row.get::<_,String>(10)?,"raindropRemoteId":row.get::<_,Option<i64>>(11)?,"raindropCollectionId":row.get::<_,Option<i64>>(12)?,
            "metadata":safe_metadata(parse_json(&row.get::<_,String>(13)?,serde_json::json!({}))),"createdAt":row.get::<_,String>(14)?,"updatedAt":row.get::<_,String>(15)?
        }))).map_err(|error| error.to_string())?;
        for row in rows {
            let payload = row.map_err(|error| error.to_string())?;
            let key = format!(
                "record:{}:{}",
                text(&payload, "tool").to_lowercase(),
                text(&payload, "recordKey").to_lowercase()
            );
            insert_entity(&mut output, "permanent_record", key, payload);
        }
    }
    let mut sources = HashMap::<i64, (String, String, String)>::new();
    {
        let mut statement = connection.prepare("SELECT id,kind,external_id,name,source_type,enabled,metadata_json,created_at,updated_at,last_sync_at FROM input_sources").map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (
                id,
                local_kind,
                external_id,
                name,
                source_type,
                enabled,
                metadata_raw,
                created_at,
                updated_at,
                last_sync_at,
            ) = row.map_err(|error| error.to_string())?;
            let metadata = safe_metadata(parse_json(&metadata_raw, serde_json::json!({})));
            let kind = normalized_source_kind(&local_kind);
            let connection_id = metadata
                .get("connectionId")
                .and_then(|value| value.as_str())
                .unwrap_or("default")
                .to_lowercase();
            let source_key = format!(
                "{}:{}:{}",
                kind,
                if connection_id.is_empty() {
                    "default"
                } else {
                    &connection_id
                },
                external_id.to_lowercase()
            );
            sources.insert(id, (source_key.clone(), kind.clone(), external_id.clone()));
            let payload = serde_json::json!({"sourceKey":source_key,"kind":kind,"connectionId":connection_id,"externalKey":external_id,"externalChatId":external_id,"name":name,"sourceType":source_type,"enabled":enabled!=0,"metadata":metadata,"lastSyncAt":last_sync_at,"createdAt":created_at,"updatedAt":updated_at});
            insert_entity(
                &mut output,
                "input_source",
                format!("source:{source_key}"),
                payload,
            );
        }
    }
    {
        let mut statement = connection
            .prepare("SELECT tool,source_id,created_at FROM tool_source_bindings")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (tool, source_id, created_at) = row.map_err(|error| error.to_string())?;
            if let Some((source_key, _, _)) = sources.get(&source_id) {
                let payload =
                    serde_json::json!({"sourceKey":source_key,"tool":tool,"createdAt":created_at});
                insert_entity(
                    &mut output,
                    "tool_source_binding",
                    format!("binding:{}:{}", source_key, tool.to_lowercase()),
                    payload,
                );
            }
        }
    }
    {
        let mut statement = connection.prepare("SELECT run_id,source_id,tool,stage,title,summary,error,created_at,updated_at FROM task_inbox").map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (run_id, source_id, tool, stage, title, summary, error, created_at, updated_at) =
                row.map_err(|error| error.to_string())?;
            let Some(run_key) = runs.get(&run_id) else {
                continue;
            };
            let source_key = source_id
                .and_then(|id| sources.get(&id).map(|value| value.0.clone()))
                .unwrap_or_default();
            let payload = serde_json::json!({"globalId":run_key,"runKey":run_key,"sourceKey":source_key,"tool":tool,"stage":stage,"title":title,"summary":summary,"error":error,"createdAt":created_at,"updatedAt":updated_at});
            insert_entity(
                &mut output,
                "task_inbox",
                format!("task:{}", run_key.to_lowercase()),
                payload,
            );
        }
    }
    {
        let mut statement = connection.prepare("SELECT source_id,message_id,message_date,message_text,content_hash,created_at,updated_at FROM telegram_messages").map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (source_id, message_id, message_date, body, content_hash, created_at, updated_at) =
                row.map_err(|error| error.to_string())?;
            if let Some((source_key, _, _)) = sources.get(&source_id) {
                let payload = serde_json::json!({"sourceKey":source_key,"messageId":message_id,"externalMessageId":message_id,"messageDate":message_date,"body":body,"eventKind":"message","contentHash":content_hash,"createdAt":created_at,"updatedAt":updated_at});
                insert_entity(
                    &mut output,
                    "telegram_message",
                    format!("message:{}:{}", source_key, message_id),
                    payload,
                );
            }
        }
    }
    {
        let mut statement = connection.prepare("SELECT source_id,message_id,tool,status,candidate_count,candidate_preview,run_id,error,processed_at,created_at,updated_at FROM telegram_tool_queue").map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (
                source_id,
                message_id,
                tool,
                status,
                candidate_count,
                candidate_preview,
                run_id,
                error,
                processed_at,
                created_at,
                updated_at,
            ) = row.map_err(|error| error.to_string())?;
            if let Some((source_key, _, _)) = sources.get(&source_id) {
                let run_key = run_id
                    .and_then(|id| runs.get(&id).cloned())
                    .unwrap_or_default();
                let payload = serde_json::json!({"sourceKey":source_key,"messageId":message_id,"tool":tool,"status":status,"candidateCount":candidate_count,"candidatePreview":candidate_preview,"runKey":run_key,"error":error,"processedAt":processed_at,"createdAt":created_at,"updatedAt":updated_at});
                insert_entity(
                    &mut output,
                    "telegram_tool_queue",
                    format!(
                        "queue:{}:{}:{}",
                        source_key,
                        message_id,
                        tool.to_lowercase()
                    ),
                    payload,
                );
            }
        }
    }
    {
        let mut statement = connection.prepare("SELECT id,checkpoint,continuation,metadata_json,updated_at FROM input_sources WHERE kind LIKE 'telegram_%'").map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (id, checkpoint, continuation, metadata_raw, updated_at) =
                row.map_err(|error| error.to_string())?;
            if let Some((source_key, _, _)) = sources.get(&id) {
                let metadata = parse_json(&metadata_raw, serde_json::json!({}));
                let checkpoint_payload = serde_json::json!({"sourceKey":source_key,"checkpoint":checkpoint,"continuation":continuation,"updatedAt":updated_at});
                insert_entity(
                    &mut output,
                    "telegram_checkpoint",
                    format!("checkpoint:{source_key}"),
                    checkpoint_payload,
                );
                let read_payload = serde_json::json!({"sourceKey":source_key,"policy":metadata.get("readPolicy").cloned().unwrap_or(serde_json::json!("never")),"safeReadMessageId":metadata.get("safeReadMessageId").cloned().unwrap_or(serde_json::json!("0")),"lastMarkedReadMessageId":metadata.get("lastMarkedReadMessageId").cloned().unwrap_or(serde_json::json!("0")),"readBaselineMessageId":metadata.get("readBaselineMessageId").cloned().unwrap_or(serde_json::json!("0")),"updatedAt":updated_at});
                insert_entity(
                    &mut output,
                    "telegram_read_state",
                    format!("read:{source_key}"),
                    read_payload,
                );
            }
        }
    }
    let settings = [
        ("missav.referenceActressTags", "missav.referenceTags"),
        (
            "missav.referenceActressTagBlacklist",
            "missav.referenceTagBlacklist",
        ),
        (
            "missav.raindropExportActressTagBlacklist",
            "missav.raindropExportBlacklist",
        ),
    ];
    for (local_key, sync_key) in settings {
        if let Some((raw, updated_at)) = connection
            .query_row(
                "SELECT value_json,updated_at FROM app_settings WHERE key=?1",
                params![local_key],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?
        {
            let payload = serde_json::json!({"key":sync_key,"value":parse_json(&raw,serde_json::json!([])),"updatedAt":updated_at});
            insert_entity(
                &mut output,
                "app_setting",
                format!("setting:{}", sync_key.to_lowercase()),
                payload,
            );
        }
    }
    Ok(output)
}

fn insert_entity(
    output: &mut HashMap<String, SyncEntity>,
    entity_type: &str,
    entity_key: String,
    payload: serde_json::Value,
) {
    output.insert(
        entity_key.clone(),
        SyncEntity {
            entity_type: entity_type.to_string(),
            entity_key,
            record_version: 0,
            tombstone: false,
            updated_at: text(&payload, "updatedAt"),
            payload: Some(payload),
        },
    );
}

fn run_global_id(id: i64, tool: &str, created_at: &str, options: &serde_json::Value) -> String {
    if let Some(value) = options
        .get("_syncGlobalId")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
    {
        return value.trim().to_lowercase();
    }
    hash_text(&format!(
        "desktop-v05:{id}:{}:{}",
        tool.to_lowercase(),
        created_at.trim()
    ))
}

fn limited_text(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_string(), false);
    }
    let mut end = max_bytes.min(value.len());
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_string(), true)
}

fn limit_push_batch(operations: Vec<serde_json::Value>) -> Result<Vec<serde_json::Value>, String> {
    const SAFE_BODY_BYTES: usize = 3_500_000;
    let mut output = Vec::new();
    let mut bytes = 64_usize;
    for operation in operations {
        let operation_bytes = serde_json::to_vec(&operation)
            .map_err(|error| error.to_string())?
            .len()
            + 1;
        if operation_bytes > SAFE_BODY_BYTES {
            return Err(format!(
                "单条同步数据超过安全上限：{}",
                text(&operation, "entityKey")
            ));
        }
        if !output.is_empty() && bytes + operation_bytes > SAFE_BODY_BYTES {
            break;
        }
        bytes += operation_bytes;
        output.push(operation);
    }
    Ok(output)
}

fn enqueue_local_changes(path: &Path, node_id: &str) -> Result<(), String> {
    let local = collect_local_entities(path)?;
    let mut connection = open(path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let mut tracked = HashMap::<String, (String, i64, String, bool)>::new();
    {
        let mut statement = transaction.prepare("SELECT entity_key,entity_type,record_version,payload_hash,tombstone FROM cloud_sync_entities").map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)? != 0,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (key, kind, version, hash, tombstone) = row.map_err(|error| error.to_string())?;
            tracked.insert(key, (kind, version, hash, tombstone));
        }
    }
    let now = Utc::now().to_rfc3339();
    for entity in local.values() {
        let payload = entity
            .payload
            .as_ref()
            .cloned()
            .unwrap_or(serde_json::json!({}));
        let payload_json = stable_json(&payload);
        let payload_hash = hash_text(&payload_json);
        let current = tracked.get(&entity.entity_key);
        if current
            .map(|value| !value.3 && value.2 == payload_hash)
            .unwrap_or(false)
        {
            continue;
        }
        transaction.execute("DELETE FROM cloud_sync_outbox WHERE entity_type=?1 AND entity_key=?2 AND status IN ('pending','retry')", params![entity.entity_type,entity.entity_key]).map_err(|error| error.to_string())?;
        transaction.execute(
            "INSERT INTO cloud_sync_outbox(operation_id,entity_type,entity_key,action,base_version,payload_json,occurred_at,created_at,updated_at) VALUES(?1,?2,?3,'upsert',?4,?5,?6,?6,?6)",
            params![new_id(&format!("op_{node_id}"))?,entity.entity_type,entity.entity_key,current.map(|value|value.1).unwrap_or(0),payload_json,now],
        ).map_err(|error| error.to_string())?;
    }
    let supported = [
        "permanent_record",
        "input_source",
        "tool_source_binding",
        "telegram_message",
        "telegram_tool_queue",
        "telegram_checkpoint",
        "telegram_read_state",
        "app_setting",
    ]
    .into_iter()
    .collect::<HashSet<_>>();
    for (key, (entity_type, version, _, tombstone)) in tracked {
        if !tombstone && supported.contains(entity_type.as_str()) && !local.contains_key(&key) {
            transaction.execute("DELETE FROM cloud_sync_outbox WHERE entity_type=?1 AND entity_key=?2 AND status IN ('pending','retry')", params![entity_type,key]).map_err(|error| error.to_string())?;
            transaction.execute(
                "INSERT INTO cloud_sync_outbox(operation_id,entity_type,entity_key,action,base_version,payload_json,occurred_at,created_at,updated_at) VALUES(?1,?2,?3,'delete',?4,'',?5,?5,?5)",
                params![new_id(&format!("op_{node_id}"))?,entity_type,key,version,now],
            ).map_err(|error| error.to_string())?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())
}

fn normalized_source_kind(value: &str) -> String {
    match value {
        "telegram_user" => "telegram_personal".to_string(),
        "telegram-bot" => "telegram_bot".to_string(),
        other => other.to_lowercase(),
    }
}

fn local_source_kind(value: &str) -> String {
    match value {
        "telegram_personal" => "telegram_user".to_string(),
        other => other.to_string(),
    }
}

fn parse_json(value: &str, fallback: serde_json::Value) -> serde_json::Value {
    serde_json::from_str(value).unwrap_or(fallback)
}
fn text(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|item| item.as_str())
        .unwrap_or_default()
        .to_string()
}
fn number(value: &serde_json::Value, key: &str) -> i64 {
    value
        .get(key)
        .and_then(|item| item.as_i64())
        .or_else(|| {
            value
                .get(key)
                .and_then(|item| item.as_str())
                .and_then(|item| item.parse().ok())
        })
        .unwrap_or(0)
}
fn optional_number(value: &serde_json::Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|item| {
        if item.is_null() {
            None
        } else {
            item.as_i64()
                .or_else(|| item.as_str().and_then(|item| item.parse().ok()))
        }
    })
}
fn bool_value(value: &serde_json::Value, key: &str) -> bool {
    value
        .get(key)
        .and_then(|item| item.as_bool())
        .unwrap_or(false)
}
fn json_field(value: &serde_json::Value, key: &str, fallback: serde_json::Value) -> String {
    stable_json(value.get(key).unwrap_or(&fallback))
}
fn nonempty(value: String, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_string()
    } else {
        value
    }
}

fn safe_metadata(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.into_iter()
                .filter(|(key, _)| {
                    let key = key.to_lowercase();
                    ![
                        "token",
                        "secret",
                        "api_hash",
                        "apihash",
                        "session",
                        "password",
                        "cookie",
                        "authorization",
                    ]
                    .iter()
                    .any(|part| key.contains(part))
                })
                .map(|(key, value)| (key, safe_metadata(value)))
                .collect(),
        ),
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.into_iter().map(safe_metadata).collect())
        }
        other => other,
    }
}

fn stable_json(value: &serde_json::Value) -> String {
    fn sorted(value: &serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Object(map) => {
                let mut ordered = BTreeMap::new();
                for (key, value) in map {
                    ordered.insert(key.clone(), sorted(value));
                }
                serde_json::to_value(ordered).unwrap_or(serde_json::json!({}))
            }
            serde_json::Value::Array(values) => {
                serde_json::Value::Array(values.iter().map(sorted).collect())
            }
            other => other.clone(),
        }
    }
    serde_json::to_string(&sorted(value)).unwrap_or_default()
}

fn hash_text(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn entity_hash(entity: &SyncEntity) -> String {
    if entity.tombstone {
        "tombstone".to_string()
    } else {
        entity
            .payload
            .as_ref()
            .map(stable_json)
            .map(|value| hash_text(&value))
            .unwrap_or_default()
    }
}
fn snapshot_hash(entities: &HashMap<String, SyncEntity>) -> String {
    let mut rows = entities
        .iter()
        .map(|(key, value)| format!("{}:{}", key, entity_hash(value)))
        .collect::<Vec<_>>();
    rows.sort();
    hash_text(&rows.join("\n"))
}
fn new_id(prefix: &str) -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|error| format!("生成同步 ID 失败：{error}"))?;
    Ok(format!(
        "{}_{}",
        prefix,
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}
fn response_error(label: &str, status: u16, bytes: &[u8]) -> String {
    let message = serde_json::from_slice::<ErrorResponse>(bytes)
        .ok()
        .and_then(|value| value.error)
        .unwrap_or_else(|| format!("HTTP {status}"));
    format!("{label}：{}", clean_network_error(&message))
}

fn sync_apply_priority(operation: &PullOperation) -> u8 {
    if operation.action == "delete" {
        match operation.entity_type.as_str() {
            "telegram_tool_queue" => 10,
            "task_inbox" => 12,
            "telegram_message" => 20,
            "content_result" => 22,
            "tool_source_binding" | "telegram_checkpoint" | "telegram_read_state" => 30,
            "content_run" => 35,
            "input_source" => 40,
            _ => 25,
        }
    } else {
        match operation.entity_type.as_str() {
            "input_source" => 10,
            "content_run" => 15,
            "tool_source_binding" | "telegram_checkpoint" | "telegram_read_state" => 20,
            "content_result" => 25,
            "telegram_message" => 30,
            "telegram_tool_queue" => 40,
            "task_inbox" => 45,
            _ => 15,
        }
    }
}

fn apply_business_entity(
    transaction: &rusqlite::Transaction<'_>,
    operation: &PullOperation,
) -> Result<bool, String> {
    let payload = operation.payload.as_ref();
    let deleted = operation.action == "delete";
    match operation.entity_type.as_str() {
        "content_run" => apply_content_run(transaction, operation),
        "content_result" => apply_content_result(transaction, operation),
        "permanent_record" => {
            if deleted {
                let parts = operation.entity_key.splitn(3, ':').collect::<Vec<_>>();
                if parts.len() != 3 {
                    return Err("永久记录实体键无效".to_string());
                }
                return transaction
                    .execute(
                        "DELETE FROM permanent_records WHERE tool=?1 AND lower(record_key)=?2",
                        params![parts[1], parts[2]],
                    )
                    .map(|count| count > 0)
                    .map_err(|error| error.to_string());
            }
            let value = payload.ok_or_else(|| "永久记录同步载荷为空".to_string())?;
            let now = Utc::now().to_rfc3339();
            transaction.execute(
                "INSERT INTO permanent_records(tool,record_key,primary_value,secondary_value,status,tags_json,actress_tags_json,genre_tags_json,source_url,missav_url,av123_url,raindrop_remote_id,raindrop_collection_id,metadata_json,created_at,updated_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
                 ON CONFLICT(tool,record_key) DO UPDATE SET primary_value=excluded.primary_value,secondary_value=excluded.secondary_value,status=excluded.status,tags_json=excluded.tags_json,actress_tags_json=excluded.actress_tags_json,genre_tags_json=excluded.genre_tags_json,source_url=excluded.source_url,missav_url=excluded.missav_url,av123_url=excluded.av123_url,raindrop_remote_id=excluded.raindrop_remote_id,raindrop_collection_id=excluded.raindrop_collection_id,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at",
                params![text(value,"tool"),text(value,"recordKey"),text(value,"primaryValue"),text(value,"secondaryValue"),text(value,"status"),json_field(value,"tags",serde_json::json!([])),json_field(value,"actressTags",serde_json::json!([])),json_field(value,"genreTags",serde_json::json!([])),text(value,"sourceUrl"),text(value,"missavUrl"),text(value,"av123Url"),optional_number(value,"raindropRemoteId"),optional_number(value,"raindropCollectionId"),json_field(value,"metadata",serde_json::json!({})),nonempty(text(value,"createdAt"),&now),nonempty(text(value,"updatedAt"),&now)],
            ).map_err(|error| error.to_string())?;
            Ok(true)
        }
        "input_source" => {
            if deleted {
                if let Some(id) = find_source_by_key(
                    transaction,
                    operation.entity_key.strip_prefix("source:").unwrap_or(""),
                )? {
                    return transaction
                        .execute("DELETE FROM input_sources WHERE id=?1", params![id])
                        .map(|count| count > 0)
                        .map_err(|error| error.to_string());
                }
                return Ok(false);
            }
            let value = payload.ok_or_else(|| "来源同步载荷为空".to_string())?;
            let kind = local_source_kind(&text(value, "kind"));
            let external_chat = text(value, "externalChatId");
            let external = if external_chat.is_empty() {
                text(value, "externalKey")
            } else {
                external_chat
            };
            let now = Utc::now().to_rfc3339();
            let mut metadata = value
                .get("metadata")
                .cloned()
                .unwrap_or(serde_json::json!({}));
            if let Some(object) = metadata.as_object_mut() {
                let connection_id = text(value, "connectionId");
                if !connection_id.is_empty() {
                    object.insert(
                        "connectionId".to_string(),
                        serde_json::Value::String(connection_id),
                    );
                }
                let username = text(value, "username");
                if !username.is_empty() {
                    object.insert("username".to_string(), serde_json::Value::String(username));
                }
            }
            transaction.execute(
                "INSERT INTO input_sources(kind,external_id,name,source_type,enabled,metadata_json,last_sync_at,created_at,updated_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
                 ON CONFLICT(kind,external_id) DO UPDATE SET name=excluded.name,source_type=excluded.source_type,enabled=excluded.enabled,metadata_json=excluded.metadata_json,last_sync_at=excluded.last_sync_at,updated_at=excluded.updated_at",
                params![kind,external,text(value,"name"),text(value,"sourceType"),bool_value(value,"enabled") as i64,stable_json(&safe_metadata(metadata)),text(value,"lastSyncAt"),nonempty(text(value,"createdAt"),&now),nonempty(text(value,"updatedAt"),&now)],
            ).map_err(|error| error.to_string())?;
            Ok(true)
        }
        "tool_source_binding" => {
            let (source_key, tool) = binding_parts(payload, &operation.entity_key)?;
            let Some(source_id) = find_source_by_key(transaction, &source_key)? else {
                return Err(format!("找不到绑定来源：{source_key}"));
            };
            if deleted {
                return transaction
                    .execute(
                        "DELETE FROM tool_source_bindings WHERE source_id=?1 AND tool=?2",
                        params![source_id, tool],
                    )
                    .map(|count| count > 0)
                    .map_err(|error| error.to_string());
            }
            transaction.execute(
                "INSERT OR IGNORE INTO tool_source_bindings(tool,source_id,created_at) VALUES(?1,?2,?3)",
                params![tool,source_id,payload.map(|value|text(value,"createdAt")).unwrap_or_else(||Utc::now().to_rfc3339())],
            ).map_err(|error| error.to_string())?;
            Ok(true)
        }
        "telegram_message" => apply_telegram_message(transaction, operation),
        "telegram_tool_queue" => apply_telegram_queue(transaction, operation),
        "telegram_checkpoint" => apply_telegram_checkpoint(transaction, operation),
        "telegram_read_state" => apply_telegram_read_state(transaction, operation),
        "task_inbox" => apply_task_inbox(transaction, operation),
        "app_setting" => apply_setting(transaction, operation),
        _ => Ok(false),
    }
}

fn find_run_by_global_id(
    transaction: &rusqlite::Transaction<'_>,
    global_id: &str,
) -> Result<Option<i64>, String> {
    let mut statement = transaction
        .prepare("SELECT id,tool,created_at,options_json FROM content_runs")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (id, tool, created_at, options_raw) = row.map_err(|error| error.to_string())?;
        let options = parse_json(&options_raw, serde_json::json!({}));
        if run_global_id(id, &tool, &created_at, &options) == global_id.to_lowercase() {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

fn apply_content_run(
    transaction: &rusqlite::Transaction<'_>,
    operation: &PullOperation,
) -> Result<bool, String> {
    let global_id = operation
        .payload
        .as_ref()
        .map(|value| text(value, "globalId"))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| operation.entity_key.trim_start_matches("run:").to_string())
        .to_lowercase();
    let current_id = find_run_by_global_id(transaction, &global_id)?;
    if operation.action == "delete" {
        return match current_id {
            Some(id) => transaction
                .execute("DELETE FROM content_runs WHERE id=?1", params![id])
                .map(|count| count > 0)
                .map_err(|error| error.to_string()),
            None => Ok(false),
        };
    }
    let value = operation
        .payload
        .as_ref()
        .ok_or_else(|| "处理历史同步载荷为空".to_string())?;
    let now = Utc::now().to_rfc3339();
    let mut options = value
        .get("options")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    if !options.is_object() {
        options = serde_json::json!({});
    }
    options.as_object_mut().unwrap().insert(
        "_syncGlobalId".to_string(),
        serde_json::Value::String(global_id),
    );
    let original_input = text(value, "originalInput");
    let truncated = bool_value(value, "originalInputTruncated");
    if let Some(id) = current_id {
        transaction.execute(
            "UPDATE content_runs SET tool=?1,name=?2,input_kind=?3,original_input=CASE WHEN ?4=1 AND original_input<>'' THEN original_input ELSE ?5 END,start_at=?6,end_at=?7,status=?8,options_json=?9,total_count=?10,result_count=?11,error_count=?12,updated_at=?13 WHERE id=?14",
            params![text(value,"tool"),text(value,"name"),text(value,"inputKind"),truncated as i64,original_input,text(value,"startAt"),text(value,"endAt"),text(value,"status"),stable_json(&safe_metadata(options)),number(value,"totalCount"),number(value,"resultCount"),number(value,"errorCount"),nonempty(text(value,"updatedAt"),&now),id],
        ).map_err(|error| error.to_string())?;
        return Ok(true);
    }
    transaction.execute(
        "INSERT INTO content_runs(tool,name,input_kind,original_input,start_at,end_at,status,options_json,total_count,result_count,error_count,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![text(value,"tool"),text(value,"name"),text(value,"inputKind"),original_input,text(value,"startAt"),text(value,"endAt"),text(value,"status"),stable_json(&safe_metadata(options)),number(value,"totalCount"),number(value,"resultCount"),number(value,"errorCount"),nonempty(text(value,"createdAt"),&now),nonempty(text(value,"updatedAt"),&now)],
    ).map_err(|error| error.to_string())?;
    Ok(true)
}

fn apply_content_result(
    transaction: &rusqlite::Transaction<'_>,
    operation: &PullOperation,
) -> Result<bool, String> {
    let value = operation.payload.as_ref();
    let (run_key, result_key) = if let Some(payload) = value {
        (
            text(payload, "runKey").to_lowercase(),
            text(payload, "resultKey"),
        )
    } else {
        let raw = operation.entity_key.trim_start_matches("result:");
        raw.split_once(':')
            .map(|(run, key)| (run.to_string(), key.to_string()))
            .ok_or_else(|| "处理结果实体键无效".to_string())?
    };
    let Some(run_id) = find_run_by_global_id(transaction, &run_key)? else {
        return Err(format!("找不到处理结果所属任务：{run_key}"));
    };
    if operation.action == "delete" {
        return transaction
            .execute(
                "DELETE FROM content_results WHERE run_id=?1 AND lower(result_key)=?2",
                params![run_id, result_key.to_lowercase()],
            )
            .map(|count| count > 0)
            .map_err(|error| error.to_string());
    }
    let value = value.ok_or_else(|| "处理结果同步载荷为空".to_string())?;
    let now = Utc::now().to_rfc3339();
    transaction.execute(
        "INSERT INTO content_results(run_id,tool,result_key,primary_value,secondary_value,status,tags_json,error,source,metadata_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT(run_id,result_key) DO UPDATE SET tool=excluded.tool,primary_value=excluded.primary_value,secondary_value=excluded.secondary_value,status=excluded.status,tags_json=excluded.tags_json,error=excluded.error,source=excluded.source,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at",
        params![run_id,text(value,"tool"),text(value,"resultKey"),text(value,"primaryValue"),text(value,"secondaryValue"),text(value,"status"),json_field(value,"tags",serde_json::json!([])),text(value,"error"),text(value,"source"),stable_json(&safe_metadata(value.get("metadata").cloned().unwrap_or(serde_json::json!({})))),nonempty(text(value,"createdAt"),&now),nonempty(text(value,"updatedAt"),&now)],
    ).map_err(|error| error.to_string())?;
    Ok(true)
}

fn apply_task_inbox(
    transaction: &rusqlite::Transaction<'_>,
    operation: &PullOperation,
) -> Result<bool, String> {
    let value = operation.payload.as_ref();
    let run_key = value
        .map(|payload| text(payload, "runKey"))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| operation.entity_key.trim_start_matches("task:").to_string())
        .to_lowercase();
    let Some(run_id) = find_run_by_global_id(transaction, &run_key)? else {
        return Err(format!("找不到处理中心任务所属历史：{run_key}"));
    };
    if operation.action == "delete" {
        return transaction
            .execute("DELETE FROM task_inbox WHERE run_id=?1", params![run_id])
            .map(|count| count > 0)
            .map_err(|error| error.to_string());
    }
    let value = value.ok_or_else(|| "处理中心任务同步载荷为空".to_string())?;
    let source_key = text(value, "sourceKey");
    let source_id = if source_key.is_empty() {
        None
    } else {
        find_source_by_key(transaction, &source_key)?
    };
    let now = Utc::now().to_rfc3339();
    transaction.execute(
        "INSERT INTO task_inbox(run_id,source_id,tool,stage,title,summary,error,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(run_id) DO UPDATE SET source_id=excluded.source_id,tool=excluded.tool,stage=excluded.stage,title=excluded.title,summary=excluded.summary,error=excluded.error,updated_at=excluded.updated_at",
        params![run_id,source_id,text(value,"tool"),text(value,"stage"),text(value,"title"),text(value,"summary"),text(value,"error"),nonempty(text(value,"createdAt"),&now),nonempty(text(value,"updatedAt"),&now)],
    ).map_err(|error| error.to_string())?;
    Ok(true)
}

fn find_source_by_key(
    transaction: &rusqlite::Transaction<'_>,
    source_key: &str,
) -> Result<Option<i64>, String> {
    let mut statement = transaction
        .prepare("SELECT id,kind,external_id,metadata_json FROM input_sources")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (id, kind, external, metadata) = row.map_err(|error| error.to_string())?;
        let metadata = parse_json(&metadata, serde_json::json!({}));
        let connection = metadata
            .get("connectionId")
            .and_then(|value| value.as_str())
            .unwrap_or("default")
            .to_lowercase();
        let key = format!(
            "{}:{}:{}",
            normalized_source_kind(&kind),
            if connection.is_empty() {
                "default"
            } else {
                &connection
            },
            external.to_lowercase()
        );
        if key == source_key {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

fn binding_parts(
    payload: Option<&serde_json::Value>,
    key: &str,
) -> Result<(String, String), String> {
    if let Some(value) = payload {
        return Ok((text(value, "sourceKey"), text(value, "tool")));
    }
    let raw = key.trim_start_matches("binding:");
    raw.rsplit_once(':')
        .map(|(source, tool)| (source.to_string(), tool.to_string()))
        .ok_or_else(|| "绑定实体键无效".to_string())
}

fn message_parts(
    payload: Option<&serde_json::Value>,
    key: &str,
    prefix: &str,
) -> Result<(String, i64), String> {
    if let Some(value) = payload {
        return Ok((text(value, "sourceKey"), number(value, "messageId")));
    }
    let raw = key.trim_start_matches(prefix);
    let (source, id) = raw
        .rsplit_once(':')
        .ok_or_else(|| "消息实体键无效".to_string())?;
    Ok((
        source.to_string(),
        id.parse().map_err(|_| "消息 ID 无效".to_string())?,
    ))
}

fn queue_parts(payload: Option<&serde_json::Value>, key: &str) -> Result<(String, String), String> {
    if let Some(value) = payload {
        return Ok((
            format!(
                "message:{}:{}",
                text(value, "sourceKey"),
                number(value, "messageId")
            ),
            text(value, "tool"),
        ));
    }
    let raw = key.trim_start_matches("queue:");
    let (message, tool) = raw
        .rsplit_once(':')
        .ok_or_else(|| "队列实体键无效".to_string())?;
    Ok((format!("message:{message}"), tool.to_string()))
}

fn apply_telegram_message(
    transaction: &rusqlite::Transaction<'_>,
    operation: &PullOperation,
) -> Result<bool, String> {
    let payload = operation.payload.as_ref();
    let (source_key, message_id) = message_parts(payload, &operation.entity_key, "message:")?;
    let Some(source_id) = find_source_by_key(transaction, &source_key)? else {
        return Err(format!("找不到消息来源：{source_key}"));
    };
    if operation.action == "delete" {
        return transaction
            .execute(
                "DELETE FROM telegram_messages WHERE source_id=?1 AND message_id=?2",
                params![source_id, message_id],
            )
            .map(|count| count > 0)
            .map_err(|error| error.to_string());
    }
    let value = payload.ok_or_else(|| "消息同步载荷为空".to_string())?;
    let now = Utc::now().to_rfc3339();
    transaction.execute(
        "INSERT INTO telegram_messages(source_id,message_id,message_date,message_text,content_hash,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(source_id,message_id) DO UPDATE SET message_date=excluded.message_date,message_text=excluded.message_text,content_hash=excluded.content_hash,updated_at=excluded.updated_at",
        params![source_id,message_id,text(value,"messageDate"),text(value,"body"),text(value,"contentHash"),nonempty(text(value,"createdAt"),&now),nonempty(text(value,"updatedAt"),&now)],
    ).map_err(|error| error.to_string())?;
    Ok(true)
}

fn apply_telegram_queue(
    transaction: &rusqlite::Transaction<'_>,
    operation: &PullOperation,
) -> Result<bool, String> {
    let payload = operation.payload.as_ref();
    let (message_key, tool) = queue_parts(payload, &operation.entity_key)?;
    let (source_key, message_id) = message_parts(None, &message_key, "message:")?;
    let Some(source_id) = find_source_by_key(transaction, &source_key)? else {
        return Err(format!("找不到队列来源：{source_key}"));
    };
    if operation.action == "delete" {
        return transaction
            .execute(
                "DELETE FROM telegram_tool_queue WHERE source_id=?1 AND message_id=?2 AND tool=?3",
                params![source_id, message_id, tool],
            )
            .map(|count| count > 0)
            .map_err(|error| error.to_string());
    }
    let value = payload.ok_or_else(|| "队列同步载荷为空".to_string())?;
    let exists: Option<i64> = transaction
        .query_row(
            "SELECT 1 FROM telegram_messages WHERE source_id=?1 AND message_id=?2",
            params![source_id, message_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if exists.is_none() {
        return Err("队列对应的 Telegram 消息尚未同步".to_string());
    }
    let run_key = text(value, "runKey");
    let run_id = if run_key.is_empty() {
        None
    } else {
        find_run_by_global_id(transaction, &run_key)?
    };
    let now = Utc::now().to_rfc3339();
    transaction.execute(
        "INSERT INTO telegram_tool_queue(source_id,message_id,tool,status,candidate_count,candidate_preview,run_id,error,processed_at,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
         ON CONFLICT(source_id,message_id,tool) DO UPDATE SET status=excluded.status,candidate_count=excluded.candidate_count,candidate_preview=excluded.candidate_preview,run_id=excluded.run_id,error=excluded.error,processed_at=excluded.processed_at,updated_at=excluded.updated_at",
        params![source_id,message_id,tool,text(value,"status"),number(value,"candidateCount"),text(value,"candidatePreview"),run_id,text(value,"error"),text(value,"processedAt"),nonempty(text(value,"createdAt"),&now),nonempty(text(value,"updatedAt"),&now)],
    ).map_err(|error| error.to_string())?;
    Ok(true)
}

fn apply_telegram_checkpoint(
    transaction: &rusqlite::Transaction<'_>,
    operation: &PullOperation,
) -> Result<bool, String> {
    if operation.action == "delete" {
        return Ok(false);
    }
    let value = operation
        .payload
        .as_ref()
        .ok_or_else(|| "检查点同步载荷为空".to_string())?;
    let source_key = nonempty(
        text(value, "sourceKey"),
        operation.entity_key.trim_start_matches("checkpoint:"),
    );
    let Some(source_id) = find_source_by_key(transaction, &source_key)? else {
        return Ok(false);
    };
    transaction
        .execute(
            "UPDATE input_sources SET checkpoint=?1,continuation=?2,updated_at=?3 WHERE id=?4",
            params![
                text(value, "checkpoint"),
                text(value, "continuation"),
                nonempty(text(value, "updatedAt"), &Utc::now().to_rfc3339()),
                source_id
            ],
        )
        .map(|count| count > 0)
        .map_err(|error| error.to_string())
}

fn apply_telegram_read_state(
    transaction: &rusqlite::Transaction<'_>,
    operation: &PullOperation,
) -> Result<bool, String> {
    if operation.action == "delete" {
        return Ok(false);
    }
    let value = operation
        .payload
        .as_ref()
        .ok_or_else(|| "已读状态同步载荷为空".to_string())?;
    let source_key = nonempty(
        text(value, "sourceKey"),
        operation.entity_key.trim_start_matches("read:"),
    );
    let Some(source_id) = find_source_by_key(transaction, &source_key)? else {
        return Ok(false);
    };
    let raw: String = transaction
        .query_row(
            "SELECT metadata_json FROM input_sources WHERE id=?1",
            params![source_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let mut metadata = parse_json(&raw, serde_json::json!({}));
    if let Some(object) = metadata.as_object_mut() {
        for (local, remote) in [
            ("readPolicy", "policy"),
            ("safeReadMessageId", "safeReadMessageId"),
            ("lastMarkedReadMessageId", "lastMarkedReadMessageId"),
            ("readBaselineMessageId", "readBaselineMessageId"),
        ] {
            object.insert(
                local.to_string(),
                value
                    .get(remote)
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            );
        }
    }
    transaction
        .execute(
            "UPDATE input_sources SET metadata_json=?1,updated_at=?2 WHERE id=?3",
            params![stable_json(&metadata), Utc::now().to_rfc3339(), source_id],
        )
        .map(|count| count > 0)
        .map_err(|error| error.to_string())
}

fn apply_setting(
    transaction: &rusqlite::Transaction<'_>,
    operation: &PullOperation,
) -> Result<bool, String> {
    let payload = operation.payload.as_ref();
    let key = payload
        .map(|value| text(value, "key"))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            operation
                .entity_key
                .trim_start_matches("setting:")
                .to_string()
        });
    let local_key = match key.as_str() {
        "missav.referenceTags" | "missav.referencetags" => "missav.referenceActressTags",
        "missav.referenceTagBlacklist" | "missav.referencetagblacklist" => {
            "missav.referenceActressTagBlacklist"
        }
        "missav.raindropExportBlacklist" | "missav.raindropexportblacklist" => {
            "missav.raindropExportActressTagBlacklist"
        }
        _ => return Ok(false),
    };
    if operation.action == "delete" {
        return transaction
            .execute("DELETE FROM app_settings WHERE key=?1", params![local_key])
            .map(|count| count > 0)
            .map_err(|error| error.to_string());
    }
    let value = payload.ok_or_else(|| "设置同步载荷为空".to_string())?;
    transaction.execute(
        "INSERT INTO app_settings(key,value_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
        params![local_key,json_field(value,"value",serde_json::json!([])),nonempty(text(value,"updatedAt"),&Utc::now().to_rfc3339())],
    ).map_err(|error| error.to_string())?;
    Ok(true)
}

fn open(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|error| format!("打开数据库失败：{error}"))?;
    connection
        .execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

fn normalize_gateway_url(value: &str) -> Result<String, String> {
    let mut url = Url::parse(value.trim()).map_err(|_| "同步网关地址无效".to_string())?;
    let is_loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if url.scheme() != "https" && !(url.scheme() == "http" && is_loopback) {
        return Err("正式同步网关必须使用 HTTPS；本机调试只允许 localhost".to_string());
    }
    if url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("同步网关地址不能包含账号、查询参数或片段".to_string());
    }
    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(&path);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn join_url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

fn normalize_pairing_code(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_uppercase())
        .collect()
}

fn new_node_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|error| format!("生成设备 ID 失败：{error}"))?;
    Ok(format!(
        "windows_{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn clean_network_error(value: &str) -> String {
    let lowered = value.to_lowercase();
    if lowered.contains("token") || lowered.contains("authorization") || lowered.contains("session")
    {
        "网络请求失败（敏感详情已隐藏）".to_string()
    } else {
        value.chars().take(500).collect()
    }
}

fn safe_lease_part(value: &str) -> String {
    value
        .trim()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .take(180)
        .collect::<String>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_requires_https_except_loopback() {
        assert!(normalize_gateway_url("https://sync.example.com/").is_ok());
        assert!(normalize_gateway_url("http://127.0.0.1:8787").is_ok());
        assert!(normalize_gateway_url("http://sync.example.com").is_err());
        assert!(normalize_gateway_url("https://name:password@sync.example.com").is_err());
    }

    #[test]
    fn pairing_code_is_normalized_without_ambiguous_separators() {
        assert_eq!(normalize_pairing_code("abcde-23456"), "ABCDE23456");
    }

    #[test]
    fn local_snapshot_uses_natural_keys_and_removes_secret_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("sync.sqlite");
        let connection = Connection::open(&path).unwrap();
        crate::workspace::initialize_schema(&connection).unwrap();
        connection.execute(
            "INSERT INTO input_sources(kind,external_id,name,source_type,enabled,metadata_json,created_at,updated_at) VALUES('telegram_user','-1001','测试群','channel',1,?1,'2026-01-01','2026-01-01')",
            params![serde_json::json!({"connectionId":"personal-main","apiHash":"must-not-sync","username":"demo"}).to_string()],
        ).unwrap();
        drop(connection);
        let entities = collect_local_entities(&path).unwrap();
        let source = entities
            .get("source:telegram_personal:personal-main:-1001")
            .unwrap();
        let serialized = stable_json(source.payload.as_ref().unwrap());
        assert!(!serialized.contains("must-not-sync"));
        assert!(serialized.contains("\"username\":\"demo\""));
        assert!(entities.contains_key("checkpoint:telegram_personal:personal-main:-1001"));
    }

    #[test]
    fn pulled_permanent_record_is_upserted_by_tool_and_record_key() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("sync.sqlite");
        let mut connection = Connection::open(&path).unwrap();
        crate::workspace::initialize_schema(&connection).unwrap();
        let transaction = connection.transaction().unwrap();
        let operation = PullOperation {
            sequence: 1,
            operation_id: "cloud-op".to_string(),
            node_id: "cloud".to_string(),
            entity_type: "permanent_record".to_string(),
            entity_key: "record:missav:abf-123".to_string(),
            action: "upsert".to_string(),
            record_version: 1,
            occurred_at: "2026-01-01T00:00:00Z".to_string(),
            payload: Some(
                serde_json::json!({"tool":"missav","recordKey":"ABF-123","primaryValue":"ABF-123","status":"ok","tags":["女优A"],"updatedAt":"2026-01-01T00:00:00Z"}),
            ),
        };
        assert!(apply_business_entity(&transaction, &operation).unwrap());
        transaction.commit().unwrap();
        let value: String = connection.query_row("SELECT tags_json FROM permanent_records WHERE tool='missav' AND record_key='ABF-123'", [], |row| row.get(0)).unwrap();
        assert_eq!(value, "[\"女优A\"]");
    }

    #[test]
    fn processing_history_results_and_task_round_trip_with_global_keys() {
        let source_directory = tempfile::tempdir().unwrap();
        let source_path = source_directory.path().join("source.sqlite");
        let connection = Connection::open(&source_path).unwrap();
        crate::workspace::initialize_schema(&connection).unwrap();
        drop(connection);
        crate::workspace::create_run(
            &source_path,
            crate::workspace::CreateRunInput {
                tool: "twitter".to_string(),
                name: "同步测试".to_string(),
                input_kind: "manual".to_string(),
                original_input: "#openai".to_string(),
                start_at: String::new(),
                end_at: String::new(),
                options: serde_json::json!({"mode":"test"}),
                results: vec![crate::workspace::ResultInput {
                    result_key: "openai".to_string(),
                    primary_value: "openai".to_string(),
                    secondary_value: "https://x.com/openai".to_string(),
                    status: "success".to_string(),
                    tags: vec![],
                    error: String::new(),
                    source: "manual".to_string(),
                    metadata: serde_json::json!({}),
                }],
            },
        )
        .unwrap();
        let entities = collect_local_entities(&source_path).unwrap();
        assert_eq!(
            entities
                .values()
                .filter(|value| value.entity_type == "content_run")
                .count(),
            1
        );
        assert_eq!(
            entities
                .values()
                .filter(|value| value.entity_type == "content_result")
                .count(),
            1
        );
        assert_eq!(
            entities
                .values()
                .filter(|value| value.entity_type == "task_inbox")
                .count(),
            1
        );

        let target_directory = tempfile::tempdir().unwrap();
        let target_path = target_directory.path().join("target.sqlite");
        let mut connection = Connection::open(&target_path).unwrap();
        crate::workspace::initialize_schema(&connection).unwrap();
        let transaction = connection.transaction().unwrap();
        let mut selected = entities
            .values()
            .filter(|entity| {
                matches!(
                    entity.entity_type.as_str(),
                    "content_run" | "content_result" | "task_inbox"
                )
            })
            .cloned()
            .collect::<Vec<_>>();
        selected.sort_by_key(|entity| match entity.entity_type.as_str() {
            "content_run" => 1,
            "content_result" => 2,
            _ => 3,
        });
        for (index, entity) in selected.into_iter().enumerate() {
            let operation = PullOperation {
                sequence: index as i64 + 1,
                operation_id: format!("cloud-{index}"),
                node_id: "cloud".to_string(),
                entity_type: entity.entity_type,
                entity_key: entity.entity_key,
                action: "upsert".to_string(),
                record_version: 1,
                occurred_at: "2026-01-01T00:00:00Z".to_string(),
                payload: entity.payload,
            };
            assert!(apply_business_entity(&transaction, &operation).unwrap());
        }
        transaction.commit().unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM content_runs", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM content_results", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM task_inbox", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let options: String = connection
            .query_row("SELECT options_json FROM content_runs", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(options.contains("_syncGlobalId"));
    }

    #[test]
    fn push_batches_stay_below_gateway_body_limit() {
        let operations = (0..100)
            .map(|index| {
                serde_json::json!({
                    "entityKey":format!("record:missav:{index}"),
                    "payload":{"text":"x".repeat(60_000)}
                })
            })
            .collect::<Vec<_>>();
        let batch = limit_push_batch(operations).unwrap();
        let body =
            serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"operations":batch})).unwrap();
        assert!(body.len() < 4 * 1024 * 1024);
        assert!(batch.len() < 100);
    }
}
