use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeTask { pub id: u64, pub command: String, pub payload: serde_json::Value }

#[derive(Clone)]
pub struct ChromeBridge {
    pub port: u16,
    pub token: String,
    queue: Arc<Mutex<VecDeque<BridgeTask>>>,
    results: Arc<Mutex<HashMap<u64, serde_json::Value>>>,
    next_id: Arc<Mutex<u64>>,
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

impl ChromeBridge {
    pub fn start() -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| format!("启动 Chrome 桥失败：{error}"))?;
        let port = listener.local_addr().map_err(|error| error.to_string())?.port();
        let bridge = Self { port, token: random_token()?, queue: Arc::new(Mutex::new(VecDeque::new())), results: Arc::new(Mutex::new(HashMap::new())), next_id: Arc::new(Mutex::new(1)) };
        let server = bridge.clone();
        std::thread::Builder::new().name("v05-chrome-bridge".to_string()).spawn(move || {
            for stream in listener.incoming().flatten() { let state = server.clone(); std::thread::spawn(move || { let _ = handle_connection(stream, &state); }); }
        }).map_err(|error| error.to_string())?;
        Ok(bridge)
    }

    pub fn pairing_code(&self) -> String { format!("MMCB1:{}:{}", self.port, self.token) }

    pub fn enqueue(&self, command: &str, payloads: Vec<serde_json::Value>) -> Vec<u64> {
        let mut next = self.next_id.lock().unwrap();
        let mut queue = self.queue.lock().unwrap();
        payloads.into_iter().map(|payload| { let id = *next; *next += 1; queue.push_back(BridgeTask { id, command: command.to_string(), payload }); id }).collect()
    }

    pub fn take_results(&self, ids: &[u64]) -> HashMap<u64, serde_json::Value> {
        let mut results = self.results.lock().unwrap();
        let mut output = HashMap::new();
        for id in ids { if let Some(value) = results.remove(id) { output.insert(*id, value); } }
        output
    }
}

fn response(stream: &mut TcpStream, status: &str, body: &str) -> std::io::Result<()> {
    write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Authorization, Content-Type\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nConnection: close\r\n\r\n{body}", body.as_bytes().len())
}

fn handle_connection(mut stream: TcpStream, bridge: &ChromeBridge) -> Result<(), String> {
    stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).ok();
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop { let read = stream.read(&mut buffer).map_err(|error| error.to_string())?; if read == 0 { break; } bytes.extend_from_slice(&buffer[..read]); if bytes.windows(4).any(|part| part == b"\r\n\r\n") { break; } if bytes.len() > 128 * 1024 { return Err("请求过大".to_string()); } }
    let header_end = bytes.windows(4).position(|part| part == b"\r\n\r\n").ok_or_else(|| "HTTP 请求不完整".to_string())? + 4;
    let headers = String::from_utf8_lossy(&bytes[..header_end]).into_owned();
    let first = headers.lines().next().unwrap_or_default();
    let parts = first.split_whitespace().collect::<Vec<_>>();
    let method = parts.first().copied().unwrap_or(""); let path = parts.get(1).copied().unwrap_or("");
    let length = headers.lines().find_map(|line| line.split_once(':').filter(|(key, _)| key.eq_ignore_ascii_case("content-length")).and_then(|(_, value)| value.trim().parse::<usize>().ok())).unwrap_or(0);
    while bytes.len() < header_end + length { let read = stream.read(&mut buffer).map_err(|error| error.to_string())?; if read == 0 { break; } bytes.extend_from_slice(&buffer[..read]); }
    if method == "OPTIONS" { response(&mut stream, "204 No Content", "").map_err(|error| error.to_string())?; return Ok(()); }
    let authorized = headers.lines().any(|line| line.trim().eq_ignore_ascii_case(&format!("Authorization: Bearer {}", bridge.token)));
    if !authorized { response(&mut stream, "401 Unauthorized", "{\"error\":\"unauthorized\"}").map_err(|error| error.to_string())?; return Ok(()); }
    let body = String::from_utf8_lossy(&bytes[header_end..bytes.len().min(header_end + length)]);
    match (method, path) {
        ("POST", "/v1/hello") => response(&mut stream, "200 OK", "{\"ok\":true}"),
        ("GET", "/v1/next") => {
            if let Some(task) = bridge.queue.lock().unwrap().pop_front() { response(&mut stream, "200 OK", &serde_json::json!({"task": task}).to_string()) }
            else { response(&mut stream, "204 No Content", "") }
        }
        ("POST", "/v1/result") => {
            let value: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
            if let Some(id) = value.get("id").and_then(|value| value.as_u64()) { bridge.results.lock().unwrap().insert(id, value.get("result").cloned().unwrap_or_default()); }
            response(&mut stream, "200 OK", "{\"ok\":true}")
        }
        _ => response(&mut stream, "404 Not Found", "{\"error\":\"not_found\"}"),
    }.map_err(|error| error.to_string())?;
    Ok(())
}

pub fn install_extension(target: &Path) -> Result<String, String> {
    std::fs::create_dir_all(target).map_err(|error| error.to_string())?;
    let worker = include_str!("../../../../chrome-extension/service-worker.js")
        .replace("for (let slot = 0; slot < 4; slot++)", "for (let slot = 0; slot < 1; slot++)");
    let files = [
        ("manifest.json", include_str!("../../../../chrome-extension/manifest.json")),
        ("content-script.js", include_str!("../../../../chrome-extension/content-script.js")),
        ("popup.html", include_str!("../../../../chrome-extension/popup.html")),
        ("popup.css", include_str!("../../../../chrome-extension/popup.css")),
        ("popup.js", include_str!("../../../../chrome-extension/popup.js")),
    ];
    for (name, content) in files { std::fs::write(target.join(name), content).map_err(|error| error.to_string())?; }
    std::fs::write(target.join("service-worker.js"), worker).map_err(|error| error.to_string())?;
    Ok(target.display().to_string())
}
