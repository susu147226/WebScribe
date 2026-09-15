use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{oneshot, Mutex};

use crate::error::{CrawlError, CrawlErrorKind, Result};
use crate::protocol::{CrawlOptions, CrawlTarget, ImageStrategy, Inbound, Outbound, OutputFormat};
use crate::sidecar::{RuntimePaths, Sidecar};
use crate::task::{self, CrawlRun, FailureRecord, PdfJob};
use crate::url::{self, UrlEntry};

/// PDF 渲染结果。
#[derive(Debug)]
pub enum PdfOutcome {
    Ok(Vec<u8>),
    Err(String),
}

/// 应用共享状态。
#[derive(Default)]
pub struct AppState {
    pub sidecar: Mutex<Option<Arc<Sidecar>>>,
    pub run: Mutex<Option<Arc<Mutex<CrawlRun>>>>,
    /// 按 `id` 关联 PDF 渲染请求与应答。
    pub pdf_waiters: Mutex<HashMap<String, oneshot::Sender<PdfOutcome>>>,
    /// 登录窗口的启动网址，供 UI 在关闭后提示用户。
    pub login_domain: Mutex<Option<String>>,
}

impl AppState {
    pub async fn sidecar(&self) -> Result<Arc<Sidecar>> {
        self.sidecar
            .lock()
            .await
            .clone()
            .ok_or_else(|| CrawlError::new(CrawlErrorKind::PageRenderFailed).with_detail("crawler 尚未启动"))
    }
}

