//! 发版清单：3 种账号 × 连着/断开。只在 QA_MATRIX=1 时打真实面板。
//! 密码只从环境变量读取，不写入结果，也不打印。

use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpListener as TokioListener;

use super::{PanelHttpRequest, ProxyChoice};
use crate::utils::network::{NetworkManager, ProxyType};

const PLAN_LOAD_FAIL_TEXT: &str = "套餐暂时没加载出来，请点重试；还不行就先点「断开」再打开";
const LOGIN_FAIL_TEXT: &str = "登录没连上，请稍后重试；还不行就先点「断开」再试";
const CONNECT_FAIL_TEXT: &str = "暂时连不上，请打开购买页续费，或先点「断开」再试";
const REFRESH_FAIL_TEXT: &str = "刷新失败，请稍后再试";

struct Account {
    label: &'static str,
    email_key: &'static str,
    password_key: &'static str,
}

struct Row {
    account: String,
    link: String,
    login: String,
    plans: String,
    connect: String,
    refresh: String,
}

fn plain_only(text: &str) -> bool {
    !text.contains("HTTP") && !text.contains("TLS") && !text.contains('.') && !text.contains("网络或TLS失败")
}

fn load_dotenv() {
    let path = "/cursor/stores/bot/qa/caihongyun_test_accounts.env";
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim().trim_matches('"');
        if std::env::var(key).is_err() {
            // SAFETY: 测试进程自己的环境，不把值写到日志。
            unsafe { std::env::set_var(key, value) };
        }
    }
}

fn credential(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

const FAST_HOSTS: [&str; 2] = ["np1.lianjieni.com", "np2.lianjieni.com"];

async fn panel_call(
    path: &str,
    method: &str,
    body: Option<String>,
    auth: Option<&str>,
    choice: ProxyChoice,
) -> super::PanelHttpOutcome {
    let mut headers = std::collections::HashMap::new();
    headers.insert("Content-Type".to_string(), "application/json".to_string());
    if let Some(auth) = auth {
        headers.insert("Authorization".to_string(), auth.to_string());
    }
    let mut last = super::failure(super::TransportKind::Connect);
    for host in FAST_HOSTS {
        let request = PanelHttpRequest {
            url: format!("https://{host}/api/v1{path}"),
            method: Some(method.to_string()),
            headers: Some(headers.clone()),
            body: body.clone(),
            route: Some("direct".to_string()),
            timeout_ms: Some(12_000),
        };
        last = super::execute_with_choice(request, choice.clone()).await;
        if last.error_kind.is_none() && (200..300).contains(&last.status) {
            return last;
        }
    }
    last
}

fn json_body(outcome: &super::PanelHttpOutcome) -> Option<Value> {
    if outcome.error_kind.is_some() || !(200..300).contains(&outcome.status) {
        return None;
    }
    serde_json::from_str(&outcome.body).ok()
}

async fn login(email: &str, password: &str, choice: ProxyChoice) -> Result<String, String> {
    let body = serde_json::json!({ "email": email, "password": password }).to_string();
    let outcome = panel_call("/passport/auth/login", "POST", Some(body), None, choice).await;
    let Some(value) = json_body(&outcome) else {
        return Err(LOGIN_FAIL_TEXT.to_string());
    };
    value
        .pointer("/data/auth_data")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| LOGIN_FAIL_TEXT.to_string())
}

async fn plans(auth: &str, choice: ProxyChoice) -> Result<usize, String> {
    let outcome = panel_call("/user/plan/fetch", "GET", None, Some(auth), choice).await;
    let Some(value) = json_body(&outcome) else {
        return Err(PLAN_LOAD_FAIL_TEXT.to_string());
    };
    let count = value
        .pointer("/data")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    if count == 0 {
        Err(PLAN_LOAD_FAIL_TEXT.to_string())
    } else {
        Ok(count)
    }
}

async fn subscribe_url(auth: &str, choice: ProxyChoice) -> Result<String, String> {
    let outcome = panel_call("/user/getSubscribe", "GET", None, Some(auth), choice).await;
    let Some(value) = json_body(&outcome) else {
        return Err(CONNECT_FAIL_TEXT.to_string());
    };
    value
        .pointer("/data/subscribe_url")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| CONNECT_FAIL_TEXT.to_string())
}

