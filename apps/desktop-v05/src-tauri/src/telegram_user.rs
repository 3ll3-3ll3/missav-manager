use std::{ffi::c_void, path::{Path, PathBuf}, ptr, sync::Arc};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Utc};
use grammers_client::{
    client::{LoginToken as PhoneLoginToken, PasswordToken},
    peer::Peer,
    tl,
    Client, SignInError,
};
use grammers_mtsender::{ConnectionParams, SenderPool};
use grammers_session::{storages::SqliteSession, Session};
use serde::{Deserialize, Serialize};
use tokio::{sync::Mutex, task::JoinHandle};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCredentials {
    api_id: i32,
    api_hash: String,
    proxy_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthState {
    pub status: String,
    pub configured: bool,
    pub connected: bool,
    pub account_key: String,
    pub account_label: String,
    pub hint: String,
    pub qr_url: String,
    pub qr_expires_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramDialog {
    pub id: String,
    pub name: String,
    pub source_type: String,
    pub username: String,
    pub latest_message_id: i32,
    pub latest_message_date: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramSyncRequest {
    pub external_id: String,
    pub checkpoint: i32,
    pub limit: usize,
    pub start: String,
    pub end: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramMessage {
    pub id: i32,
    pub date: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramSyncResult {
    pub messages: Vec<TelegramMessage>,
    pub checkpoint: i32,
    pub has_more: bool,
}

struct Inner {
    credentials: Option<StoredCredentials>,
    session: Option<Arc<SqliteSession>>,
    client: Option<Client>,
    runner: Option<JoinHandle<()>>,
    phone_token: Option<PhoneLoginToken>,
    password_token: Option<PasswordToken>,
    account_key: String,
    account_label: String,
}

pub struct TelegramUserRuntime {
    session_path: PathBuf,
    credentials_path: PathBuf,
    inner: Mutex<Inner>,
}

impl TelegramUserRuntime {
    pub fn new(data_dir: &Path) -> Self {
        let credentials_path = data_dir.join("telegram-user-credentials-v05.bin");
        let credentials = read_credentials(&credentials_path).ok().flatten();
        Self {
            session_path: data_dir.join("telegram-user-session-v05.sqlite"),
            credentials_path,
            inner: Mutex::new(Inner {
                credentials,
                session: None,
                client: None,
                runner: None,
                phone_token: None,
                password_token: None,
                account_key: String::new(),
                account_label: String::new(),
            }),
        }
    }

    fn state(inner: &Inner, status: &str, hint: &str) -> AuthState {
        AuthState {
            status: status.to_string(),
            configured: inner.credentials.is_some(),
            connected: status == "ready",
            account_key: inner.account_key.clone(),
            account_label: inner.account_label.clone(),
            hint: hint.to_string(),
            qr_url: String::new(),
            qr_expires_at: 0,
        }
    }

    pub async fn status(&self) -> AuthState {
        let inner = self.inner.lock().await;
        let status = if inner.client.is_some() && !inner.account_key.is_empty() { "ready" } else { "disconnected" };
        Self::state(&inner, status, "")
    }

    async fn replace_client(&self, inner: &mut Inner, credentials: StoredCredentials) -> Result<(), String> {
        if let Some(client) = inner.client.take() { client.disconnect(); }
        if let Some(runner) = inner.runner.take() { runner.abort(); }
        inner.session = None;
        inner.phone_token = None;
        inner.password_token = None;
        inner.account_key.clear();
        inner.account_label.clear();

        let session = Arc::new(SqliteSession::open(&self.session_path).await.map_err(|error| format!("打开 Telegram 会话失败：{error}"))?);
        let mut params = ConnectionParams {
            app_version: "TG Content Toolbox 0.5.0".to_string(),
            device_model: "Windows Desktop".to_string(),
            system_lang_code: "zh-CN".to_string(),
            lang_code: "zh-CN".to_string(),
            ..Default::default()
        };
        params.proxy_url = normalize_socks_proxy(&credentials.proxy_url)?;
        let SenderPool { runner, handle, .. } = SenderPool::with_configuration(Arc::clone(&session), credentials.api_id, params);
        let client = Client::new(handle);
        let runner_task = tokio::spawn(async move { runner.run().await; });
        inner.credentials = Some(credentials);
        inner.session = Some(session);
        inner.client = Some(client);
        inner.runner = Some(runner_task);
        Ok(())
    }

    async fn prepare(&self, inner: &mut Inner, api_id: i32, api_hash: &str, proxy_url: &str) -> Result<Client, String> {
        validate_credentials(api_id, api_hash)?;
        let credentials = StoredCredentials { api_id, api_hash: api_hash.trim().to_string(), proxy_url: proxy_url.trim().to_string() };
        let replace = inner.client.is_none() || inner.credentials.as_ref().map(|saved| saved.api_id != credentials.api_id || saved.api_hash != credentials.api_hash || saved.proxy_url != credentials.proxy_url).unwrap_or(true);
        if replace { self.replace_client(inner, credentials).await?; }
        inner.client.clone().ok_or_else(|| "Telegram 客户端未初始化".to_string())
    }

    async fn finish_login(&self, inner: &mut Inner) -> Result<AuthState, String> {
        let client = inner.client.clone().ok_or_else(|| "Telegram 客户端未初始化".to_string())?;
        let me = client.get_me().await.map_err(clean_error)?;
        inner.account_key = me.id().to_string();
        let full_name = [me.first_name().unwrap_or_default(), me.last_name().unwrap_or_default()].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
        inner.account_label = if !full_name.is_empty() { full_name } else if let Some(username) = me.username() { format!("@{username}") } else { format!("Telegram {}", inner.account_key) };
        if let Some(credentials) = &inner.credentials { write_credentials(&self.credentials_path, credentials)?; }
        Ok(Self::state(inner, "ready", "登录状态已保存在当前 Windows 用户的数据目录中"))
    }

    pub async fn connect_saved(&self) -> Result<AuthState, String> {
        let mut inner = self.inner.lock().await;
        let credentials = inner.credentials.clone().or_else(|| read_credentials(&self.credentials_path).ok().flatten()).ok_or_else(|| "尚未保存 Telegram API 登录信息".to_string())?;
        let client = self.prepare(&mut inner, credentials.api_id, &credentials.api_hash, &credentials.proxy_url).await?;
        if !client.is_authorized().await.map_err(clean_error)? { return Ok(Self::state(&inner, "expired", "会话已失效，请重新扫码或使用手机号登录")); }
        self.finish_login(&mut inner).await
    }

    pub async fn start_phone(&self, api_id: i32, api_hash: String, phone: String, proxy_url: String) -> Result<AuthState, String> {
        let phone = phone.chars().filter(|character| !character.is_whitespace() && !['(', ')', '-'].contains(character)).collect::<String>();
        if !phone.starts_with('+') || phone.len() < 8 || !phone[1..].chars().all(|character| character.is_ascii_digit()) { return Err("手机号必须使用国际格式，例如 +8613800000000".to_string()); }
        let mut inner = self.inner.lock().await;
        let client = self.prepare(&mut inner, api_id, &api_hash, &proxy_url).await?;
        if client.is_authorized().await.map_err(clean_error)? { return self.finish_login(&mut inner).await; }
        let token = client.request_login_code(&phone, api_hash.trim()).await.map_err(clean_error)?;
        inner.phone_token = Some(token);
        Ok(Self::state(&inner, "waiting_code", "验证码通常发送到已登录的 Telegram 应用；请输入验证码"))
    }

    pub async fn submit_code(&self, code: String) -> Result<AuthState, String> {
        let mut inner = self.inner.lock().await;
        let client = inner.client.clone().ok_or_else(|| "请先开始手机号登录".to_string())?;
        let token = inner.phone_token.take().ok_or_else(|| "验证码登录步骤已过期，请重新发送验证码".to_string())?;
        match client.sign_in(&token, code.trim()).await {
            Ok(_) => self.finish_login(&mut inner).await,
            Err(SignInError::PasswordRequired(token)) => {
                let hint = token.hint().unwrap_or("请输入 Telegram 两步验证密码").to_string();
                inner.password_token = Some(token);
                Ok(Self::state(&inner, "waiting_password", &hint))
            }
            Err(SignInError::InvalidCode) => Err("验证码无效；请重新开始手机号登录后再试".to_string()),
            Err(error) => Err(clean_error(error)),
        }
    }

    pub async fn submit_password(&self, password: String) -> Result<AuthState, String> {
        let mut inner = self.inner.lock().await;
        let client = inner.client.clone().ok_or_else(|| "请先开始 Telegram 登录".to_string())?;
        let token = inner.password_token.take().ok_or_else(|| "当前没有等待两步验证密码".to_string())?;
        match client.check_password(token, password).await {
            Ok(_) => self.finish_login(&mut inner).await,
            Err(SignInError::InvalidPassword(token)) => {
                inner.password_token = Some(token);
                Err("两步验证密码不正确".to_string())
            }
            Err(error) => Err(clean_error(error)),
        }
    }

    pub async fn qr_step(&self, api_id: i32, api_hash: String, proxy_url: String) -> Result<AuthState, String> {
        let mut inner = self.inner.lock().await;
        let client = self.prepare(&mut inner, api_id, &api_hash, &proxy_url).await?;
        if client.is_authorized().await.map_err(clean_error)? { return self.finish_login(&mut inner).await; }
        let request = tl::functions::auth::ExportLoginToken { api_id, api_hash: api_hash.trim().to_string(), except_ids: Vec::new() };
        let result = client.invoke(&request).await.map_err(clean_error)?;
        let result = match result {
            tl::enums::auth::LoginToken::MigrateTo(migration) => {
                let session = inner.session.clone().ok_or_else(|| "Telegram 会话未初始化".to_string())?;
                session.set_home_dc_id(migration.dc_id).await.map_err(clean_error)?;
                client.invoke_in_dc(migration.dc_id, &tl::functions::auth::ImportLoginToken { token: migration.token }).await.map_err(clean_error)?
            }
            other => other,
        };
        match result {
            tl::enums::auth::LoginToken::Success(_) => self.finish_login(&mut inner).await,
            tl::enums::auth::LoginToken::Token(token) => Ok(AuthState {
                status: "waiting_qr".to_string(), configured: true, connected: false,
                account_key: String::new(), account_label: String::new(),
                hint: "请在 Telegram 手机端：设置 → 设备 → 连接桌面设备，扫描二维码".to_string(),
                qr_url: format!("tg://login?token={}", URL_SAFE_NO_PAD.encode(token.token)),
                qr_expires_at: i64::from(token.expires) * 1000,
            }),
            tl::enums::auth::LoginToken::MigrateTo(_) => Err("Telegram 二维码登录需要再次迁移数据中心，请刷新二维码重试".to_string()),
        }
    }

    async fn dialog_pairs(inner: &Inner, limit: usize) -> Result<Vec<(TelegramDialog, grammers_session::types::PeerRef)>, String> {
        let client = inner.client.clone().ok_or_else(|| "Telegram 个人账号尚未连接".to_string())?;
        if !client.is_authorized().await.map_err(clean_error)? { return Err("Telegram 会话已失效，请重新登录".to_string()); }
        let mut iterator = client.iter_dialogs().limit(limit.clamp(1, 1000));
        let mut output = Vec::new();
        while let Some(dialog) = iterator.next().await.map_err(clean_error)? {
            let (source_type, include) = match dialog.peer() {
                Peer::User(_) => ("user", false),
                Peer::Channel(_) => ("channel", true),
                Peer::Group(group) => {
                    let kind = if matches!(group.raw, tl::enums::Chat::Channel(_) | tl::enums::Chat::ChannelForbidden(_)) { "supergroup" } else { "group" };
                    (kind, true)
                }
            };
            if !include { continue; }
            let last = dialog.last_message.as_ref();
            output.push((TelegramDialog {
                id: dialog.peer_id().to_string(),
                name: dialog.peer().name().unwrap_or("未命名群组/频道").to_string(),
                source_type: source_type.to_string(),
                username: dialog.peer().username().unwrap_or_default().to_string(),
                latest_message_id: last.map(|message| message.id()).unwrap_or(0),
                latest_message_date: last.map(|message| message.date().to_rfc3339()).unwrap_or_default(),
            }, dialog.peer_ref()));
        }
        output.sort_by(|left, right| left.0.name.to_lowercase().cmp(&right.0.name.to_lowercase()));
        Ok(output)
    }

    pub async fn list_dialogs(&self, limit: usize) -> Result<Vec<TelegramDialog>, String> {
        let inner = self.inner.lock().await;
        Ok(Self::dialog_pairs(&inner, limit).await?.into_iter().map(|item| item.0).collect())
    }

    pub async fn sync_messages(&self, request: TelegramSyncRequest) -> Result<TelegramSyncResult, String> {
        let inner = self.inner.lock().await;
        let client = inner.client.clone().ok_or_else(|| "Telegram 个人账号尚未连接".to_string())?;
        let peer = Self::dialog_pairs(&inner, 1000).await?.into_iter().find(|item| item.0.id == request.external_id).map(|item| item.1).ok_or_else(|| "该群组/频道已退出或不可用；刷新来源后可删除旧绑定".to_string())?;
        let limit = request.limit.clamp(1, 20_000);
        let start = parse_time(&request.start)?;
        let end = parse_time(&request.end)?;
        let mut iterator = client.iter_messages(peer).limit(limit + 1);
        let mut messages = Vec::new();
        let mut checkpoint = request.checkpoint.max(0);
        let mut has_more = false;
        while let Some(message) = iterator.next().await.map_err(clean_error)? {
            let id = message.id();
            if request.checkpoint > 0 && id <= request.checkpoint { break; }
            let date = message.date();
            if let Some(end) = end { if date > end { continue; } }
            if let Some(start) = start { if date < start { break; } }
            if messages.len() >= limit { has_more = true; break; }
            checkpoint = checkpoint.max(id);
            let mut text = message.text().to_string();
            if let Some(entities) = message.fmt_entities() {
                for entity in entities {
                    if let tl::enums::MessageEntity::TextUrl(url) = entity {
                        if !text.contains(&url.url) { text.push('\n'); text.push_str(&url.url); }
                    }
                }
            }
            if !text.trim().is_empty() { messages.push(TelegramMessage { id, date: date.to_rfc3339(), text }); }
        }
        messages.sort_by_key(|message| message.id);
        Ok(TelegramSyncResult { messages, checkpoint, has_more })
    }

    pub async fn logout(&self) -> Result<AuthState, String> {
        let mut inner = self.inner.lock().await;
        if let Some(client) = inner.client.take() { let _ = client.sign_out().await; client.disconnect(); }
        if let Some(runner) = inner.runner.take() { runner.abort(); }
        inner.session = None; inner.credentials = None; inner.phone_token = None; inner.password_token = None;
        inner.account_key.clear(); inner.account_label.clear();
        if self.credentials_path.exists() { std::fs::remove_file(&self.credentials_path).map_err(clean_error)?; }
        if self.session_path.exists() { std::fs::remove_file(&self.session_path).map_err(clean_error)?; }
        Ok(Self::state(&inner, "disconnected", "已退出并删除本机 Telegram 会话"))
    }
}

fn parse_time(value: &str) -> Result<Option<DateTime<Utc>>, String> {
    if value.trim().is_empty() { return Ok(None); }
    DateTime::parse_from_rfc3339(value.trim()).map(|date| Some(date.with_timezone(&Utc))).map_err(|_| "Telegram 同步时间格式无效".to_string())
}

fn validate_credentials(api_id: i32, api_hash: &str) -> Result<(), String> {
    if api_id <= 0 { return Err("api_id 必须是正整数".to_string()); }
    let hash = api_hash.trim();
    if !(20..=128).contains(&hash.len()) || !hash.chars().all(|character| character.is_ascii_hexdigit()) { return Err("api_hash 格式无效".to_string()); }
    Ok(())
}

fn normalize_socks_proxy(value: &str) -> Result<Option<String>, String> {
    let value = value.trim();
    if value.is_empty() { return Ok(None); }
    let converted = if let Some(rest) = value.strip_prefix("http://") { format!("socks5://{rest}") } else if let Some(rest) = value.strip_prefix("https://") { format!("socks5://{rest}") } else if value.starts_with("socks5://") { value.to_string() } else { format!("socks5://{value}") };
    if !converted.contains(':') { return Err("Telegram 代理必须包含端口，例如 127.0.0.1:7890".to_string()); }
    Ok(Some(converted))
}

fn clean_error(error: impl std::fmt::Display) -> String {
    let mut text = error.to_string();
    for marker in ["api_hash", "phone_code_hash", "tg://login?token="] {
        if let Some(index) = text.to_lowercase().find(marker) { text.truncate(index); text.push_str("[凭据已隐藏]"); }
    }
    text.chars().take(1000).collect()
}

fn write_credentials(path: &Path, value: &StoredCredentials) -> Result<(), String> {
    let plain = serde_json::to_vec(value).map_err(clean_error)?;
    let encrypted = protect_data(&plain)?;
    std::fs::write(path, encrypted).map_err(clean_error)
}

fn read_credentials(path: &Path) -> Result<Option<StoredCredentials>, String> {
    if !path.exists() { return Ok(None); }
    let encrypted = std::fs::read(path).map_err(clean_error)?;
    let plain = unprotect_data(&encrypted)?;
    serde_json::from_slice(&plain).map(Some).map_err(clean_error)
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct DataBlob { cb_data: u32, pb_data: *mut u8 }

#[cfg(target_os = "windows")]
#[link(name = "Crypt32")]
unsafe extern "system" {
    fn CryptProtectData(data_in: *const DataBlob, description: *const u16, entropy: *const DataBlob, reserved: *mut c_void, prompt: *mut c_void, flags: u32, data_out: *mut DataBlob) -> i32;
    fn CryptUnprotectData(data_in: *const DataBlob, description: *mut *mut u16, entropy: *const DataBlob, reserved: *mut c_void, prompt: *mut c_void, flags: u32, data_out: *mut DataBlob) -> i32;
}

#[cfg(target_os = "windows")]
#[link(name = "Kernel32")]
unsafe extern "system" { fn LocalFree(memory: *mut c_void) -> *mut c_void; }

#[cfg(target_os = "windows")]
fn crypt_data(input: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    let input_blob = DataBlob { cb_data: input.len() as u32, pb_data: input.as_ptr() as *mut u8 };
    let mut output = DataBlob { cb_data: 0, pb_data: ptr::null_mut() };
    let ok = unsafe {
        if protect { CryptProtectData(&input_blob, ptr::null(), ptr::null(), ptr::null_mut(), ptr::null_mut(), 1, &mut output) }
        else { CryptUnprotectData(&input_blob, ptr::null_mut(), ptr::null(), ptr::null_mut(), ptr::null_mut(), 1, &mut output) }
    };
    if ok == 0 { return Err("Windows 凭据加密/解密失败".to_string()); }
    let result = unsafe { std::slice::from_raw_parts(output.pb_data, output.cb_data as usize).to_vec() };
    unsafe { LocalFree(output.pb_data as *mut c_void); }
    Ok(result)
}

#[cfg(target_os = "windows")]
fn protect_data(input: &[u8]) -> Result<Vec<u8>, String> { crypt_data(input, true) }
#[cfg(target_os = "windows")]
fn unprotect_data(input: &[u8]) -> Result<Vec<u8>, String> { crypt_data(input, false) }

#[cfg(not(target_os = "windows"))]
fn protect_data(_input: &[u8]) -> Result<Vec<u8>, String> { Err("Telegram 凭据加密仅支持 Windows".to_string()) }
#[cfg(not(target_os = "windows"))]
fn unprotect_data(_input: &[u8]) -> Result<Vec<u8>, String> { Err("Telegram 凭据解密仅支持 Windows".to_string()) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_uses_clash_mixed_port_as_socks5() {
        assert_eq!(normalize_socks_proxy("http://127.0.0.1:7890").unwrap(), Some("socks5://127.0.0.1:7890".to_string()));
        assert!(normalize_socks_proxy("").unwrap().is_none());
    }

    #[test]
    fn validates_api_credentials_without_exposing_them() {
        assert!(validate_credentials(12345, "0123456789abcdef0123456789abcdef").is_ok());
        assert!(validate_credentials(0, "bad").is_err());
    }
}
