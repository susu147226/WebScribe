use crate::error::CrawlErrorKind;
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 查询串中视为敏感的键名。命中后其值一律脱敏。
///
/// 文档第 30、38 条：认证状态属于敏感数据，不得写入日志。
const SENSITIVE_QUERY_KEYS: &[&str] = &[
    "token",
    "access_token",
    "refresh_token",
    "id_token",
    "auth",
    "authorization",
    "key",
    "api_key",
    "apikey",
    "password",
    "passwd",
    "pwd",
    "secret",
    "session",
    "sessionid",
    "session_id",
    "sid",
    "jsessionid",
    "phpsessid",
    "code",
    "signature",
    "sig",
];

/// 视为敏感的请求头名称，其整行内容一律脱敏。
const SENSITIVE_HEADERS: &[&str] = &[
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-api-key",
    "x-auth-token",
];

pub const REDACTED: &str = "[REDACTED]";

/// URL 查询参数中使用的脱敏值。
///
/// `Url::query_pairs_mut().append_pair()` 会对值做百分号编码，`[REDACTED]`
/// 会被写成 `%5BREDACTED%5D`。这里改用纯字母标记，保证脱敏结果可读。
const REDACTED_URL_VALUE: &str = "REDACTED";

/// 键名归一化：转小写并去掉所有分隔符，使 `access_token`、`access-token`、
/// `accessToken`、`ACCESS_TOKEN` 归为同一形式。
fn normalize_key(key: &str) -> String {
    key.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// 判断键名是否敏感（大小写、下划线、连字符、点号均不敏感）。
pub fn is_sensitive_key(key: &str) -> bool {
    let normalized = normalize_key(key);
    if normalized.is_empty() {
        return false;
    }

    SENSITIVE_QUERY_KEYS.iter().any(|candidate| {
        let candidate = normalize_key(candidate);
        !candidate.is_empty()
            && (normalized == candidate || normalized.ends_with(&candidate))
    })
}

/// 脱敏 URL：保留 scheme/host/path 用于排查，掩掉敏感查询参数与 fragment。
pub fn redact_url(raw: &str) -> String {
    let Ok(mut url) = url::Url::parse(raw) else {
        // 无法解析时保留协议与主机部分，丢弃可能含凭据的其余内容
        return match raw.split_once('?') {
            Some((head, _)) => format!("{head}?{REDACTED}"),
            None => raw.to_string(),
        };
    };

    if url.query().is_some() {
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .map(|(k, v)| {
                let value = if is_sensitive_key(&k) {
                    REDACTED_URL_VALUE.to_string()
                } else {
                    v.into_owned()
                };
                (k.into_owned(), value)
            })
            .collect();

        let mut serializer = url.query_pairs_mut();
        serializer.clear();
        for (k, v) in &pairs {
            serializer.append_pair(k, v);
        }
    }

    if url.fragment().is_some() {
        let _ = url.set_fragment(None);
    }

    url.to_string()
}

/// 脱敏任意文本：掩掉敏感请求头整行与 `key=value` 形式的凭据。
pub fn redact_text(input: &str) -> String {
    input
        .lines()
        .map(redact_line)
        .collect::<Vec<_>>()
        .join("\n")
}

fn redact_line(line: &str) -> String {
    let trimmed = line.trim_start();
    if let Some((name, _)) = trimmed.split_once(':') {
        if SENSITIVE_HEADERS
            .iter()
            .any(|h| name.trim().eq_ignore_ascii_case(h))
        {
            let indent = &line[..line.len() - trimmed.len()];
            return format!("{indent}{}: {REDACTED}", name.trim());
        }
    }

    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    loop {
        let Some(eq) = rest.find('=') else {
            out.push_str(rest);
            break;
        };

        let head = &rest[..eq];
        let after = &rest[eq + 1..];

        // 键名是 `=` 之前最后一个标识符片段，保留其前面的分隔符（如 `&`）
        let key_start = head
            .rfind(|c: char| !(c.is_alphanumeric() || c == '_' || c == '-' || c == '.'))
            .map(|i| i + 1)
            .unwrap_or(0);
        let key = &head[key_start..];

        out.push_str(&head[..key_start]);
        out.push_str(key);
        out.push('=');

        let value_end = after
            .find(|c: char| c == '&' || c == ';' || c.is_whitespace())
            .unwrap_or(after.len());

        if is_sensitive_key(key) {
            out.push_str(REDACTED);
        } else {
            out.push_str(&after[..value_end]);
        }

        rest = &after[value_end..];

        // `rest` 此时以分隔符开头；若其后已无 `=`，剩余内容直接收尾，
        // 同时保证空值（如 `b=`）不会导致死循环
        if !rest.contains('=') {
            out.push_str(rest);
            break;
        }
    }
    out
}

/// 一条结构化日志记录。
///
/// 字段取自文档第 38 条允许记录的范围：时间、URL、任务 ID、操作阶段、耗时、
/// 状态、错误类型。凭据类字段不在此结构中出现。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<CrawlErrorKind>,
}

