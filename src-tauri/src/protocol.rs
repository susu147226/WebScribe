use serde::{Deserialize, Serialize};

use crate::error::CrawlErrorKind;

/// 与 `crawler/src/protocol.ts` 一一对应的 IPC 消息定义。
///
/// 修改此处时必须同步修改 TypeScript 侧，反之亦然。

/// 文档第 36 条规定的任务状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskState {
    Pending,
    Fetching,
    Rendering,
    Extracting,
    Converting,
    Saving,
    Completed,
    Skipped,
    Failed,
    Blocked,
    RequiresLogin,
}

impl TaskState {
    /// 面向用户的中文说明。
    pub fn label(self) -> &'static str {
        match self {
            Self::Pending => "等待中",
            Self::Fetching => "获取页面",
            Self::Rendering => "浏览器渲染",
            Self::Extracting => "提取正文",
            Self::Converting => "转换格式",
            Self::Saving => "保存文件",
            Self::Completed => "已完成",
            Self::Skipped => "已跳过",
            Self::Failed => "失败",
            Self::Blocked => "被阻止",
            Self::RequiresLogin => "需要登录",
        }
    }

    /// 该状态是否代表任务已结束。
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Skipped | Self::Failed | Self::Blocked | Self::RequiresLogin
        )
    }
}

/// 文档第 32 条规定的输出格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    Markdown,
    Pdf,
    Both,
}

impl OutputFormat {
    pub fn writes_markdown(self) -> bool {
        matches!(self, Self::Markdown | Self::Both)
    }

    pub fn writes_pdf(self) -> bool {
        matches!(self, Self::Pdf | Self::Both)
    }
}

/// 图片保存策略（文档第 34 条，经作者确认为两者同时支持）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageStrategy {
    Remote,
    Local,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlOptions {
    pub format: OutputFormat,
    pub image_strategy: ImageStrategy,
    pub follow_pagination: bool,
    pub max_pagination: u32,
    pub separate_output: bool,
    pub obey_robots: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrawlTarget {
    pub raw: String,
    pub key: String,
    #[serde(rename = "siteKey")]
    pub site_key: String,
}

// ---------------------------------------------------------------------------
// Rust → crawler
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "cmd", rename_all = "kebab-case")]
pub enum Outbound {
    Crawl {
        targets: Vec<CrawlTarget>,
        options: CrawlOptions,
        #[serde(rename = "authDir")]
        auth_dir: String,
        #[serde(rename = "stagingDir")]
        staging_dir: String,
        #[serde(rename = "browserPath", skip_serializing_if = "Option::is_none")]
        browser_path: Option<String>,
    },
    Login {
        domain: String,
        #[serde(rename = "startUrl")]
        start_url: String,
        #[serde(rename = "authDir")]
        auth_dir: String,
        #[serde(rename = "browserPath", skip_serializing_if = "Option::is_none")]
        browser_path: Option<String>,
    },
    RenderPdf {
        id: String,
        markdown: String,
        title: String,
        #[serde(rename = "browserPath", skip_serializing_if = "Option::is_none")]
        browser_path: Option<String>,
    },
    Ping,
    Shutdown,
}

