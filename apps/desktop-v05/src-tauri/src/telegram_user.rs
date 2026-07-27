use std::{
    ffi::c_void,
    path::{Path, PathBuf},
    ptr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
        Mutex as StdMutex,
    },
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Utc};
use grammers_client::{
    client::{LoginToken as PhoneLoginToken, PasswordToken},
    peer::Peer,
    tl,
    Client, SignInError,
};
use grammers_mtsender::{ConnectionParams, SenderPool};
use grammers_session::{storages::SqliteSession, updates::UpdatesLike, Session};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tokio::{sync::{mpsc::UnboundedReceiver, Mutex}, task::JoinHandle};

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
    updates: Option<UnboundedReceiver<UpdatesLike>>,
    phone_token: Option<PhoneLoginToken>,
    password_token: Option<PasswordToken>,
    qr_url: String,
    qr_expires_at: i64,
    account_key: String,
    account_label: String,
}

pub struct TelegramUserRuntime {
    session_path: PathBuf,
    credentials_path: PathBuf,
    inner: Mutex<Inner>,
    auth_view: RwLock<AuthState>,
    auth_task: StdMutex<Option<JoinHandle<()>>>,
    auth_generation: AtomicU64,
}

impl TelegramUserRuntime {
    pub fn new(data_dir: &Path) -> Self {
        let credentials_path = data_dir.join("telegram-user-credentials-v05.bin");
        let credentials = read_credentials(&credentials_path).ok().flatten();
        let configured = credentials.is_some();
        Self {
            session_path: data_dir.join("telegram-user-session-v05.sqlite"),
            credentials_path,
            inner: Mutex::new(Inner {
                credentials,
                session: None,
                client: None,
                runner: None,
                updates: None,
                phone_token: None,
                password_token: None,
                qr_url: String::new(),
                qr_expires_at: 0,
                account_key: String::new(),
                account_label: String::new(),
            }),
            auth_view: RwLock::new(AuthState {
                status: "disconnected".to_string(),
                configured,
                connected: false,
                account_key: String::new(),
                account_label: String::new(),
                hint: String::new(),
                qr_url: String::new(),
                qr_expires_at: 0,
            }),
            auth_task: StdMutex::new(None),
            auth_generation: AtomicU64::new(0),
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
            qr_url: if status == "waiting_qr" { inner.qr_url.clone() } else { String::new() },
            qr_expires_at: if status == "waiting_qr" { inner.qr_expires_at } else { 0 },
        }
    }

    fn publish(&self, state: AuthState) -> AuthState {
        *self.auth_view.write() = state.clone();
        state
    }

    fn view_with(&self, status: &str, hint: &str) -> AuthState {
        let current = self.auth_view.read();
        AuthState {
            status: status.to_string(),
            configured: current.configured,
            connected: status == "ready",
            account_key: current.account_key.clone(),
            account_label: current.account_label.clone(),
            hint: hint.to_string(),
            qr_url: if status == "waiting_qr" { current.qr_url.clone() } else { String::new() },
            qr_expires_at: if status == "waiting_qr" { current.qr_expires_at } else { 0 },
        }
    }

    fn publish_status(&self, status: &str, hint: &str) -> AuthState {
        let state = self.view_with(status, hint);
        self.publish(state)
    }

    fn publish_error(&self, error: impl std::fmt::Display) -> AuthState {
        let message = clean_error(error);
        let current = self.auth_view.read();
        let state = AuthState {
            status: "error".to_string(),
            configured: current.configured,
            connected: false,
            account_key: current.account_key.clone(),
            account_label: current.account_label.clone(),
            hint: message,
            qr_url: String::new(),
            qr_expires_at: 0,
        };
        drop(current);
        self.publish(state)
    }

    pub async fn status(&self) -> AuthState {
        self.auth_view.read().clone()
    }

