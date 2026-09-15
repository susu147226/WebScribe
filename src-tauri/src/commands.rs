use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{oneshot, Mutex};

use crate::error::{CrawlError, CrawlErrorKind, Result};
use crate::logging::{LogEntry, Logger};
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
    /// 结构化日志。启动时初始化一次，此后只读。
    logger: std::sync::OnceLock<Arc<Logger>>,
}

impl AppState {
    /// 初始化结构化日志（文档第 38 条）。启动时调用一次。
    pub fn init_logger(&self, dir: &std::path::Path) -> std::io::Result<()> {
        let logger = Arc::new(Logger::new(dir)?);
        let _ = self.logger.set(logger);
        Ok(())
    }

    /// 日志文件路径，供 UI 或排查时定位。
    pub fn log_path(&self) -> Option<String> {
        self.logger.get().map(|l| l.path().display().to_string())
    }

    /// 写一条日志。日志未初始化或写入失败都不应影响主流程。
    fn log(&self, entry: LogEntry) {
        if let Some(logger) = self.logger.get() {
            let _ = logger.write(&entry);
        }
    }
}

impl AppState {
    pub async fn sidecar(&self) -> Result<Arc<Sidecar>> {
        self.sidecar
            .lock()
            .await
            .clone()
            .ok_or_else(|| CrawlError::new(CrawlErrorKind::PageRenderFailed).with_detail("crawler 尚未启动"))
    }

    /// 取得 crawler sidecar，尚未启动时先启动它。
    ///
    /// **务必保持这种写法。** 不可改写成
    /// `match self.sidecar.lock().await.clone() { Some(..) => .., None => { *self.sidecar.lock().await = .. } }`：
    /// `match` 的匹配对象是临时量，其生命周期延续到**整个 match 表达式结束**，
    /// 于是 `None` 分支里第二次 `lock()` 会在同一把锁上永久阻塞。
    /// 该写法曾导致首次抓取永久卡在「等待中」，且不产生任何错误提示。
    ///
    /// 启动放在锁内完成，以避免并发调用重复拉起 crawler 进程；
    /// `Sidecar::spawn` 是同步函数，持锁期间不会让出执行权。
    pub async fn ensure_sidecar(self: &Arc<Self>, app: &AppHandle) -> Result<Arc<Sidecar>> {
        let mut guard = self.sidecar.lock().await;

        if let Some(existing) = guard.as_ref() {
            return Ok(existing.clone());
        }

        let spawned = Arc::new(Sidecar::spawn(app, Arc::clone(self))?);
        let paths = spawned.paths();

        self.log(
            LogEntry::new("sidecar-spawned")
                .state(paths.crawler_entry.display().to_string()),
        );

        *guard = Some(spawned.clone());
        Ok(spawned)
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
    /// 结构化日志文件路径，便于排查问题时定位。
    pub log_path: Option<String>,
}

#[tauri::command]
pub fn environment_status(app: AppHandle, state: State<'_, Arc<AppState>>) -> EnvironmentStatus {
    let log_path = state.log_path();

    let Ok(paths) = RuntimePaths::resolve(&app) else {
        return EnvironmentStatus {
            ready: false,
            browser_available: false,
            node_path: String::new(),
            crawler_path: String::new(),
            problem: Some("无法解析运行时路径".into()),
            log_path,
        };
    };

    let problem = paths.verify().err().map(|e| e.message_with_detail());

    EnvironmentStatus {
        ready: problem.is_none(),
        browser_available: paths.browsers_dir.exists(),
        node_path: paths.node_exe.display().to_string(),
        crawler_path: paths.crawler_entry.display().to_string(),
        problem,
        log_path,
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

    let sidecar = state.ensure_sidecar(app).await?;

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

    state.log(
        LogEntry::new("crawl-started")
            .state(format!("{total} 个 URL（跳过 {duplicate_count} 个重复）")),
    );

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

    let sidecar = state.ensure_sidecar(app).await?;

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
///
/// 由 sidecar 的 stdout 读取协程**串行**调用，因此这里不能做任何会等待
/// 后续入站消息的操作——否则读取协程会自我阻塞。需要等待应答的收尾工作
/// （见 `finalize_run`）必须另起任务执行。
pub async fn handle_inbound(app: &AppHandle, state: Arc<AppState>, message: Inbound) {
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

            state.log(
                LogEntry::new("crawl-error")
                    .url(url)
                    .error(*error_kind)
                    .state(message.clone()),
            );
        }
        Inbound::Done { .. } => {
            // 必须另起任务执行收尾：finalize_run 会向 crawler 请求渲染 PDF
            // 并等待应答，而应答只能由本读取协程处理。若在此直接 await，
            // 读取协程会自我阻塞，PDF 输出将永久挂起。
            state.log(LogEntry::new("crawl-done"));
            let app = app.clone();
            let state = Arc::clone(&state);
            tauri::async_runtime::spawn(async move {
                finalize_run(&app, &state).await;
            });
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

    state.log(
        LogEntry::new("crawl-finished").state(format!(
            "写出 {} 个文件，{} 个失败，{} 个 PDF",
            outputs.len(),
            failures.len(),
            pdf_results.len()
        )),
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

    /// 回归测试：记录 `match mutex.lock().await.clone() { .. }` 的自死锁陷阱。
    ///
    /// `AppState::ensure_sidecar` 之所以必须写成「先取出锁值、再判断」，
    /// 就是因为下面的写法会永久阻塞 —— match 的匹配对象是临时量，
    /// 其生命周期延续到整个 match 表达式结束，因此 `None` 分支里的第二次
    /// `lock()` 会等待一把永远不会释放的锁。
    ///
    /// 该缺陷曾导致首次抓取永久卡在「等待中」，且不产生任何错误提示。
    #[tokio::test]
    async fn 回归_match_分支内重复加锁会自死锁() {
        use std::time::Duration;
        use tokio::sync::Mutex;

        let shared = Arc::new(Mutex::new(0u32));
        let inner = Arc::clone(&shared);

        let outcome = tokio::time::timeout(Duration::from_millis(200), async move {
            match inner.lock().await.clone() {
                _ => {
                    *inner.lock().await = 1;
                }
            }
        })
        .await;

        assert!(
            outcome.is_err(),
            "按 Rust 语义该写法应当自死锁；若此处不再超时，说明临时量生命周期规则有变，\
             需要重新审视 ensure_sidecar 的写法"
        );
    }

    /// 对照测试：先取出锁值、让守卫在语句结束时就释放，则不会死锁。
    /// 这正是 `ensure_sidecar` 采用的写法。
    #[tokio::test]
    async fn 对照_先取出锁值再判断不会死锁() {
        use std::time::Duration;
        use tokio::sync::Mutex;

        let shared = Arc::new(Mutex::new(0u32));
        let inner = Arc::clone(&shared);

        let outcome = tokio::time::timeout(Duration::from_millis(1000), async move {
            let current = inner.lock().await.clone();
            let _ = current;
            *inner.lock().await = 1;
        })
        .await;

        assert!(outcome.is_ok(), "先取出锁值的写法不应死锁");
    }

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