fn with_flag(url: &str) -> String {
    if url.contains("flag=verge") {
        url.to_string()
    } else if url.contains('?') {
        format!("{url}&flag=verge")
    } else {
        format!("{url}?flag=verge")
    }
}

fn candidate_urls(raw: &str) -> Vec<String> {
    let flagged = with_flag(raw);
    let mut out = vec![flagged.clone()];
    let Ok(mut parsed) = reqwest::Url::parse(&flagged) else {
        return out;
    };
    for host in FAST_HOSTS {
        if parsed.set_host(Some(host)).is_ok() {
            let next = parsed.to_string();
            if !out.contains(&next) {
                out.push(next);
            }
        }
    }
    out
}

async fn fetch_profile(raw: &str) -> Result<(String, String), String> {
    let mut last = "下载没连上".to_string();
    for url in candidate_urls(raw) {
        match download_profile(&url).await {
            Ok(text) => return Ok((text, url)),
            Err(reason) => last = reason,
        }
    }
    Err(last)
}

async fn download_profile(url: &str) -> Result<String, String> {
    let response = match NetworkManager::new()
        .get_with_interrupt(url, ProxyType::None, Some(20), None, false)
        .await
    {
        Ok(response) => response,
        Err(_) => return Err("下载没连上".to_string()),
    };
    let code = response.status().as_u16();
    if !response.status().is_success() {
        return Err(if code == 401 || code == 403 {
            "下载被拒绝".to_string()
        } else {
            format!("下载失败 {code}")
        });
    }
    let text = response
        .text_with_charset()
        .map_err(|_| "下载没读完".to_string())?
        .to_string();
    let yaml = serde_yaml_ng::from_str::<serde_yaml_ng::Mapping>(&text).map_err(|_| "不是线路配置".to_string())?;
    if !yaml.contains_key("proxies") && !yaml.contains_key("proxy-providers") {
        return Err("配置里没有节点".to_string());
    }
    Ok(text)
}

fn proxy_names(config: &str) -> usize {
    config
        .lines()
        .filter(|line| line.trim_start().starts_with("- name:"))
        .count()
}

struct RefuseProxy {
    port: u16,
    hits: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl RefuseProxy {
    async fn start() -> Self {
        let listener = TokioListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("bind refusing proxy");
        let port = listener.local_addr().expect("proxy port").port();
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = std::sync::Arc::clone(&hits);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let _ = socket.shutdown().await;
                let _ = socket.read(&mut [0_u8; 16]).await;
            }
        });
        Self { port, hits }
    }

    fn url(&self) -> String {
        format!("http://{}:{}", Ipv4Addr::LOCALHOST, self.port)
    }

    fn hits(&self) -> usize {
        self.hits.load(std::sync::atomic::Ordering::SeqCst)
    }
}

fn ensure_mihomo() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("MIHOMO_BIN") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }
    let dest = std::env::temp_dir().join("qa-mihomo");
    if dest.is_file() {
        return Ok(dest);
    }
    let status = Command::new("bash")
        .arg("-lc")
        .arg(format!(
            "curl -fsSL -o {dest}.gz https://github.com/MetaCubeX/mihomo/releases/download/v1.19.15/mihomo-linux-amd64-v1.19.15.gz && gzip -df {dest}.gz && chmod +x {dest}",
            dest = dest.display()
        ))
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() && dest.is_file() {
        Ok(dest)
    } else {
        Err("没有可用的 mihomo 内核".to_string())
    }
}