    async fn replace_client(&self, inner: &mut Inner, credentials: StoredCredentials) -> Result<(), String> {
        if let Some(client) = inner.client.take() { client.disconnect(); }
        if let Some(runner) = inner.runner.take() { runner.abort(); }
        inner.session = None;
        inner.updates = None;
        inner.phone_token = None;
        inner.password_token = None;
        inner.qr_url.clear();
        inner.qr_expires_at = 0;
        inner.account_key.clear();
        inner.account_label.clear();

        self.publish_status("connecting", "正在初始化 Telegram 本机会话；此步骤超时后会自动解锁");
        let session = Arc::new(
            tokio::time::timeout(
                std::time::Duration::from_secs(8),
                SqliteSession::open(&self.session_path),
            )
            .await
            .map_err(|_| "初始化 Telegram 本机会话超时".to_string())?
            .map_err(|error| format!("打开 Telegram 会话失败：{error}"))?,
        );
        let mut params = ConnectionParams {
            app_version: "TG Content Toolbox 0.5.3".to_string(),
            device_model: "Windows Desktop".to_string(),
            system_lang_code: "zh-CN".to_string(),
            lang_code: "zh-CN".to_string(),
            ..Default::default()
        };
        params.proxy_url = normalize_socks_proxy(&credentials.proxy_url)?;
        let SenderPool { runner, handle, updates } = SenderPool::with_configuration(Arc::clone(&session), credentials.api_id, params);
        let client = Client::new(handle);
        let runner_task = tokio::spawn(async move { runner.run().await; });
        inner.credentials = Some(credentials);
        inner.session = Some(session);
        inner.client = Some(client);
        inner.runner = Some(runner_task);
        inner.updates = Some(updates);
        self.publish_status("connecting", "本机会话已就绪，正在通过 Clash 连接 Telegram");
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
        let me = tokio::time::timeout(std::time::Duration::from_secs(20), client.get_me())
            .await
            .map_err(|_| "读取 Telegram 账号信息超时".to_string())?
            .map_err(clean_error)?;
        inner.account_key = me.id().to_string();
        let full_name = [me.first_name().unwrap_or_default(), me.last_name().unwrap_or_default()].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
        inner.account_label = if !full_name.is_empty() { full_name } else if let Some(username) = me.username() { format!("@{username}") } else { format!("Telegram {}", inner.account_key) };
        if let Some(credentials) = &inner.credentials { write_credentials(&self.credentials_path, credentials)?; }
        Ok(self.publish(Self::state(inner, "ready", "登录状态已保存在当前 Windows 用户的数据目录中")))
    }

    fn replace_auth_task(&self, task: JoinHandle<()>) {
        let mut slot = self.auth_task.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(previous) = slot.take() { previous.abort(); }
        *slot = Some(task);
    }

    fn begin_generation(&self) -> u64 {
        let generation = self.auth_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let mut slot = self.auth_task.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(previous) = slot.take() { previous.abort(); }
        generation
    }

    pub fn begin_connect_saved(self: &Arc<Self>) -> Result<AuthState, String> {
        if !self.credentials_path.exists() {
            return Err("当前没有已保存的个人 API 会话；首次登录请使用二维码或手机号".to_string());
        }
        let generation = self.begin_generation();
        let state = self.publish(AuthState {
            status: "connecting".to_string(),
            configured: true,
            connected: false,
            account_key: String::new(),
            account_label: String::new(),
            hint: "正在恢复已保存的 Telegram 会话；可随时取消".to_string(),
            qr_url: String::new(),
            qr_expires_at: 0,
        });
        let runtime = Arc::clone(self);
        let task = tokio::spawn(async move {
            let result = runtime.connect_saved().await;
            if runtime.auth_generation.load(Ordering::SeqCst) != generation { return; }
            match result {
                Ok(next) => { runtime.publish(next); }
                Err(error) => { runtime.publish_error(error); }
            }
        });
        self.replace_auth_task(task);
        Ok(state)
    }

    pub fn begin_phone(self: &Arc<Self>, api_id: i32, api_hash: String, phone: String, proxy_url: String) -> Result<AuthState, String> {
        validate_credentials(api_id, &api_hash)?;
        normalize_socks_proxy(&proxy_url)?;
        let cleaned_phone = phone.chars().filter(|character| !character.is_whitespace() && !['(', ')', '-'].contains(character)).collect::<String>();
        if !cleaned_phone.starts_with('+') || cleaned_phone.len() < 8 || !cleaned_phone[1..].chars().all(|character| character.is_ascii_digit()) {
            return Err("手机号必须使用国际格式，例如 +8613800000000".to_string());
        }
        let generation = self.begin_generation();
        let state = self.publish(AuthState {
            status: "connecting".to_string(),
            configured: self.credentials_path.exists(),
            connected: false,
            account_key: String::new(),
            account_label: String::new(),
            hint: "正在连接 Telegram 并请求验证码；可随时取消".to_string(),
            qr_url: String::new(),
            qr_expires_at: 0,
        });
        let runtime = Arc::clone(self);
        let task = tokio::spawn(async move {
            let result = runtime.start_phone(api_id, api_hash, cleaned_phone, proxy_url).await;
            if runtime.auth_generation.load(Ordering::SeqCst) != generation { return; }
            match result {
                Ok(next) => { runtime.publish(next); }
                Err(error) => { runtime.publish_error(error); }
            }
        });
        self.replace_auth_task(task);
        Ok(state)
    }

