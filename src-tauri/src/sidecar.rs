use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

use crate::commands::{handle_inbound, AppState};
use crate::error::{CrawlError, CrawlErrorKind, Result};
use crate::protocol::{Inbound, Outbound};

/// 运行时路径。
///
/// 开发环境从源码目录读取，打包后从 Tauri 资源目录读取。
#[derive(Debug, Clone)]
pub struct RuntimePaths {
    /// 随包分发的 node.exe。
    pub node_exe: PathBuf,
    /// crawler 构建产物入口。
    pub crawler_entry: PathBuf,
    /// Playwright 浏览器目录，通过 PLAYWRIGHT_BROWSERS_PATH 告知 crawler。
    pub browsers_dir: PathBuf,
    /// 登录态目录（已加入 .gitignore）。
    pub auth_dir: PathBuf,
    /// 图片暂存目录。
    pub staging_dir: PathBuf,
    /// 应用数据根目录。合并记录等本地状态放在这里。
    pub data_dir: PathBuf,
}

impl RuntimePaths {
    /// 解析运行时路径。
    ///
    /// 优先使用 Tauri 资源目录（打包场景）；资源目录中不存在时回退到源码目录
    /// （`tauri dev` 场景）。
    pub fn resolve(app: &AppHandle) -> Result<Self> {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let project_root = manifest_dir
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| manifest_dir.clone());

        let resource_dir = app
            .path()
            .resource_dir()
            .unwrap_or_else(|_| project_root.clone());

        let root = if resource_dir.join("runtime").exists() || resource_dir.join("crawler").exists() {
            resource_dir
        } else {
            project_root
        };

        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|e| {
                CrawlError::new(CrawlErrorKind::SaveFailed)
                    .with_detail(format!("无法解析应用数据目录：{e}"))
            })?;

        Ok(Self {
            node_exe: root.join("runtime").join("node").join(node_executable()),
            crawler_entry: root.join("crawler").join("dist").join("index.js"),
            browsers_dir: root.join("runtime").join("browsers"),
            auth_dir: app_data.join("auth"),
            staging_dir: app_data.join("staging"),
            data_dir: app_data,
        })
    }

    /// 检查关键文件是否齐备，缺失时给出可操作的提示。
    pub fn verify(&self) -> Result<()> {
        if !self.node_exe.exists() {
            return Err(CrawlError::new(CrawlErrorKind::PageRenderFailed).with_detail(format!(
                "未找到 Node 运行时：{}。请先运行 scripts/fetch-runtime.ps1 获取运行时。",
                self.node_exe.display()
            )));
        }
        if !self.crawler_entry.exists() {
            return Err(CrawlError::new(CrawlErrorKind::PageRenderFailed).with_detail(format!(
                "未找到 crawler 构建产物：{}。请先运行 npm run crawler:build。",
                self.crawler_entry.display()
            )));
        }
        Ok(())
    }
}

fn node_executable() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

/// crawler sidecar 句柄。
pub struct Sidecar {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Option<Child>>>,
    paths: RuntimePaths,
}

impl Sidecar {
    /// 启动 crawler 进程并开始转发其输出。
    ///
    /// `state` 用于在收消息时更新累加中的抓取任务并关联 PDF 请求。
    pub fn spawn(app: &AppHandle, state: Arc<AppState>) -> Result<Self> {
        let paths = RuntimePaths::resolve(app)?;
        paths.verify()?;

        std::fs::create_dir_all(&paths.auth_dir).ok();
        std::fs::create_dir_all(&paths.staging_dir).ok();

        let mut command = Command::new(&paths.node_exe);
        command
            .arg(&paths.crawler_entry)
            .current_dir(paths.crawler_entry.parent().unwrap_or(Path::new(".")))
            .env("PLAYWRIGHT_BROWSERS_PATH", &paths.browsers_dir)
            // 不使用 playwright 的自动下载行为，浏览器一律来自随包目录
            .env("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = command.spawn().map_err(|e| {
            CrawlError::new(CrawlErrorKind::PageRenderFailed)
                .with_detail(format!("无法启动 crawler 进程：{e}"))
        })?;

        let stdin = child.stdin.take().ok_or_else(|| {
            CrawlError::new(CrawlErrorKind::PageRenderFailed).with_detail("无法获取 crawler stdin")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            CrawlError::new(CrawlErrorKind::PageRenderFailed).with_detail("无法获取 crawler stdout")
        })?;
        let stderr = child.stderr.take();

        spawn_stdout_reader(app.clone(), state, stdout);
        if let Some(stderr) = stderr {
            spawn_stderr_reader(stderr);
        }