// ---------------------------------------------------------------------------
// URL 校验
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlValidation {
    /// 通过校验且去重后的条目，按输入顺序。
    pub accepted: Vec<UrlEntry>,
    /// 重复的条目及其对应的首个唯一条目下标。
    pub duplicates: Vec<DuplicateEntry>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateEntry {
    pub raw: String,
    pub duplicate_of: usize,
}

/// 校验并去重一批 URL。
///
/// 文档第 16 条：超过 10 个必须报错，不得静默截断；第 17 条要求基本合法性
/// 检查；第 18 条要求同任务内不得重复访问。
#[tauri::command]
pub fn validate_urls(urls: Vec<String>) -> UrlValidation {
    match url::validate_and_dedup(&urls) {
        Ok(outcome) => UrlValidation {
            accepted: outcome.unique,
            duplicates: outcome
                .duplicates
                .into_iter()
                .map(|(entry, index)| DuplicateEntry {
                    raw: entry.raw,
                    duplicate_of: index,
                })
                .collect(),
            error: None,
        },
        Err(e) => UrlValidation {
            accepted: Vec::new(),
            duplicates: Vec::new(),
            error: Some(match e.detail {
                Some(detail) => detail,
                None => e.message,
            }),
        },
    }
}

// ---------------------------------------------------------------------------
// 环境状态
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentStatus {
    /// 运行时是否齐备（node 与 crawler 产物均存在）。
    pub ready: bool,
    /// 浏览器运行时目录是否存在。
    pub browser_available: bool,
    pub node_path: String,
    pub crawler_path: String,
    /// 齐备性问题说明。
    pub problem: Option<String>,
}

#[tauri::command]
pub fn environment_status(app: AppHandle) -> EnvironmentStatus {
    let Ok(paths) = RuntimePaths::resolve(&app) else {
        return EnvironmentStatus {
            ready: false,
            browser_available: false,
            node_path: String::new(),
            crawler_path: String::new(),
            problem: Some("无法解析运行时路径".into()),
        };
    };

    let problem = paths.verify().err().map(|e| e.message_with_detail());

    EnvironmentStatus {
        ready: problem.is_none(),
        browser_available: paths.browsers_dir.exists(),
        node_path: paths.node_exe.display().to_string(),
        crawler_path: paths.crawler_entry.display().to_string(),
        problem,
    }
}

// ---------------------------------------------------------------------------
// 启动抓取
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlRequest {
    pub urls: Vec<String>,
    pub format: OutputFormat,
    pub image_strategy: ImageStrategy,
    pub follow_pagination: bool,
    pub max_pagination: u32,
    pub separate_output: bool,
    pub obey_robots: bool,
    pub save_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOutcome {
    pub total: u32,
    /// 因重复而被跳过的条数。
    pub duplicates: u32,
}

/// 启动一次抓取任务。
#[tauri::command]
pub async fn start_crawl(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: CrawlRequest,
) -> std::result::Result<StartOutcome, String> {
    start_crawl_inner(&app, state.inner().clone(), request)
        .await
        .map_err(|e| e.message_with_detail())
}

async fn start_crawl_inner(
    app: &AppHandle,
    state: Arc<AppState>,
    request: CrawlRequest,
) -> Result<StartOutcome> {
    let outcome = url::validate_and_dedup(&request.urls)?;

    let options = CrawlOptions {
        format: request.format,
        image_strategy: request.image_strategy,
        follow_pagination: request.follow_pagination,
        max_pagination: request.max_pagination,
        separate_output: request.separate_output,
        obey_robots: request.obey_robots,
    };
    task::validate_options(&options)?;

    let save_dir = PathBuf::from(request.save_dir.trim());
    task::ensure_save_dir(&save_dir)?;

    let sidecar = match state.sidecar.lock().await.clone() {
        Some(s) => s,
        None => {
            let spawned = Arc::new(Sidecar::spawn(app, state.clone())?);
            *state.sidecar.lock().await = Some(spawned.clone());
            spawned
        }
    };

    let paths = sidecar.paths().clone();

    // 组装目标：注册域由 Rust 用 PSL 计算，crawler 直接复用，保证口径一致
    let targets: Vec<CrawlTarget> = outcome
        .unique
        .iter()
        .map(|entry| {
            let site_key = url::validate(&entry.raw)
                .map(|parsed| crate::domain::site_key(&parsed))
                .unwrap_or_default();
            CrawlTarget {
                raw: entry.raw.clone(),
                key: entry.key.clone(),
                site_key,
            }
        })
        .collect();

    let duplicate_count = outcome.duplicates.len() as u32;
    let total = targets.len() as u32;

    // 清理上一次的暂存图片，避免残留文件被误引用
    let _ = std::fs::remove_dir_all(paths.staging_dir.join("assets"));

    let run = CrawlRun::new(
        task_id(),
        save_dir,
        options.clone(),
        paths.staging_dir.clone(),
    );
    let run = Arc::new(Mutex::new(run));
    *state.run.lock().await = Some(run.clone());

    sidecar
        .send(&Outbound::Crawl {
            targets,
            options,
            auth_dir: paths.auth_dir.display().to_string(),
            staging_dir: paths.staging_dir.display().to_string(),
            browser_path: None,
        })
        .await?;

    Ok(StartOutcome {
        total,
        duplicates: duplicate_count,
    })
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------

/// 打开有头浏览器供用户自行登录。
///
/// 文档第 29 条：程序不得自动读取或保存用户明文密码，不得破解验证码、
/// 绕过 MFA/CAPTCHA。此处只负责打开窗口。
#[tauri::command]
pub async fn open_login(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    url: String,
) -> std::result::Result<(), String> {
    open_login_inner(&app, state.inner().clone(), url)
        .await
        .map_err(|e| e.message_with_detail())
}

async fn open_login_inner(app: &AppHandle, state: Arc<AppState>, url: String) -> Result<()> {
    let parsed = url::validate(&url)?;
    let domain = crate::domain::site_key(&parsed);

    let sidecar = match state.sidecar.lock().await.clone() {
        Some(s) => s,
        None => {
            let spawned = Arc::new(Sidecar::spawn(app, state.clone())?);
            *state.sidecar.lock().await = Some(spawned.clone());
            spawned
        }
    };

    let paths = sidecar.paths().clone();
    std::fs::create_dir_all(&paths.auth_dir).ok();
    *state.login_domain.lock().await = Some(domain.clone());

    sidecar
        .send(&Outbound::Login {
            domain,
            start_url: url,
            auth_dir: paths.auth_dir.display().to_string(),
            browser_path: None,
        })
        .await
}

// ---------------------------------------------------------------------------
// 事件处理（由 sidecar 的读取协程调用）
// ---------------------------------------------------------------------------

/// 处理一条来自 crawler 的消息，同时推送给前端。
pub async fn handle_inbound(app: &AppHandle, state: &AppState, message: Inbound) {
    match &message {
        Inbound::Result {
            key,
            url,
            title,
            markdown,
            crawled_at,
            sequence,
            ..
        } => {
            let run = state.run.lock().await.clone();
            if let Some(run) = run {
                run.lock().await.record_page(
                    key,
                    *sequence,
                    title.clone(),
                    url.clone(),
                    markdown.clone(),
                    crawled_at.clone(),
                );
            }
        }
        Inbound::Error {
            key,
            url,
            error_kind,
            message,
            detail,
        } => {
            let run = state.run.lock().await.clone();
            if let Some(run) = run {
                run.lock().await.record_failure(FailureRecord {
                    key: key.clone(),
                    url: url.clone(),
                    error_kind: *error_kind,
                    message: message.clone(),
                    detail: detail.clone(),
                    is_defense: error_kind.is_defense_mechanism(),
                });
            }
        }
        Inbound::Done { .. } => {
            finalize_run(app, state).await;
        }
        Inbound::Pdf { id, pdf_base64 } => {
            let waiter = state.pdf_waiters.lock().await.remove(id);
            if let Some(tx) = waiter {
                match decode_base64(pdf_base64) {
                    Some(bytes) => {
                        let _ = tx.send(PdfOutcome::Ok(bytes));
                    }
                    None => {
                        let _ = tx.send(PdfOutcome::Err("PDF 数据解码失败".into()));
                    }
                }
            }
        }
        Inbound::PdfError { id, message, .. } => {
            let waiter = state.pdf_waiters.lock().await.remove(id);
            if let Some(tx) = waiter {
                let _ = tx.send(PdfOutcome::Err(message.clone()));
            }
        }
        _ => {}
    }

    crate::sidecar::forward_event(app, &message);
}

/// 全部页面到齐后：写出 Markdown、按需渲染并写出 PDF。
async fn finalize_run(app: &AppHandle, state: &AppState) {
    let Some(run) = state.run.lock().await.clone() else {
        return;
    };

    let (outputs, failures, pdf_jobs) = {
        let run = run.lock().await;
        let outputs = match run.write_outputs() {
            Ok(o) => o,
            Err(e) => {
                let _ = app.emit(
                    "crawler://save-error",
                    serde_json::json!({ "message": e.message_with_detail() }),
                );
                return;
            }
        };
        (outputs, run.failures.clone(), run.pdf_jobs())
    };

    let mut pdf_results = Vec::new();
    for job in pdf_jobs {
        match render_pdf(state, &job).await {
            Ok(bytes) => {
                let run = run.lock().await;
                match run.write_pdf_for(&job, &bytes) {
                    Ok(path) => pdf_results.push((job.id.clone(), path.display().to_string())),
                    Err(e) => {
                        let _ = app.emit(
                            "crawler://pdf-error",
                            serde_json::json!({ "id": job.id, "message": e.message_with_detail() }),
                        );
                    }
                }
            }
            Err(e) => {
                let _ = app.emit(
                    "crawler://pdf-error",
                    serde_json::json!({ "id": job.id, "message": e.message_with_detail() }),
                );
            }
        }
    }

    let _ = app.emit(
        "crawler://finished",
        serde_json::json!({
            "outputs": outputs,
            "failures": failures,
            "pdfs": pdf_results,
        }),
    );
}

/// 请求 crawler 渲染 PDF 并等待结果。
async fn render_pdf(state: &AppState, job: &PdfJob) -> Result<Vec<u8>> {
    let sidecar = state.sidecar().await?;
    let (tx, rx) = oneshot::channel();

    state
        .pdf_waiters
        .lock()
        .await
        .insert(job.id.clone(), tx);

    sidecar
        .send(&Outbound::RenderPdf {
            id: job.id.clone(),
            markdown: job.markdown.clone(),
            title: job.title.clone(),
            browser_path: None,
        })
        .await?;

    match rx.await {
        Ok(PdfOutcome::Ok(bytes)) => Ok(bytes),
        Ok(PdfOutcome::Err(message)) => {
            Err(CrawlError::new(CrawlErrorKind::PDFConversionFailed).with_detail(message))
        }
        Err(_) => Err(CrawlError::new(CrawlErrorKind::PDFConversionFailed)
            .with_detail("PDF 渲染未返回结果")),
    }
}

fn decode_base64(input: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(input).ok()
}

fn task_id() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 校验并去重返回结构化结果() {
        let result = validate_urls(vec![
            "https://example.com/a".into(),
            "https://EXAMPLE.com/a/".into(),
            "https://example.com/b".into(),
        ]);
        assert!(result.error.is_none());
        assert_eq!(result.accepted.len(), 2);
        assert_eq!(result.duplicates.len(), 1);
        assert_eq!(result.duplicates[0].duplicate_of, 0);
    }

    #[test]
    fn 超过十个_url_返回错误而非截断() {
        let urls: Vec<String> = (0..11).map(|i| format!("https://example.com/{i}")).collect();
        let result = validate_urls(urls);
        assert!(result.error.is_some());
        assert!(result.accepted.is_empty());
        assert!(result.error.unwrap().contains("11"));
    }

    #[test]
    fn 非法_url_返回错误() {
        let result = validate_urls(vec!["不是URL".into()]);
        assert!(result.error.is_some());
    }

    #[test]
    fn base64_解码往返() {
        use base64::Engine;
        let original = b"hello world".to_vec();
        let encoded = base64::engine::general_purpose::STANDARD.encode(&original);
        assert_eq!(decode_base64(&encoded).unwrap(), original);
    }

    #[test]
    fn base64_非法输入返回_none() {
        assert!(decode_base64("!!!not base64!!!").is_none());
    }
}