    pub fn begin_qr(self: &Arc<Self>, api_id: i32, api_hash: String, proxy_url: String) -> Result<AuthState, String> {
        validate_credentials(api_id, &api_hash)?;
        normalize_socks_proxy(&proxy_url)?;
        let generation = self.begin_generation();
        let state = self.publish(AuthState {
            status: "connecting".to_string(),
            configured: self.credentials_path.exists(),
            connected: false,
            account_key: String::new(),
            account_label: String::new(),
            hint: "正在连接 Telegram 并生成二维码；可随时取消".to_string(),
            qr_url: String::new(),
            qr_expires_at: 0,
        });
        let runtime = Arc::clone(self);
        let task = tokio::spawn(async move {
            let result = runtime.start_qr(api_id, api_hash, proxy_url).await;
            if runtime.auth_generation.load(Ordering::SeqCst) != generation { return; }
            match result {
                Ok(next) => { runtime.publish(next); }
                Err(error) => { runtime.publish_error(error); }
            }
        });
        self.replace_auth_task(task);
        Ok(state)
    }

    pub async fn connect_saved(&self) -> Result<AuthState, String> {
        let mut inner = self.inner.lock().await;
        let credentials = inner.credentials.clone().or_else(|| read_credentials(&self.credentials_path).ok().flatten()).ok_or_else(|| "尚未保存 Telegram API 登录信息".to_string())?;
        let client = self.prepare(&mut inner, credentials.api_id, &credentials.api_hash, &credentials.proxy_url).await?;
        self.publish_status("connecting", "正在验证已保存的 Telegram 会话");
        let authorized = tokio::time::timeout(std::time::Duration::from_secs(20), client.is_authorized())
            .await
            .map_err(|_| "恢复 Telegram 会话超时；请检查 Clash 后重试".to_string())?
            .map_err(clean_error)?;
        if !authorized {
            return Ok(self.publish(Self::state(&inner, "expired", "会话已失效，请重新扫码或使用手机号登录")));
        }
        self.finish_login(&mut inner).await
    }

    pub async fn start_phone(&self, api_id: i32, api_hash: String, phone: String, proxy_url: String) -> Result<AuthState, String> {
        let phone = phone.chars().filter(|character| !character.is_whitespace() && !['(', ')', '-'].contains(character)).collect::<String>();
        if !phone.starts_with('+') || phone.len() < 8 || !phone[1..].chars().all(|character| character.is_ascii_digit()) { return Err("手机号必须使用国际格式，例如 +8613800000000".to_string()); }
        let mut inner = self.inner.lock().await;
        let client = self.prepare(&mut inner, api_id, &api_hash, &proxy_url).await?;
        inner.qr_url.clear();
        inner.qr_expires_at = 0;
        self.publish_status("connecting", "Telegram 网络已连接，正在检查账号状态");
        let authorized = tokio::time::timeout(std::time::Duration::from_secs(20), client.is_authorized())
            .await.map_err(|_| "Telegram 连接超时；请在设置中测试 Clash 代理后重试".to_string())?
            .map_err(clean_error)?;
        if authorized { return self.finish_login(&mut inner).await; }
        self.publish_status("connecting", "正在向 Telegram 请求登录验证码");
        let token = tokio::time::timeout(
            std::time::Duration::from_secs(25),
            client.request_login_code(&phone, api_hash.trim()),
        )
        .await
        .map_err(|_| "Telegram 发送验证码超时；请确认 Clash 代理可用".to_string())?
        .map_err(clean_error)?;
        inner.phone_token = Some(token);
        Ok(self.publish(Self::state(&inner, "waiting_code", "验证码通常发送到已登录的 Telegram 应用；请输入验证码")))
    }