impl LogEntry {
    pub fn new(stage: impl Into<String>) -> Self {
        Self {
            timestamp: chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string(),
            task_id: None,
            url: None,
            stage: stage.into(),
            duration_ms: None,
            state: None,
            error_kind: None,
        }
    }

    pub fn task(mut self, id: impl Into<String>) -> Self {
        self.task_id = Some(id.into());
        self
    }

    /// URL 在写入前自动脱敏。
    pub fn url(mut self, raw: impl AsRef<str>) -> Self {
        self.url = Some(redact_url(raw.as_ref()));
        self
    }

    pub fn duration(mut self, ms: u64) -> Self {
        self.duration_ms = Some(ms);
        self
    }

    pub fn state(mut self, s: impl Into<String>) -> Self {
        self.state = Some(s.into());
        self
    }

    pub fn error(mut self, kind: CrawlErrorKind) -> Self {
        self.error_kind = Some(kind);
        self
    }
}

/// 追加写入 JSONL 日志文件。
pub struct Logger {
    path: PathBuf,
    file: Mutex<File>,
}

impl Logger {
    pub fn new(dir: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(format!(
            "webscribe-{}.jsonl",
            chrono::Local::now().format("%Y%m%d")
        ));
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Self {
            path,
            file: Mutex::new(file),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn write(&self, entry: &LogEntry) -> std::io::Result<()> {
        let mut line = serde_json::to_string(entry)?;
        line.push('\n');
        let mut file = self.file.lock().unwrap_or_else(|e| e.into_inner());
        file.write_all(line.as_bytes())?;
        file.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 敏感键名被识别() {
        assert!(is_sensitive_key("token"));
        assert!(is_sensitive_key("access_token"));
        assert!(is_sensitive_key("access-token"));
        assert!(is_sensitive_key("access.token"));
        assert!(is_sensitive_key("accessToken"));
        assert!(is_sensitive_key("API_KEY"));
        assert!(is_sensitive_key("apiKey"));
        assert!(is_sensitive_key("password"));
        assert!(is_sensitive_key("JSESSIONID"));
        assert!(is_sensitive_key("x-auth-token"));
        assert!(!is_sensitive_key("page"));
        assert!(!is_sensitive_key("id"));
        assert!(!is_sensitive_key("q"));
        assert!(!is_sensitive_key(""));
    }

    #[test]
    fn url_中的敏感查询参数被脱敏() {
        let out = redact_url("https://example.com/a?token=abc123&page=2");
        assert!(!out.contains("abc123"));
        assert!(out.contains("page=2"));
        assert!(out.contains("token=REDACTED"));
    }

    #[test]
    fn url_脱敏结果不含百分号编码的方括号() {
        // 回归：早期实现写入 `[REDACTED]`，被 append_pair 编码为 %5BREDACTED%5D
        let out = redact_url("https://example.com/a?accessToken=zzz");
        assert!(!out.contains("%5B"));
        assert!(!out.contains("zzz"));
        assert!(out.contains("REDACTED"));
    }

    #[test]
    fn url_中的_fragment_被移除() {
        let out = redact_url("https://example.com/a#access_token=zzz");
        assert!(!out.contains("zzz"));
        assert!(!out.contains('#'));
    }

    #[test]
    fn 普通_url_基本保持不变() {
        let out = redact_url("https://example.com/article?id=7");
        assert!(out.starts_with("https://example.com/article"));
        assert!(out.contains("id=7"));
    }

    #[test]
    fn 无法解析的_url_丢弃查询串() {
        let out = redact_url("这不是URL?token=secret");
        assert!(!out.contains("secret"));
    }

    #[test]
    fn 敏感请求头整行被脱敏() {
        let text = "GET /a HTTP/1.1\nAuthorization: Bearer eyJhbGciOi\nCookie: sid=abcdef\nHost: example.com";
        let out = redact_text(text);
        assert!(!out.contains("eyJhbGciOi"));
        assert!(!out.contains("abcdef"));
        assert!(out.contains("Host: example.com"));
        assert!(out.contains(REDACTED));
    }

    #[test]
    fn 正文中的_key_value_凭据被脱敏() {
        let out = redact_text("url=https://x.com?a=1&token=sekrit&b=2");
        assert!(!out.contains("sekrit"));
        assert!(out.contains("a=1"));
        assert!(out.contains("b=2"));
    }

    #[test]
    fn 脱敏保留分隔符不吞字符() {
        // 回归：早期实现会把 [REDACTED] 与后续参数之间的 `&` 丢掉
        let out = redact_text("token=sekrit&b=2&c=3");
        assert_eq!(out, "token=[REDACTED]&b=2&c=3");
    }

    #[test]
    fn 空值不会导致死循环() {
        // 回归：`b=` 会让旧实现无限循环
        assert_eq!(redact_text("a=1&b=&c=3"), "a=1&b=&c=3");
        assert_eq!(redact_text("b="), "b=");
        assert_eq!(redact_text("="), "=");
        assert_eq!(redact_text("a="), "a=");
    }

    #[test]
    fn 无等号文本原样保留() {
        assert_eq!(redact_text("普通日志没有键值对"), "普通日志没有键值对");
        assert_eq!(redact_text(""), "");
    }

    #[test]
    fn 多行文本逐行脱敏() {
        let out = redact_text("a=1\nCookie: sid=zzz\nb=2");
        assert!(out.contains("a=1"));
        assert!(out.contains("b=2"));
        assert!(!out.contains("zzz"));
        assert_eq!(out.lines().count(), 3);
    }

    #[test]
    fn 日志条目自动脱敏_url() {
        let entry = LogEntry::new("fetch").url("https://example.com/a?token=zzz");
        assert!(!entry.url.unwrap().contains("zzz"));
    }

    #[test]
    fn 日志写入_jsonl() {
        let dir = std::env::temp_dir().join(format!("websribe-log-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let logger = Logger::new(&dir).unwrap();
        logger
            .write(
                &LogEntry::new("fetch")
                    .task("t1")
                    .url("https://example.com/a?token=x")
                    .duration(120)
                    .state("Completed"),
            )
            .unwrap();

        let content = std::fs::read_to_string(logger.path()).unwrap();
        assert!(content.contains("\"stage\":\"fetch\""));
        assert!(content.contains("\"duration_ms\":120"));
        assert!(content.contains("\"state\":\"Completed\""));
        assert!(!content.contains("token=x"));
        assert_eq!(content.lines().count(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 日志条目不含凭据字段() {
        let entry = LogEntry::new("fetch");
        let json = serde_json::to_string(&entry).unwrap();
        for forbidden in ["password", "cookie", "token", "authorization", "session"] {
            assert!(
                !json.to_ascii_lowercase().contains(forbidden),
                "日志字段不应包含 {forbidden}"
            );
        }
    }
}