// ---------------------------------------------------------------------------
// crawler → Rust
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Inbound {
    Ready,
    Progress {
        key: String,
        url: String,
        state: TaskState,
        step: String,
        progress: f64,
    },
    Result {
        key: String,
        url: String,
        title: String,
        markdown: String,
        #[serde(rename = "crawledAt")]
        crawled_at: String,
        rendered: bool,
        sequence: u32,
    },
    Error {
        key: String,
        url: String,
        #[serde(rename = "errorKind")]
        error_kind: CrawlErrorKind,
        message: String,
        #[serde(default)]
        detail: Option<String>,
    },
    Skipped {
        key: String,
        url: String,
        reason: String,
    },
    Done {
        succeeded: u32,
        failed: u32,
        skipped: u32,
    },
    Log {
        level: String,
        message: String,
    },
    #[serde(rename = "login-opened")]
    LoginOpened { domain: String },
    #[serde(rename = "login-saved")]
    LoginSaved { domain: String },
    #[serde(rename = "login-closed")]
    LoginClosed { domain: String, saved: bool },
    Pdf {
        id: String,
        #[serde(rename = "pdfBase64")]
        pdf_base64: String,
    },
    #[serde(rename = "pdf-error")]
    PdfError {
        id: String,
        message: String,
        #[serde(default)]
        detail: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 十一种任务状态齐备且名称与文档一致() {
        let all = [
            TaskState::Pending,
            TaskState::Fetching,
            TaskState::Rendering,
            TaskState::Extracting,
            TaskState::Converting,
            TaskState::Saving,
            TaskState::Completed,
            TaskState::Skipped,
            TaskState::Failed,
            TaskState::Blocked,
            TaskState::RequiresLogin,
        ];
        assert_eq!(all.len(), 11);
        for state in all {
            let json = serde_json::to_string(&state).unwrap();
            assert_eq!(json, format!("\"{:?}\"", state));
        }
    }

    #[test]
    fn 终结状态判定正确() {
        assert!(TaskState::Completed.is_terminal());
        assert!(TaskState::Failed.is_terminal());
        assert!(TaskState::Blocked.is_terminal());
        assert!(!TaskState::Fetching.is_terminal());
        assert!(!TaskState::Pending.is_terminal());
    }

    #[test]
    fn 输出格式的写出判定() {
        assert!(OutputFormat::Markdown.writes_markdown());
        assert!(!OutputFormat::Markdown.writes_pdf());
        assert!(OutputFormat::Pdf.writes_pdf());
        assert!(!OutputFormat::Pdf.writes_markdown());
        assert!(OutputFormat::Both.writes_markdown());
        assert!(OutputFormat::Both.writes_pdf());
    }

    #[test]
    fn 出站_crawl_消息序列化为_camelCase() {
        let msg = Outbound::Crawl {
            targets: vec![CrawlTarget {
                raw: "https://example.com/a".into(),
                key: "https://example.com/a".into(),
                site_key: "example.com".into(),
            }],
            options: CrawlOptions {
                format: OutputFormat::Markdown,
                image_strategy: ImageStrategy::Remote,
                follow_pagination: false,
                max_pagination: 5,
                separate_output: false,
                obey_robots: true,
            },
            auth_dir: "C:/auth".into(),
            staging_dir: "C:/staging".into(),
            browser_path: None,
        };

        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"cmd\":\"crawl\""));
        assert!(json.contains("\"authDir\""));
        assert!(json.contains("\"stagingDir\""));
        assert!(json.contains("\"siteKey\""));
        assert!(json.contains("\"imageStrategy\":\"remote\""));
        assert!(json.contains("\"followPagination\""));
        // browserPath 为空时不应出现
        assert!(!json.contains("browserPath"));
    }

    #[test]
    fn 入站_progress_消息可解析() {
        let line = r#"{"type":"progress","key":"k","url":"https://e.com/a","state":"Fetching","step":"正在获取页面","progress":0.15}"#;
        let msg: Inbound = serde_json::from_str(line).unwrap();
        match msg {
            Inbound::Progress { state, progress, .. } => {
                assert_eq!(state, TaskState::Fetching);
                assert!((progress - 0.15).abs() < f64::EPSILON);
            }
            other => panic!("期望 Progress，实际为 {other:?}"),
        }
    }

    #[test]
    fn 入站_错误消息可解析且错误类型与文档一致() {
        let line = r#"{"type":"error","key":"k","url":"https://e.com/a","errorKind":"CaptchaDetected","message":"检测到验证码","detail":"页面包含 reCAPTCHA 资源"}"#;
        let msg: Inbound = serde_json::from_str(line).unwrap();
        match msg {
            Inbound::Error { error_kind, detail, .. } => {
                assert_eq!(error_kind, CrawlErrorKind::CaptchaDetected);
                assert!(error_kind.is_defense_mechanism());
                assert!(detail.is_some());
            }
            other => panic!("期望 Error，实际为 {other:?}"),
        }
    }

    #[test]
    fn 入站登录相关消息使用连字符命名() {
        let opened: Inbound =
            serde_json::from_str(r#"{"type":"login-opened","domain":"example.com"}"#).unwrap();
        assert!(matches!(opened, Inbound::LoginOpened { .. }));

        let closed: Inbound = serde_json::from_str(
            r#"{"type":"login-closed","domain":"example.com","saved":true}"#,
        )
        .unwrap();
        assert!(matches!(closed, Inbound::LoginClosed { saved: true, .. }));
    }

    #[test]
    fn 出站控制消息序列化正确() {
        assert_eq!(serde_json::to_string(&Outbound::Ping).unwrap(), r#"{"cmd":"ping"}"#);
        assert_eq!(
            serde_json::to_string(&Outbound::Shutdown).unwrap(),
            r#"{"cmd":"shutdown"}"#
        );
    }
}