    pub async fn submit_code(&self, code: String) -> Result<AuthState, String> {
        let mut inner = self.inner.lock().await;
        let client = inner.client.clone().ok_or_else(|| "请先开始手机号登录".to_string())?;
        let token = inner.phone_token.take().ok_or_else(|| "验证码登录步骤已过期，请重新发送验证码".to_string())?;
        self.publish_status("authorizing", "正在核对 Telegram 验证码");
        let sign_in = match tokio::time::timeout(std::time::Duration::from_secs(25), client.sign_in(&token, code.trim())).await {
            Ok(result) => result,
            Err(_) => {
                self.publish_error("提交 Telegram 验证码超时");
                return Err("提交 Telegram 验证码超时".to_string());
            }
        };
        match sign_in {
            Ok(_) => self.finish_login(&mut inner).await,
            Err(SignInError::PasswordRequired(token)) => {
                let hint = token.hint().unwrap_or("请输入 Telegram 两步验证密码").to_string();
                inner.password_token = Some(token);
                Ok(self.publish(Self::state(&inner, "waiting_password", &hint)))
            }
            Err(SignInError::InvalidCode) => {
                self.publish_error("验证码无效；请重新开始手机号登录后再试");
                Err("验证码无效；请重新开始手机号登录后再试".to_string())
            }
            Err(error) => {
                let message = clean_error(error);
                self.publish_error(&message);
                Err(message)
            }
        }
    }

    pub async fn submit_password(&self, password: String) -> Result<AuthState, String> {
        let mut inner = self.inner.lock().await;
        let client = inner.client.clone().ok_or_else(|| "请先开始 Telegram 登录".to_string())?;
        let token = inner.password_token.take().ok_or_else(|| "当前没有等待两步验证密码".to_string())?;
        self.publish_status("authorizing", "正在核对 Telegram 两步验证密码");
        let password_check = match tokio::time::timeout(std::time::Duration::from_secs(25), client.check_password(token, password)).await {
            Ok(result) => result,
            Err(_) => {
                self.publish_error("提交 Telegram 两步验证密码超时");
                return Err("提交 Telegram 两步验证密码超时".to_string());
            }
        };
        match password_check {
            Ok(_) => self.finish_login(&mut inner).await,
            Err(SignInError::InvalidPassword(token)) => {
                inner.password_token = Some(token);
                self.publish(Self::state(&inner, "waiting_password", "两步验证密码不正确，请重试"));
                Err("两步验证密码不正确".to_string())
            }
            Err(error) => {
                let message = clean_error(error);
                self.publish_error(&message);
                Err(message)
            }
        }
    }

    async fn export_qr_token(&self, inner: &mut Inner, api_id: i32, api_hash: &str) -> Result<AuthState, String> {
        let client = inner.client.clone().ok_or_else(|| "Telegram 客户端未初始化".to_string())?;
        let request = tl::functions::auth::ExportLoginToken { api_id, api_hash: api_hash.trim().to_string(), except_ids: Vec::new() };
        let result = tokio::time::timeout(std::time::Duration::from_secs(20), client.invoke(&request))
            .await.map_err(|_| "Telegram 二维码请求超时；请确认 Clash 代理可用".to_string())?
            .map_err(clean_error)?;
        let result = match result {
            tl::enums::auth::LoginToken::MigrateTo(migration) => {
                let session = inner.session.clone().ok_or_else(|| "Telegram 会话未初始化".to_string())?;
                session.set_home_dc_id(migration.dc_id).await.map_err(clean_error)?;
                tokio::time::timeout(
                    std::time::Duration::from_secs(20),
                    client.invoke_in_dc(migration.dc_id, &tl::functions::auth::ImportLoginToken { token: migration.token }),
                )
                .await
                .map_err(|_| "Telegram 二维码数据中心迁移超时".to_string())?
                .map_err(clean_error)?
            }
            other => other,
        };
        match result {
            tl::enums::auth::LoginToken::Success(_) => {
                inner.qr_url.clear();
                inner.qr_expires_at = 0;
                self.finish_login(inner).await
            }
            tl::enums::auth::LoginToken::Token(token) => {
                inner.qr_url = format!("tg://login?token={}", URL_SAFE_NO_PAD.encode(token.token));
                inner.qr_expires_at = i64::from(token.expires) * 1000;
                Ok(Self::state(inner, "waiting_qr", "请在 Telegram 手机端：设置 → 设备 → 连接桌面设备，扫描二维码；扫码后会自动确认"))
            }
            tl::enums::auth::LoginToken::MigrateTo(_) => Err("Telegram 二维码登录需要再次迁移数据中心，请刷新二维码重试".to_string()),
        }
    }

