// 面板 API 和下载站清单。macOS 与 Windows 走同一条 reqwest 路径：
// 直连调用 no_proxy()，不读系统代理，也不读环境变量里的代理；
// 只有「代理」这一轮才使用 sysproxy 读到的系统代理。两边都不写死地址。

use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client, Method, Proxy, Url};
use serde::{Deserialize, Serialize};
use sysproxy::Sysproxy;

const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

const ALLOWED_HOSTS: &[&str] = &[
    "nlogin.lianjieni.com",
    "np1.lianjieni.com",
    "login.lianjieni.com",
    "np2.lianjieni.com",
    "lianjieni.com",
    "p2.yuntanlu.com",
    "w1.yuntanlu.com",
    "w2.yuntanlu.com",
    "w3.yuntanlu.com",
    "k7m2.lianjieni.com",
    "down.yuntanlu.com",
    "ndl.lianjieni.com",
    "dl.yuntanlu.com",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TransportKind {
    Timeout,
    Connect,
    Tls,
    Other,
}

impl TransportKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Connect => "connect",
            Self::Tls => "tls",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ProxyChoice {
    Disabled,
    Explicit(String),
}

#[derive(Debug, Clone)]
struct SystemProxyEndpoint {
    enable: bool,
    host: String,
    port: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelHttpRequest {
    pub url: String,
    pub method: Option<String>,
    pub headers: Option<std::collections::HashMap<String, String>>,
    pub body: Option<String>,
    pub route: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelHttpOutcome {
    pub status: u16,
    pub body: String,
    pub error_kind: Option<String>,
}

fn failure(kind: TransportKind) -> PanelHttpOutcome {
    PanelHttpOutcome {
        status: 0,
        body: String::new(),
        error_kind: Some(kind.as_str().to_string()),
    }
}

fn choose_proxy(route: &str, system: Option<&SystemProxyEndpoint>) -> ProxyChoice {
    if route != "system" {
        return ProxyChoice::Disabled;
    }
    let Some(proxy) = system else {
        return ProxyChoice::Disabled;
    };
    if !proxy.enable || proxy.host.is_empty() || proxy.port == 0 {
        return ProxyChoice::Disabled;
    }
    ProxyChoice::Explicit(format!("http://{}:{}", proxy.host, proxy.port))
}

fn read_system_proxy() -> Option<SystemProxyEndpoint> {
    let proxy = Sysproxy::get_system_proxy().ok()?;
    Some(SystemProxyEndpoint {
        enable: proxy.enable,
        host: proxy.host,
        port: proxy.port,
    })
}

fn is_allowed_host(host: &str) -> bool {
    ALLOWED_HOSTS.iter().any(|item| item.eq_ignore_ascii_case(host))
}

fn validate_url(raw: &str) -> Result<Url, ()> {
    let url = Url::parse(raw).map_err(|_| ())?;
    if url.scheme() != "https" {
        return Err(());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(());
    }
    let host = url.host_str().ok_or(())?;
    if host.parse::<std::net::IpAddr>().is_ok() {
        return Err(());
    }
    if !is_allowed_host(host) {
        return Err(());
    }
    Ok(url)
}

fn contains_timeout(text: &str) -> bool {
    text.contains("timed out")
        || text.contains("timeout")
        || text.contains("etimedout")
        || text.contains("wsaetimedout")
        || text.contains("os error 10060")
        || text.contains("os error 60")
        || text.contains("超时")
}

fn contains_tls(text: &str) -> bool {
    text.contains("certificate")
        || text.contains("unknownissuer")
        || text.contains("webpki")
        || text.contains("invalid peer")
        || text.contains("cert verify")
        || text.contains("notvalid")
        || text.contains("unknown ca")
        || text.contains("self signed")
        || text.contains("self-signed")
        || text.contains("invalid certificate")
}

fn contains_connect(text: &str) -> bool {
    text.contains("os error 10061")
        || text.contains("os error 10054")
        || text.contains("os error 61")
        || text.contains("os error 54")
        || text.contains("os error 111")
        || text.contains("econnrefused")
        || text.contains("econnreset")
        || text.contains("enetunreach")
        || text.contains("ehostunreach")
        || text.contains("connection refused")
        || text.contains("connection reset")
        || text.contains("actively refused")
        || text.contains("积极拒绝")
        || text.contains("强迫关闭")
        || text.contains("proxy")
        || text.contains("tunnel")
        || text.contains("dns")
        || text.contains("name or service not known")
        || text.contains("no such host")
        || text.contains("unreachable")
        || text.contains("handshake")
        || text.contains("connect")
        || text.contains("refused")
        || text.contains("reset")
        || text.contains("拒绝")
}

fn classify_transport_text(message: &str) -> TransportKind {
    let text = message.to_ascii_lowercase();
    if contains_timeout(&text) {
        return TransportKind::Timeout;
    }
    if contains_tls(&text) {
        return TransportKind::Tls;
    }
    if contains_connect(&text) {
        return TransportKind::Connect;
    }
    TransportKind::Other
}

fn classify_reqwest_error(err: &reqwest::Error) -> TransportKind {
    if err.is_timeout() {
        return TransportKind::Timeout;
    }
    let own = classify_transport_text(&err.to_string());
    if own != TransportKind::Other {
        return own;
    }
    let mut source = std::error::Error::source(err);
    while let Some(inner) = source {
        let kind = classify_transport_text(&inner.to_string());
        if kind != TransportKind::Other {
            return kind;
        }
        source = inner.source();
    }
    if err.is_connect() {
        return TransportKind::Connect;
    }
    TransportKind::Other
}

fn static_webpki_config() -> Result<rustls::ClientConfig, ()> {
    let root_store = rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let mut config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|_| ())?
        .with_root_certificates(root_store)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(config)
}

fn build_client(choice: ProxyChoice, timeout: Duration) -> Result<Client, ()> {
    let mut builder = Client::builder()
        .tls_backend_preconfigured(static_webpki_config()?)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .connect_timeout(timeout)
        .pool_max_idle_per_host(0)
        .pool_idle_timeout(None);

    builder = match choice {
        ProxyChoice::Disabled => builder.no_proxy(),
        ProxyChoice::Explicit(proxy_url) => {
            let proxy = Proxy::all(proxy_url).map_err(|_| ())?;
            builder.proxy(proxy)
        }
    };

    builder.build().map_err(|_| ())
}

fn parse_method(method: &str) -> Option<Method> {
    match method.trim().to_ascii_uppercase().as_str() {
        "GET" => Some(Method::GET),
        "POST" => Some(Method::POST),
        "HEAD" => Some(Method::HEAD),
        "PUT" => Some(Method::PUT),
        "PATCH" => Some(Method::PATCH),
        "DELETE" => Some(Method::DELETE),
        _ => None,
    }
}

fn is_hop_header(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "host"
            | "content-length"
            | "connection"
            | "proxy-connection"
            | "transfer-encoding"
            | "trailer"
            | "upgrade"
            | "te"
    )
}

fn limit_body(text: String) -> String {
    if text.len() <= MAX_BODY_BYTES {
        return text;
    }
    let mut end = MAX_BODY_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

fn apply_headers(mut builder: reqwest::RequestBuilder, headers: HeaderMap) -> reqwest::RequestBuilder {
    for (name, value) in headers.iter() {
        builder = builder.header(name, value);
    }
    builder
}

async fn execute_panel_http(request: PanelHttpRequest) -> PanelHttpOutcome {
    let route = request.route.unwrap_or_else(|| "direct".to_string());
    let timeout_ms = request.timeout_ms.unwrap_or(8_000).clamp(1, 20_000);
    let url = match validate_url(&request.url) {
        Ok(url) => url,
        Err(()) => return failure(TransportKind::Connect),
    };
    let method = match parse_method(request.method.as_deref().unwrap_or("GET")) {
        Some(method) => method,
        None => return failure(TransportKind::Other),
    };
    let system = if route == "system" { read_system_proxy() } else { None };
    let choice = choose_proxy(&route, system.as_ref());
    let client = match build_client(choice, Duration::from_millis(timeout_ms)) {
        Ok(client) => client,
        Err(()) => return failure(TransportKind::Other),
    };

    let mut header_map = HeaderMap::new();
    if let Some(headers) = request.headers {
        for (name, value) in headers {
            if is_hop_header(&name) {
                continue;
            }
            let Ok(header_name) = HeaderName::from_bytes(name.as_bytes()) else {
                continue;
            };
            let Ok(header_value) = HeaderValue::from_str(&value) else {
                continue;
            };
            header_map.insert(header_name, header_value);
        }
    }

    let mut builder = apply_headers(client.request(method.clone(), url), header_map);
    if matches!(method, Method::POST | Method::PUT | Method::PATCH)
        && let Some(body) = request.body
    {
        builder = builder.body(body);
    }

    let response = match builder.send().await {
        Ok(response) => response,
        Err(error) => {
            let kind = classify_reqwest_error(&error);
            clash_verge_logging::logging!(
                debug,
                clash_verge_logging::Type::Network,
                "面板请求未到达响应，分类为 {}，不记录地址",
                kind.as_str()
            );
            return failure(kind);
        }
    };

    let status = response.status().as_u16();
    match response.text().await {
        Ok(text) => PanelHttpOutcome {
            status,
            body: limit_body(text),
            error_kind: None,
        },
        Err(error) => failure(classify_reqwest_error(&error)),
    }
}

#[tauri::command]
pub async fn panel_http_fetch(request: PanelHttpRequest) -> PanelHttpOutcome {
    execute_panel_http(request).await
}

#[cfg(test)]
mod tests {
    use super::{ProxyChoice, SystemProxyEndpoint, TransportKind, choose_proxy, classify_transport_text, validate_url};

    #[test]
    fn macos_and_windows_share_proxy_choice() {
        let enabled = SystemProxyEndpoint {
            enable: true,
            host: "localhost".to_string(),
            port: 80,
        };
        assert_eq!(choose_proxy("direct", Some(&enabled)), ProxyChoice::Disabled);
        assert_eq!(
            choose_proxy("system", Some(&enabled)),
            ProxyChoice::Explicit("http://localhost:80".to_string())
        );
        let disabled = SystemProxyEndpoint {
            enable: false,
            host: "localhost".to_string(),
            port: 80,
        };
        assert_eq!(choose_proxy("system", Some(&disabled)), ProxyChoice::Disabled);
        assert_eq!(choose_proxy("system", None), ProxyChoice::Disabled);
    }

    #[test]
    fn macos_and_windows_errors_share_a_kind() {
        let timeouts = [
            "operation timed out",
            "error sending request: timed out (os error 60)",
            "由于连接方在一段时间后没有正确答复或连接的主机没有反应，连接尝试失败。 (os error 10060)",
        ];
        for sample in timeouts {
            assert_eq!(classify_transport_text(sample), TransportKind::Timeout, "{sample}");
        }

        let refused = [
            "tcp connect error: Connection refused (os error 61)",
            "由于目标计算机积极拒绝，无法连接。 (os error 10061)",
            "Connection reset by peer (os error 54)",
            "远程主机强迫关闭了一个现有的连接。 (os error 10054)",
            "proxy connect: connection refused",
        ];
        for sample in refused {
            assert_eq!(classify_transport_text(sample), TransportKind::Connect, "{sample}");
        }

        let certificates = [
            "invalid peer certificate: UnknownIssuer",
            "certificate verify failed",
            "webpki: notvalid",
        ];
        for sample in certificates {
            assert_eq!(classify_transport_text(sample), TransportKind::Tls, "{sample}");
        }
    }

    #[test]
    fn allows_only_https_hostnames_on_the_list() {
        assert!(validate_url("https://nlogin.lianjieni.com/api/v1/user/plan/fetch").is_ok());
        assert!(validate_url("https://down.yuntanlu.com/version-desktop.json").is_ok());
        assert!(validate_url("http://nlogin.lianjieni.com/api/v1/user/plan/fetch").is_err());
        assert!(validate_url("https://user:secret@nlogin.lianjieni.com/api/v1/guest/comm/config").is_err());
        assert!(validate_url("https://example.com/api/v1/user/plan/fetch").is_err());
        let host = format!("{a}.{b}.{c}.{d}", a = 203_u8, b = 0_u8, c = 113_u8, d = 10_u8);
        let url = format!("https://{host}/api/v1/user/plan/fetch");
        assert!(validate_url(&url).is_err());
    }

    #[test]
    fn direct_and_explicit_clients_both_build() {
        let timeout = std::time::Duration::from_millis(50);
        assert!(super::build_client(ProxyChoice::Disabled, timeout).is_ok());
        assert!(super::build_client(ProxyChoice::Explicit("http://localhost:9".to_string()), timeout).is_ok());
    }
}
