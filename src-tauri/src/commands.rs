use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{oneshot, Mutex};

use crate::error::{CrawlError, CrawlErrorKind, Result};
use crate::logging::{LogEntry, Logger};
use crate::merge::MergeRecord;
use crate::protocol::{CrawlOptions, CrawlTarget, ImageStrategy, Inbound, Outbound, OutputFormat};
use crate::sidecar::{RuntimePaths, Sidecar};
use crate::task::{self, CrawlRun, FailureRecord, PdfJob};
use crate::url;

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
    pub fn log(&self, entry: LogEntry) {
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

/// 单个输入行的校验结果。
///
/// 逐条返回而非只给一个总结果，界面才能对每一行分别标出「合法 / 非法原因 /
/// 与第几条重复 / 将并入哪份文档」。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlCheck {
    pub raw: String,
    /// 规范化后的身份标识；非法或为空时为 None。
    pub key: Option<String>,
    /// 所属文档分组；非法或为空时为 None。同分组的条目会合并为一份文档。
    pub doc_group: Option<String>,
    /// 非法原因；合法时为 None。
    pub error: Option<String>,
    /// 与之重复的、首次出现的条目下标（从 0 起）；不重复时为 None。
    pub duplicate_of: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlValidation {
    pub checks: Vec<UrlCheck>,
    /// 全局错误，例如超出单次任务的数量上限。
    pub error: Option<String>,
}

/// 逐条校验 URL。
///
/// 超出上限时仍返回全部行的校验结果，只把限制说明放进 `error` —— 界面需要
/// 让用户看到究竟哪几行有问题，而不是整批失败、无从下手。
#[tauri::command]
pub fn validate_urls(urls: Vec<String>, max_urls: usize) -> UrlValidation {
    let limit = url::clamp_link_limit(max_urls);
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut checks = Vec::with_capacity(urls.len());
    let mut unique_count = 0usize;

    for raw in &urls {
        let trimmed = raw.trim();

        if trimmed.is_empty() {
            checks.push(UrlCheck {
                raw: raw.clone(),
                key: None,
                doc_group: None,
                error: Some("尚未填写".into()),
                duplicate_of: None,
            });
            continue;
        }

        let parsed = match url::validate(trimmed) {
            Ok(parsed) => parsed,
            Err(e) => {
                checks.push(UrlCheck {
                    raw: raw.clone(),
                    key: None,
                    doc_group: None,
                    error: Some(e.detail.unwrap_or(e.message)),
                    duplicate_of: None,
                });
                continue;
            }
        };

        let key = url::normalize(&parsed);
        let doc_group = url::doc_group(&parsed);

        match seen.get(&key) {
            Some(&index) => checks.push(UrlCheck {
                raw: raw.clone(),
                key: Some(key),
                doc_group: Some(doc_group),
                error: None,
                duplicate_of: Some(index),
            }),
            None => {
                seen.insert(key.clone(), unique_count);
                unique_count += 1;
                checks.push(UrlCheck {
                    raw: raw.clone(),
                    key: Some(key),
                    doc_group: Some(doc_group),
                    error: None,
                    duplicate_of: None,
                });
            }
        }
    }

    let error = if unique_count > limit {
        Some(format!(
            "本次任务的上限是 {limit} 个链接，当前有效条目有 {unique_count} 个。请删除多余项，或在上方调高上限。"
        ))
    } else {
        None
    };

    UrlValidation { checks, error }
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
    /// 当前版本号。取自 Cargo 包版本，界面标题直接展示，避免多处维护。
    pub version: String,
    /// 可选的链接数量档位。由主程序提供，界面直接渲染，避免两边各写一份而漂移。
    pub link_limit_tiers: Vec<usize>,
    /// 默认档位。
    pub default_link_limit: usize,
}

#[tauri::command]
pub fn environment_status(app: AppHandle, state: State<'_, Arc<AppState>>) -> EnvironmentStatus {
    let log_path = state.log_path();
    let version = env!("CARGO_PKG_VERSION").to_string();
    let link_limit_tiers = url::LINK_LIMIT_TIERS.to_vec();
    let default_link_limit = url::DEFAULT_LINK_LIMIT;

    let Ok(paths) = RuntimePaths::resolve(&app) else {
        return EnvironmentStatus {
            ready: false,
            browser_available: false,
            node_path: String::new(),
            crawler_path: String::new(),
            problem: Some("无法解析运行时路径".into()),
            log_path,
            version,
            link_limit_tiers,
            default_link_limit,
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
        version,
        link_limit_tiers,
        default_link_limit,
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
    /// 是否启用「相似链接合并为同一文档」。关闭时每个 URL 独立成文档，
    /// 也不会读写合并记录。
    #[serde(default = "default_true")]
    pub merge_documents: bool,
    /// 本次任务的链接数量上限（档位）。
    #[serde(default = "default_link_limit")]
    pub max_urls: usize,
    pub save_dir: String,
}

fn default_true() -> bool {
    true
}

fn default_link_limit() -> usize {
    url::DEFAULT_LINK_LIMIT
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOutcome {
    pub total: u32,
    /// 因重复而被跳过的条数。
    pub duplicates: u32,
    /// 本次将追加到既有文档的文档分组数。
    pub merging: u32,
}

/// 合并记录文件路径。
fn merge_record_path(paths: &RuntimePaths) -> PathBuf {
    paths.data_dir.join("merge-records.json")
}

/// 清除合并记录。之后所有任务都会新建文档。
#[tauri::command]
pub async fn clear_merge_records(
    state: State<'_, Arc<AppState>>,
) -> std::result::Result<u32, String> {
    let sidecar = state.sidecar().await.map_err(|e| e.message_with_detail())?;
    let path = merge_record_path(sidecar.paths());

    let mut record = MergeRecord::load(&path);
    let cleared = record.groups.len() as u32;
    record.clear();
    record.save(&path).map_err(|e| format!("清除合并记录失败：{e}"))?;

    state.log(LogEntry::new("merge-records-cleared").state(cleared.to_string()));
    Ok(cleared)
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
    let outcome = url::validate_and_dedup(&request.urls, request.max_urls)?;

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

    // 组装目标：注册域由 Rust 用 PSL 计算，crawler 直接复用，保证口径一致。
    // 同时记录每个 URL 所属的文档分组，供结果归并使用。
    let mut group_by_key: HashMap<String, String> = HashMap::new();
    let mut targets: Vec<CrawlTarget> = Vec::with_capacity(outcome.unique.len());

    for entry in &outcome.unique {
        let parsed = url::validate(&entry.raw)?;
        let group = url::doc_group(&parsed);

        group_by_key.insert(entry.key.clone(), group);

        targets.push(CrawlTarget {
            raw: entry.raw.clone(),
            key: entry.key.clone(),
            site_key: crate::domain::site_key(&parsed),
        });
    }

    // 命中合并记录、且上次的文件仍在时，本次改为追加到该文件
    let record_path = merge_record_path(&paths);
    let mut append_targets: HashMap<String, PathBuf> = HashMap::new();
    if request.merge_documents {
        let record = MergeRecord::load(&record_path);
        for group in group_by_key.values() {
            if let Some(file) = record.existing_file(group) {
                append_targets.insert(group.clone(), file);
            }
        }
    }

    let duplicate_count = outcome.duplicates.len() as u32;
    let total = targets.len() as u32;
    let merging = append_targets.len() as u32;

    // 清理上一次的暂存图片，避免残留文件被误引用
    let _ = std::fs::remove_dir_all(paths.staging_dir.join("assets"));

    let run = CrawlRun::new(
        task_id(),
        save_dir,
        options.clone(),
        paths.staging_dir.clone(),
        group_by_key,
        append_targets,
    );
    let mut run = run;
    run.merge_enabled = request.merge_documents;
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

    state.log(LogEntry::new("crawl-started").state(format!(
        "{total} 个 URL（跳过 {duplicate_count} 个重复，{merging} 份文档将追加）"
    )));

    Ok(StartOutcome {
        total,
        duplicates: duplicate_count,
        merging,
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

    let (outcome, failures, merge_enabled) = {
        let guard = run.lock().await;

        let outcome = match guard.write_outputs() {
            Ok(o) => o,
            Err(e) => {
                let _ = app.emit(
                    "crawler://save-error",
                    serde_json::json!({ "message": e.message_with_detail() }),
                );
                return;
            }
        };

        (outcome, guard.failures.clone(), guard.merge_enabled)
    };

    // 更新合并记录：记住「文档分组 → 产出文件」，供下次任务判断是追加还是新建
    if merge_enabled {
        if let Ok(sidecar) = state.sidecar().await {
            let path = merge_record_path(sidecar.paths());
            let mut record = MergeRecord::load(&path);

            for file in &outcome.files {
                if let Some(markdown) = &file.markdown_path {
                    record.remember(&file.group, Path::new(markdown), &file.title);
                }
            }

            if let Err(e) = record.save(&path) {
                eprintln!("[WebScribe] 合并记录写入失败：{e}");
            }
        }
    }

    let outputs = outcome.files;
    let pdf_jobs = outcome.pdf_jobs;

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
    fn 逐条校验并标出重复项() {
        let result = validate_urls(vec![
            "https://example.com/a".into(),
            "https://EXAMPLE.com/a/".into(),
            "https://example.com/b".into(),
        ], url::DEFAULT_LINK_LIMIT);

        assert!(result.error.is_none());
        assert_eq!(result.checks.len(), 3, "每一行都应有一条结果");

        // 第 2 行规范化后与第 1 行相同，标为重复
        assert_eq!(result.checks[1].duplicate_of, Some(0));
        assert!(result.checks[0].duplicate_of.is_none());
        assert!(result.checks[2].duplicate_of.is_none());

        // 合法行带出规范化 key 与文档分组
        assert_eq!(result.checks[0].key.as_deref(), Some("https://example.com/a"));
        assert_eq!(result.checks[0].doc_group.as_deref(), Some("example.com"));
    }

    #[test]
    fn 非法行带出具体原因且不影响其它行() {
        let result = validate_urls(vec![
            "https://example.com/a".into(),
            "这不是URL".into(),
            "https://example.com/b".into(),
        ], url::DEFAULT_LINK_LIMIT);

        assert!(result.checks[0].error.is_none());
        assert!(result.checks[1].error.is_some(), "非法行应给出原因");
        assert!(result.checks[1].key.is_none());
        assert!(result.checks[2].error.is_none(), "后续合法行不应受牵连");
    }

    #[test]
    fn 空行被标记为尚未填写() {
        let result = validate_urls(vec!["".into(), "   ".into()], url::DEFAULT_LINK_LIMIT);
        assert_eq!(result.checks.len(), 2);
        for check in &result.checks {
            assert!(check.error.as_deref().unwrap_or_default().contains("尚未填写"));
        }
    }

    #[test]
    fn 超出上限时仍返回逐行结果() {
        let urls: Vec<String> = (0..11).map(|i| format!("https://example.com/{i}")).collect();
        let result = validate_urls(urls, 10);

        // 不得静默截断：既要给出全局错误，也要保留每一行的结果供用户逐条处理
        assert!(result.error.is_some());
        assert!(result.error.unwrap().contains("11"));
        assert_eq!(result.checks.len(), 11, "全部行都应保留");
    }

    #[test]
    fn 换一个更高的档位即可通过() {
        let urls: Vec<String> = (0..11).map(|i| format!("https://example.com/{i}")).collect();

        assert!(validate_urls(urls.clone(), 10).error.is_some());
        assert!(
            validate_urls(urls, 50).error.is_none(),
            "11 条在 50 档位下应当通过"
        );
    }

    #[test]
    fn 恰好达到档位不报错() {
        let urls: Vec<String> = (0..10).map(|i| format!("https://example.com/{i}")).collect();
        assert!(validate_urls(urls, 10).error.is_none());
    }

    #[test]
    fn 重复项不计入上限() {
        // 10 个唯一 + 1 个重复，在 10 档位下仍应通过
        let mut urls: Vec<String> = (0..10).map(|i| format!("https://example.com/{i}")).collect();
        urls.push("https://example.com/0".into());

        let result = validate_urls(urls, 10);
        assert!(result.error.is_none(), "重复项不应占用名额");
        assert_eq!(result.checks[10].duplicate_of, Some(0));
    }

    #[test]
    fn 逐条结果带出文档分组() {
        let result = validate_urls(vec![
            "https://example.com/docs/a/chapter-1".into(),
            "https://example.com/docs/a/chapter-2".into(),
        ], url::DEFAULT_LINK_LIMIT);

        let first = result.checks[0].doc_group.clone().unwrap();
        let second = result.checks[1].doc_group.clone().unwrap();
        assert_eq!(first, second, "同目录下的章节应归为同一文档分组");
        assert_eq!(first, "example.com/docs/a");
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