    pub async fn start_qr(&self, api_id: i32, api_hash: String, proxy_url: String) -> Result<AuthState, String> {
        let mut inner = self.inner.lock().await;
        let client = self.prepare(&mut inner, api_id, &api_hash, &proxy_url).await?;
        inner.phone_token = None;
        inner.password_token = None;
        self.publish_status("connecting", "Telegram 网络已连接，正在请求二维码");
        let authorized = tokio::time::timeout(std::time::Duration::from_secs(20), client.is_authorized())
            .await.map_err(|_| "Telegram 连接超时；请在设置中测试 Clash 代理后重试".to_string())?
            .map_err(clean_error)?;
        if authorized { return self.finish_login(&mut inner).await; }
        if let Some(updates) = inner.updates.as_mut() {
            while updates.try_recv().is_ok() {}
        }
        let state = self.export_qr_token(&mut inner, api_id, &api_hash).await?;
        Ok(self.publish(state))
    }

    pub async fn poll_qr(&self, confirm: bool) -> Result<AuthState, String> {
        let generation = self.auth_generation.load(Ordering::SeqCst);
        let mut inner = self.inner.lock().await;
        if inner.qr_url.is_empty() { return Err("当前没有进行中的二维码登录，请先生成二维码".to_string()); }
        let mut login_token_update = false;
        if let Some(updates) = inner.updates.as_mut() {
            while let Ok(update) = updates.try_recv() {
                if updates_contain_login_token(update) { login_token_update = true; }
            }
        }
        let credentials = inner.credentials.clone().ok_or_else(|| "Telegram API 信息已丢失，请重新生成二维码".to_string())?;
        let expiring = Utc::now().timestamp_millis() >= inner.qr_expires_at.saturating_sub(4_000);
        if confirm || login_token_update || expiring {
            let state = self.export_qr_token(&mut inner, credentials.api_id, &credentials.api_hash).await?;
            if self.auth_generation.load(Ordering::SeqCst) != generation {
                return Ok(self.auth_view.read().clone());
            }
            return Ok(self.publish(state));
        }
        if self.auth_generation.load(Ordering::SeqCst) != generation {
            return Ok(self.auth_view.read().clone());
        }
        Ok(self.publish(Self::state(&inner, "waiting_qr", "等待手机扫码；软件会自动检测并完成登录")))
    }

    pub fn cancel_auth(self: &Arc<Self>) -> AuthState {
        self.auth_generation.fetch_add(1, Ordering::SeqCst);
        let mut slot = self.auth_task.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(task) = slot.take() { task.abort(); }
        drop(slot);
        let state = self.publish(AuthState {
            status: "disconnected".to_string(),
            configured: self.credentials_path.exists(),
            connected: false,
            account_key: String::new(),
            account_label: String::new(),
            hint: "已取消当前登录流程，界面已解锁".to_string(),
            qr_url: String::new(),
            qr_expires_at: 0,
        });
        let runtime = Arc::clone(self);
        tokio::spawn(async move {
            let mut inner = runtime.inner.lock().await;
            inner.phone_token = None;
            inner.password_token = None;
            inner.qr_url.clear();
            inner.qr_expires_at = 0;
            if inner.account_key.is_empty() {
                if let Some(client) = inner.client.take() { client.disconnect(); }
                if let Some(runner) = inner.runner.take() { runner.abort(); }
                inner.session = None;
                inner.updates = None;
            }
        });
        state
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
        self.auth_generation.fetch_add(1, Ordering::SeqCst);
        {
            let mut slot = self.auth_task.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(task) = slot.take() { task.abort(); }
        }
        let mut inner = self.inner.lock().await;
        if let Some(client) = inner.client.take() { let _ = client.sign_out().await; client.disconnect(); }
        if let Some(runner) = inner.runner.take() { runner.abort(); }
        inner.session = None; inner.credentials = None; inner.updates = None; inner.phone_token = None; inner.password_token = None;
        inner.qr_url.clear(); inner.qr_expires_at = 0;
        inner.account_key.clear(); inner.account_label.clear();
        if self.credentials_path.exists() { std::fs::remove_file(&self.credentials_path).map_err(clean_error)?; }
        if self.session_path.exists() { std::fs::remove_file(&self.session_path).map_err(clean_error)?; }
        Ok(self.publish(Self::state(&inner, "disconnected", "已退出并删除本机 Telegram 会话")))
    }
}

