use std::collections::HashMap;
use std::time::Duration;

use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status_code: u16,
    pub body: String,
    pub final_url: String,
    pub headers: HashMap<String, String>,
    pub duration_ms: u128,
    pub response_bytes: usize,
}

fn allowed_url(url: &reqwest::Url, raindrop_only: bool) -> bool {
    if url.scheme() != "https" { return false; }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if raindrop_only {
        host == "api.raindrop.io" && url.path().starts_with("/rest/v1/")
    } else {
        ["missav.ai", "missav.ws", "123av.com", "www.123av.com"].contains(&host.as_str())
            || host.ends_with(".missav.ai") || host.ends_with(".missav.ws")
    }
}

fn build_client(proxy: &str, timeout_ms: u64) -> Result<Client, String> {
    let mut builder = Client::builder()
        .timeout(Duration::from_millis(timeout_ms.clamp(1_000, 120_000)))
        .connect_timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::limited(4))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36")
        .gzip(true).brotli(true).deflate(true);
    if !proxy.trim().is_empty() {
        builder = builder.proxy(reqwest::Proxy::all(proxy.trim()).map_err(|error| format!("代理地址无效：{error}"))?);
    }
    builder.build().map_err(|error| error.to_string())
}

async fn execute(
    method: Method,
    url: reqwest::Url,
    token: &str,
    body: Option<serde_json::Value>,
    proxy: &str,
    timeout_ms: u64,
    raindrop_only: bool,
) -> Result<HttpResponse, String> {
    if !allowed_url(&url, raindrop_only) { return Err("出于安全限制，该网络地址不在允许列表中".to_string()); }
    let client = build_client(proxy, timeout_ms)?;
    let started = std::time::Instant::now();
    let mut request = client.request(method, url);
    if !token.is_empty() { request = request.bearer_auth(token); }
    if let Some(payload) = body { request = request.json(&payload); }
    let response = request.send().await.map_err(|error| format!("网络请求失败：{error}"))?;
    let status_code = response.status().as_u16();
    let final_url = response.url().to_string();
    let headers = response.headers().iter().filter_map(|(key, value)| value.to_str().ok().map(|value| (key.to_string(), value.to_string()))).collect();
    let bytes = response.bytes().await.map_err(|error| format!("读取响应失败：{error}"))?;
    let response_bytes = bytes.len();
    let body = String::from_utf8_lossy(&bytes).into_owned();
    Ok(HttpResponse { status_code, body, final_url, headers, duration_ms: started.elapsed().as_millis(), response_bytes })
}

pub async fn fetch_page(url: &str, proxy: &str, timeout_ms: u64) -> Result<HttpResponse, String> {
    let url = reqwest::Url::parse(url).map_err(|error| format!("网址无效：{error}"))?;
    execute(Method::GET, url, "", None, proxy, timeout_ms, false).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RaindropRequest {
    pub method: String,
    pub path: String,
    pub token: String,
    #[serde(default)]
    pub body: Option<serde_json::Value>,
    #[serde(default)]
    pub proxy: String,
}

pub async fn raindrop_request(input: RaindropRequest) -> Result<HttpResponse, String> {
    if input.token.trim().is_empty() { return Err("Raindrop Access Token 不能为空".to_string()); }
    let method = match input.method.to_ascii_uppercase().as_str() {
        "GET" => Method::GET, "POST" => Method::POST, "PUT" => Method::PUT, "DELETE" => Method::DELETE,
        _ => return Err("不允许的 Raindrop 请求方法".to_string()),
    };
    let path = if input.path.starts_with('/') { input.path } else { format!("/{}", input.path) };
    let url = reqwest::Url::parse(&format!("https://api.raindrop.io{path}")).map_err(|error| error.to_string())?;
    execute(method, url, input.token.trim(), input.body, &input.proxy, 45_000, true).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramBotRequest {
    pub token: String,
    pub method: String,
    #[serde(default)]
    pub body: serde_json::Value,
    #[serde(default)]
    pub proxy: String,
}

pub async fn telegram_bot_request(input: TelegramBotRequest) -> Result<HttpResponse, String> {
    if !input.token.trim().contains(':') { return Err("Telegram Bot Token 格式无效".to_string()); }
    if !input.method.chars().all(|character| character.is_ascii_alphanumeric() || character == '_') { return Err("Telegram Bot 方法无效".to_string()); }
    let client = build_client(&input.proxy, 55_000)?;
    let url = format!("https://api.telegram.org/bot{}/{}", input.token.trim(), input.method);
    let started = std::time::Instant::now();
    let response = client
        .post(url)
        .json(&input.body)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "Telegram Bot 请求超时：请确认 Clash 正在运行，并检查代理地址和端口".to_string()
            } else if error.is_connect() {
                "Telegram Bot 无法连接：请检查 Clash、代理地址、DNS 或防火墙".to_string()
            } else {
                "Telegram Bot 网络传输失败：请检查代理和网络设置".to_string()
            }
        })?;
    let status_code = response.status().as_u16();
    let final_url = "https://api.telegram.org/bot[REDACTED]".to_string();
    let headers = response.headers().iter().filter_map(|(key, value)| value.to_str().ok().map(|value| (key.to_string(), value.to_string()))).collect();
    let bytes = response.bytes().await.map_err(|_| "读取 Telegram Bot 响应失败".to_string())?;
    let response_bytes = bytes.len();
    let body = String::from_utf8_lossy(&bytes).into_owned();
    Ok(HttpResponse { status_code, body, final_url, headers, duration_ms: started.elapsed().as_millis(), response_bytes })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn network_allowlist_rejects_untrusted_hosts_and_http() {
        assert!(allowed_url(&reqwest::Url::parse("https://missav.ai/cn/abp-001").unwrap(), false));
        assert!(allowed_url(&reqwest::Url::parse("https://123av.com/cn/v/abp-001").unwrap(), false));
        assert!(!allowed_url(&reqwest::Url::parse("http://123av.com/cn/v/abp-001").unwrap(), false));
        assert!(!allowed_url(&reqwest::Url::parse("https://evil.example/?next=missav.ai").unwrap(), false));
        assert!(allowed_url(&reqwest::Url::parse("https://api.raindrop.io/rest/v1/user").unwrap(), true));
        assert!(!allowed_url(&reqwest::Url::parse("https://api.raindrop.io/other").unwrap(), true));
    }
}