fn rewrite_port(config: &str, port: u16) -> String {
    let mut out = String::new();
    let mut saw_mixed = false;
    for line in config.lines() {
        if line.starts_with("mixed-port:") || line.starts_with("port:") {
            if !saw_mixed {
                out.push_str(&format!("mixed-port: {port}\n"));
                saw_mixed = true;
            }
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    if !saw_mixed {
        out.insert_str(0, &format!("mixed-port: {port}\n"));
    }
    out
}

struct Mihomo {
    child: std::process::Child,
    port: u16,
}

impl Mihomo {
    fn start(config: &str) -> Result<Self, String> {
        let bin = ensure_mihomo()?;
        let port = {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|error| error.to_string())?;
            listener.local_addr().map_err(|error| error.to_string())?.port()
        };
        let dir = std::env::temp_dir().join(format!("qa-mihomo-{port}"));
        std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        std::fs::write(dir.join("config.yaml"), rewrite_port(config, port)).map_err(|error| error.to_string())?;
        let child = Command::new(bin)
            .arg("-d")
            .arg(&dir)
            .arg("-f")
            .arg(dir.join("config.yaml"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| error.to_string())?;
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let mut ready = false;
        for _ in 0..40 {
            if TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok() {
                ready = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        if !ready {
            return Err("mihomo 没有开始监听".to_string());
        }
        Ok(Self { child, port })
    }

    fn proxy_url(&self) -> String {
        format!("http://{}:{}", Ipv4Addr::LOCALHOST, self.port)
    }

    fn reaches_internet(&self) -> bool {
        Command::new("curl")
            .args([
                "-fsS",
                "-o",
                "/dev/null",
                "--max-time",
                "20",
                "-x",
                &self.proxy_url(),
                "https://www.gstatic.com/generate_204",
            ])
            .status()
            .is_ok_and(|status| status.success())
    }
}

impl Drop for Mihomo {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

async fn run_group(account: &Account, connected: bool, refuse: &RefuseProxy) -> Row {
    let link = if connected { "连着线路" } else { "断开线路" };
    let email = credential(account.email_key);
    let password = credential(account.password_key);
    let (Some(email), Some(password)) = (email, password) else {
        return Row {
            account: account.label.to_string(),
            link: link.to_string(),
            login: "缺少测试账号".to_string(),
            plans: "未跑".to_string(),
            connect: "未跑".to_string(),
            refresh: "未跑".to_string(),
        };
    };

    let direct = ProxyChoice::Disabled;
    let before = refuse.hits();
    let login_result = login(&email, &password, direct.clone()).await;
    let (login_text, auth) = match login_result {
        Ok(auth) => ("通过".to_string(), Some(auth)),
        Err(message) => (message, None),
    };

    let plan_text = if let Some(auth) = auth.as_deref() {
        match plans(auth, direct.clone()).await {
            Ok(count) => format!("通过，{count} 个套餐"),
            Err(message) => message,
        }
    } else {
        "未跑".to_string()
    };

    let mut connect_text = "未跑".to_string();
    let mut refresh_text = "未跑".to_string();
    let mut config = None;
    let mut saved_url = None;
    if let Some(auth) = auth.as_deref() {
        match subscribe_url(auth, direct.clone()).await {
            Ok(url) => match fetch_profile(&url).await {
                Ok((text, used)) => {
                    let names = proxy_names(&text);
                    saved_url = Some(used);
                    config = Some(text);
                    if account.label == "正常" {
                        match Mihomo::start(config.as_deref().unwrap_or("")) {
                            Ok(mihomo) if mihomo.reaches_internet() => {
                                connect_text = format!("通过，经本地代理端口 {} 访问外网", mihomo.port);
                            }
                            Ok(_) => connect_text = "内核已启动，但没有通过它访问外网".to_string(),
                            Err(message) => connect_text = message,
                        }
                        let _ = names;
                    } else {
                        let online = Mihomo::start(config.as_deref().unwrap_or(""))
                            .is_ok_and(|mihomo| mihomo.reaches_internet());
                        connect_text = if online {
                            "不应连上，但通过代理访问了外网".to_string()
                        } else {
                            CONNECT_FAIL_TEXT.to_string()
                        };
                    }
                }
                Err(message) => {
                    connect_text = if account.label == "正常" {
                        message
                    } else {
                        CONNECT_FAIL_TEXT.to_string()
                    };
                }
            },
            Err(message) => connect_text = message,
        }

        let mut refresh_detail = String::new();
        if let Some(used) = saved_url.as_deref() {
            for _ in 0..3 {
                match download_profile(used).await {
                    Ok(text) => {
                        let names = proxy_names(&text);
                        refresh_text = if names > 0 {
                            format!("通过，{names} 条线路")
                        } else {
                            "通过，已重新拉到线路配置".to_string()
                        };
                        refresh_detail.clear();
                        break;
                    }
                    Err(reason) => refresh_detail = reason,
                }
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
        } else {
            refresh_detail = "没有可刷新的订阅".to_string();
        }
        if !refresh_text.starts_with("通过") {
            refresh_text = format!("{REFRESH_FAIL_TEXT}（{refresh_detail}）");
        }
    }

    if connected && account.label != "正常" {
        let forced = panel_call(
            "/user/plan/fetch",
            "GET",
            None,
            auth.as_deref(),
            ProxyChoice::Explicit(refuse.url()),
        )
        .await;
        if forced.error_kind.is_none() {
            connect_text = format!("{connect_text}；拒绝代理却被当成可用");
        }
    }
    if connected && account.label == "正常" {
        if let (Some(auth), Some(text)) = (auth.as_deref(), config.as_deref()) {
            if let Ok(mihomo) = Mihomo::start(text) {
                let through = panel_call(
                    "/user/plan/fetch",
                    "GET",
                    None,
                    Some(auth),
                    ProxyChoice::Explicit(mihomo.proxy_url()),
                )
                .await;
                if through.error_kind.is_some() || !(200..300).contains(&through.status) {
                    plan_text_note(&mut connect_text, "正常账号走 mihomo 没有拿到套餐");
                }
            }
        }
    }
    let _ = before;

    Row {
        account: account.label.to_string(),
        link: link.to_string(),
        login: login_text,
        plans: plan_text,
        connect: connect_text,
        refresh: refresh_text,
    }
}

fn plan_text_note(slot: &mut String, note: &str) {
    slot.push('；');
    slot.push_str(note);
}

fn expect_ok(row: &Row) -> Result<(), String> {
    if row.login != "通过" {
        return Err(format!("{} {} 登录：{}", row.account, row.link, row.login));
    }
    if !row.plans.starts_with("通过") {
        return Err(format!("{} {} 套餐：{}", row.account, row.link, row.plans));
    }
    if row.account == "正常" {
        if !row.connect.starts_with("通过") || !row.refresh.starts_with("通过") {
            return Err(format!(
                "{} {} 连接/刷新：{} / {}",
                row.account, row.link, row.connect, row.refresh
            ));
        }
    } else if row.connect != CONNECT_FAIL_TEXT
        || !(row.refresh.starts_with(REFRESH_FAIL_TEXT) || row.refresh.starts_with("通过"))
    {
        return Err(format!(
            "{} {} 应只显示大白话，实际连接「{}」刷新「{}」",
            row.account, row.link, row.connect, row.refresh
        ));
    }
    for text in [&row.login, &row.plans, &row.connect, &row.refresh] {
        if text.contains("nlogin") || text.contains("HTTP ") || text.contains("TLS") {
            return Err(format!("结果里出现了技术报错：{text}"));
        }
    }
    Ok(())
}

#[tokio::test]
async fn release_checklist_against_real_panel() {
    if std::env::var("QA_MATRIX").ok().as_deref() != Some("1") {
        return;
    }
    load_dotenv();
    assert!(plain_only(PLAN_LOAD_FAIL_TEXT));
    assert!(plain_only(LOGIN_FAIL_TEXT));
    assert!(plain_only(CONNECT_FAIL_TEXT));
    assert!(plain_only(REFRESH_FAIL_TEXT));

    let refuse = RefuseProxy::start().await;
    let accounts = [
        Account {
            label: "正常",
            email_key: "QA_NORMAL_EMAIL",
            password_key: "QA_NORMAL_PASSWORD",
        },
        Account {
            label: "已到期",
            email_key: "QA_EXPIRED_EMAIL",
            password_key: "QA_EXPIRED_PASSWORD",
        },
        Account {
            label: "流量用完",
            email_key: "QA_NODATA_EMAIL",
            password_key: "QA_NODATA_PASSWORD",
        },
    ];
    let mut rows = Vec::new();
    for account in &accounts {
        for connected in [false, true] {
            rows.push(run_group(account, connected, &refuse).await);
        }
    }
    let hits = refuse.hits();
    let table = json!({ "proxy_refusals_seen": hits, "rows": rows.iter().map(|row| json!({
        "account": row.account,
        "link": row.link,
        "login": row.login,
        "plans": row.plans,
        "connect": row.connect,
        "refresh": row.refresh,
    })).collect::<Vec<_>>() });
    let path = std::env::temp_dir().join("qa-matrix.json");
    std::fs::write(&path, serde_json::to_string_pretty(&table).unwrap_or_default()).ok();
    eprintln!("qa matrix written to {}", path.display());
    let mut errors = Vec::new();
    for row in &rows {
        if let Err(error) = expect_ok(row) {
            errors.push(error);
        }
    }
    assert!(errors.is_empty(), "{}", errors.join("\n"));
}