fn updates_contain_login_token(update: UpdatesLike) -> bool {
    let contains = |updates: Vec<tl::enums::Update>| updates.into_iter().any(|item| matches!(item, tl::enums::Update::LoginToken));
    match update {
        UpdatesLike::Updates(tl::enums::Updates::UpdateShort(short)) => matches!(short.update, tl::enums::Update::LoginToken),
        UpdatesLike::Updates(tl::enums::Updates::Combined(combined)) => contains(combined.updates),
        UpdatesLike::Updates(tl::enums::Updates::Updates(updates)) => contains(updates.updates),
        _ => false,
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
    text.split_whitespace()
        .map(|part| {
            let compact = part.trim_matches(|character: char| !character.is_ascii_alphanumeric() && character != '+' && character != '-' && character != '_');
            if compact.starts_with('+') && compact[1..].chars().all(|character| character.is_ascii_digit()) && compact.len() >= 8 {
                "[手机号已隐藏]".to_string()
            } else if (20..=128).contains(&compact.len()) && compact.chars().all(|character| character.is_ascii_hexdigit()) {
                "[凭据已隐藏]".to_string()
            } else {
                part.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(1000)
        .collect()
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

    #[test]
    fn detects_qr_login_token_update() {
        let update = UpdatesLike::Updates(tl::enums::Updates::UpdateShort(tl::types::UpdateShort {
            update: tl::enums::Update::LoginToken,
            date: 0,
        }));
        assert!(updates_contain_login_token(update));
    }

    #[test]
    fn telegram_errors_redact_phone_and_credentials() {
        let cleaned = clean_error("phone +8613800000000 api 0123456789abcdef0123456789abcdef");
        assert!(!cleaned.contains("+8613800000000"));
        assert!(!cleaned.contains("0123456789abcdef0123456789abcdef"));
        assert!(cleaned.contains("[手机号已隐藏]"));
        assert!(cleaned.contains("[凭据已隐藏]"));
    }

    #[tokio::test]
    async fn public_auth_status_never_waits_for_the_telegram_inner_lock() {
        let runtime = TelegramUserRuntime::new(Path::new("nonexistent-auth-status-test"));
        let _inner = runtime.inner.lock().await;
        let state = tokio::time::timeout(std::time::Duration::from_millis(50), runtime.status())
            .await
            .expect("public status must not wait on the network/session lock");
        assert_eq!(state.status, "disconnected");
    }

    #[tokio::test]
    async fn cancelling_a_stuck_background_login_unlocks_immediately() {
        let runtime = Arc::new(TelegramUserRuntime::new(Path::new("nonexistent-cancel-test")));
        let worker_runtime = Arc::clone(&runtime);
        let (locked_tx, locked_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _inner = worker_runtime.inner.lock().await;
            let _ = locked_tx.send(());
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        });
        runtime.replace_auth_task(task);
        runtime.publish_status("connecting", "test");
        locked_rx.await.expect("background test task should hold the inner lock");

        let started = std::time::Instant::now();
        let state = runtime.cancel_auth();
        assert!(started.elapsed() < std::time::Duration::from_millis(100));
        assert_eq!(state.status, "disconnected");
        assert_eq!(state.hint, "已取消当前登录流程，界面已解锁");
    }

    #[test]
    fn first_login_does_not_offer_restore_without_saved_credentials() {
        let runtime = Arc::new(TelegramUserRuntime::new(Path::new("nonexistent-first-login-test")));
        let error = runtime.begin_connect_saved().unwrap_err();
        assert!(error.contains("首次登录"));
        assert_eq!(runtime.auth_view.read().status, "disconnected");
    }
}