        Ok(Self {
            stdin: Arc::new(Mutex::new(stdin)),
            child: Arc::new(Mutex::new(Some(child))),
            paths,
        })
    }

    pub fn paths(&self) -> &RuntimePaths {
        &self.paths
    }

    /// 发送一条命令。每条命令占一行（NDJSON）。
    pub async fn send(&self, message: &Outbound) -> Result<()> {
        let mut line = serde_json::to_string(message).map_err(|e| {
            CrawlError::new(CrawlErrorKind::SaveFailed)
                .with_detail(format!("crawler 消息序列化失败：{e}"))
        })?;
        line.push('\n');

        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| CrawlError::new(CrawlErrorKind::SaveFailed).with_detail(format!("写入 crawler 失败：{e}")))?;
        stdin
            .flush()
            .await
            .map_err(|e| CrawlError::new(CrawlErrorKind::SaveFailed).with_detail(format!("刷新 crawler 失败：{e}")))
    }

    /// 请求 crawler 退出。
    pub async fn shutdown(&self) {
        let _ = self.send(&Outbound::Shutdown).await;
        let mut guard = self.child.lock().await;
        if let Some(mut child) = guard.take() {
            let _ = child.kill().await;
        }
    }
}

/// 逐行读取 crawler 的 stdout，交给命令层处理后转发为 Tauri 事件。
fn spawn_stdout_reader<R>(app: AppHandle, state: Arc<AppState>, stdout: R)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();

        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            match serde_json::from_str::<Inbound>(trimmed) {
                Ok(message) => handle_inbound(&app, Arc::clone(&state), message).await,
                Err(e) => {
                    // 无法解析的行属于 crawler 内部问题，记录到 stderr 即可，
                    // 不向用户暴露原始内容（可能含页面数据）
                    eprintln!("[WebScribe] 无法解析 crawler 消息：{e}");
                }
            }
        }
    });
}

/// crawler 的 stderr 只用于诊断，写到宿主进程的 stderr。
fn spawn_stderr_reader<R>(stderr: R)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("[crawler] {line}");
        }
    });
}

/// 把一条 crawler 消息转成前端可订阅的事件。
pub fn forward_event(app: &AppHandle, message: &Inbound) {
    let (event, payload) = match message {
        Inbound::Ready => ("crawler://ready", serde_json::json!({})),
        Inbound::Progress {
            key,
            url,
            state,
            step,
            progress,
        } => (
            "crawler://progress",
            serde_json::json!({
                "key": key,
                "url": url,
                "state": state,
                "stateLabel": state.label(),
                "step": step,
                "progress": progress,
            }),
        ),
        Inbound::Result {
            key,
            url,
            title,
            markdown,
            crawled_at,
            rendered,
            sequence,
        } => (
            "crawler://result",
            serde_json::json!({
                "key": key,
                "url": url,
                "title": title,
                "markdown": markdown,
                "crawledAt": crawled_at,
                "rendered": rendered,
                "sequence": sequence,
            }),
        ),
        Inbound::Error {
            key,
            url,
            error_kind,
            message,
            detail,
        } => (
            "crawler://error",
            serde_json::json!({
                "key": key,
                "url": url,
                "errorKind": error_kind,
                "message": message,
                "detail": detail,
                "isDefense": error_kind.is_defense_mechanism(),
            }),
        ),
        Inbound::Skipped { key, url, reason } => (
            "crawler://skipped",
            serde_json::json!({ "key": key, "url": url, "reason": reason }),
        ),
        Inbound::Done {
            succeeded,
            failed,
            skipped,
        } => (
            "crawler://done",
            serde_json::json!({
                "succeeded": succeeded,
                "failed": failed,
                "skipped": skipped,
            }),
        ),
        Inbound::Log { level, message } => {
            ("crawler://log", serde_json::json!({ "level": level, "message": message }))
        }
        Inbound::LoginOpened { domain } => {
            ("crawler://login-opened", serde_json::json!({ "domain": domain }))
        }
        Inbound::LoginSaved { domain } => {
            ("crawler://login-saved", serde_json::json!({ "domain": domain }))
        }
        Inbound::LoginClosed { domain, saved } => (
            "crawler://login-closed",
            serde_json::json!({ "domain": domain, "saved": saved }),
        ),
        Inbound::Pdf { id, pdf_base64 } => {
            ("crawler://pdf", serde_json::json!({ "id": id, "pdfBase64": pdf_base64 }))
        }
        Inbound::PdfError { id, message, detail } => (
            "crawler://pdf-error",
            serde_json::json!({ "id": id, "message": message, "detail": detail }),
        ),
    };

    if let Err(e) = app.emit(event, payload) {
        eprintln!("[WebScribe] 事件发送失败 {event}：{e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_可执行文件名按平台区分() {
        if cfg!(windows) {
            assert_eq!(node_executable(), "node.exe");
        } else {
            assert_eq!(node_executable(), "node");
        }
    }
}
