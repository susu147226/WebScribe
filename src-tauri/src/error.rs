use serde::{Deserialize, Serialize};

/// 文档第 37 条规定的统一错误类型。
///
/// 序列化名称必须与文档列出的名称逐字一致，前端按此展示。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CrawlErrorKind {
    InvalidURL,
    NetworkError,
    Timeout,
    HTTPError,
    AccessDenied,
    RateLimited,
    CaptchaDetected,
    ChallengeDetected,
    LoginRequired,
    PageRenderFailed,
    ContentExtractionFailed,
    MarkdownConversionFailed,
    PDFConversionFailed,
    SaveFailed,
    DuplicateURL,
}

impl CrawlErrorKind {
    /// 面向用户的中文说明。文档第 37 条要求错误必须明确展示。
    pub fn message(self) -> &'static str {
        match self {
            Self::InvalidURL => "URL 格式不合法",
            Self::NetworkError => "网络请求失败",
            Self::Timeout => "请求超时",
            Self::HTTPError => "服务器返回错误状态码",
            Self::AccessDenied => "访问被拒绝",
            Self::RateLimited => "请求过于频繁，已被限流",
            Self::CaptchaDetected => "检测到验证码，需用户手动处理",
            Self::ChallengeDetected => "检测到访问验证（Challenge），需用户手动处理",
            Self::LoginRequired => "该页面需要登录",
            Self::PageRenderFailed => "页面渲染失败",
            Self::ContentExtractionFailed => "无法提取正文内容",
            Self::MarkdownConversionFailed => "转换为 Markdown 失败",
            Self::PDFConversionFailed => "生成 PDF 失败",
            Self::SaveFailed => "保存文件失败",
            Self::DuplicateURL => "重复 URL，已跳过",
        }
    }

    /// 该错误是否属于「网站防御机制」——文档第 24、26 条要求这类情况必须
    /// 停止自动抓取并交还用户处理，任何情况下不得尝试绕过。
    pub fn is_defense_mechanism(self) -> bool {
        matches!(
            self,
            Self::CaptchaDetected | Self::ChallengeDetected | Self::AccessDenied
        )
    }
}

impl std::fmt::Display for CrawlErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

/// 携带上下文的抓取错误。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrawlError {
    pub kind: CrawlErrorKind,
    pub message: String,
    /// 触发错误的 URL，若与请求无关则为 None。
    pub url: Option<String>,
    /// 附加诊断信息（如 HTTP 状态码）。不得包含凭据。
    pub detail: Option<String>,
}

impl CrawlError {
    pub fn new(kind: CrawlErrorKind) -> Self {
        Self {
            kind,
            message: kind.message().to_string(),
            url: None,
            detail: None,
        }
    }

    pub fn with_url(mut self, url: impl Into<String>) -> Self {
        self.url = Some(url.into());
        self
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// 面向用户的完整说明：优先展示 `detail`（更具体），否则退回 `message`。
    ///
    /// 文档第 37 条要求错误必须明确展示、不得将失败伪装成成功，因此前端
    /// 拿到的是可直接呈现的文本。
    pub fn message_with_detail(&self) -> String {
        match &self.detail {
            Some(detail) if !detail.trim().is_empty() => {
                format!("{}：{}", self.message, detail)
            }
            _ => self.message.clone(),
        }
    }
}

impl std::fmt::Display for CrawlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match (&self.url, &self.detail) {
            (Some(url), Some(detail)) => write!(f, "{} [{}] ({})", self.message, url, detail),
            (Some(url), None) => write!(f, "{} [{}]", self.message, url),
            (None, Some(detail)) => write!(f, "{} ({})", self.message, detail),
            (None, None) => f.write_str(&self.message),
        }
    }
}

impl std::error::Error for CrawlError {}

pub type Result<T> = std::result::Result<T, CrawlError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 全部十五种错误类型齐备且名称与文档一致() {
        let all = [
            CrawlErrorKind::InvalidURL,
            CrawlErrorKind::NetworkError,
            CrawlErrorKind::Timeout,
            CrawlErrorKind::HTTPError,
            CrawlErrorKind::AccessDenied,
            CrawlErrorKind::RateLimited,
            CrawlErrorKind::CaptchaDetected,
            CrawlErrorKind::ChallengeDetected,
            CrawlErrorKind::LoginRequired,
            CrawlErrorKind::PageRenderFailed,
            CrawlErrorKind::ContentExtractionFailed,
            CrawlErrorKind::MarkdownConversionFailed,
            CrawlErrorKind::PDFConversionFailed,
            CrawlErrorKind::SaveFailed,
            CrawlErrorKind::DuplicateURL,
        ];
        assert_eq!(all.len(), 15);

        for kind in all {
            let json = serde_json::to_string(&kind).unwrap();
            assert_eq!(json, format!("\"{:?}\"", kind));
        }
    }

    #[test]
    fn 防御机制错误被正确识别() {
        assert!(CrawlErrorKind::CaptchaDetected.is_defense_mechanism());
        assert!(CrawlErrorKind::ChallengeDetected.is_defense_mechanism());
        assert!(CrawlErrorKind::AccessDenied.is_defense_mechanism());
        assert!(!CrawlErrorKind::NetworkError.is_defense_mechanism());
        assert!(!CrawlErrorKind::Timeout.is_defense_mechanism());
    }

    #[test]
    fn 错误展示包含_url_与细节() {
        let err = CrawlError::new(CrawlErrorKind::HTTPError)
            .with_url("https://example.com/a")
            .with_detail("HTTP 500");
        let text = err.to_string();
        assert!(text.contains("https://example.com/a"));
        assert!(text.contains("HTTP 500"));
    }
}
