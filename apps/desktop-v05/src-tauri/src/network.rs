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

fn allowed_url(url: &reqwest::Url) -> bool {
    if url.scheme() != "https" { return false; }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    ["123av.com", "www.123av.com"].contains(&host.as_str())
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
    proxy: &str,
    timeout_ms: u64,
) -> Result<HttpResponse, String> {
    if !allowed_url(&url) { return Err("出于安全限制，该网络地址不在允许列表中".to_string()); }
    let client = build_client(proxy, timeout_ms)?;
    let started = std::time::Instant::now();
    let response = client.request(method, url).send().await.map_err(|error| format!("网络请求失败：{error}"))?;
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
    execute(Method::GET, url, proxy, timeout_ms).await
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
        assert!(!allowed_url(&reqwest::Url::parse("https://missav.ai/cn/abp-001").unwrap()));
        assert!(allowed_url(&reqwest::Url::parse("https://123av.com/cn/v/abp-001").unwrap()));
        assert!(!allowed_url(&reqwest::Url::parse("http://123av.com/cn/v/abp-001").unwrap()));
        assert!(!allowed_url(&reqwest::Url::parse("https://evil.example/?next=missav.ai").unwrap()));
        assert!(!allowed_url(&reqwest::Url::parse("https://api.raindrop.io/rest/v1/user").unwrap()));
    }
}
