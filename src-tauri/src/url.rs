use crate::error::{CrawlError, CrawlErrorKind, Result};
use serde::{Deserialize, Serialize};
use url::Url;

/// 文档第 16 条：一次任务最多 10 个 URL。
pub const MAX_URLS: usize = 10;

/// 一个通过校验的 URL 条目。
///
/// `raw` 保留用户输入的原始形式用于实际抓取，`key` 为规范化后的身份标识
/// 仅用于查重。两者分开是必要的：去掉末尾 `/` 等规范化操作可能改变服务器
/// 返回的内容，因此只用于判断「是否同一 URL」，不用于发起请求。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UrlEntry {
    pub raw: String,
    pub key: String,
}

/// 校验单个 URL。
///
/// 仅接受 http / https。缺少协议头的输入（如 `example.com/a`）判定为
/// `InvalidURL` —— 文档第 17 条只要求「基本合法性检查」，未授权程序自动
/// 补全协议，故不猜测用户意图。
pub fn validate(raw: &str) -> Result<Url> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(CrawlError::new(CrawlErrorKind::InvalidURL)
            .with_detail("URL 为空"));
    }

    let parsed = Url::parse(trimmed).map_err(|e| {
        CrawlError::new(CrawlErrorKind::InvalidURL)
            .with_url(trimmed)
            .with_detail(e.to_string())
    })?;

    match parsed.scheme() {
        "http" | "https" => {}
        other => {
            return Err(CrawlError::new(CrawlErrorKind::InvalidURL)
                .with_url(trimmed)
                .with_detail(format!("不支持的协议：{other}（仅支持 http / https）")));
        }
    }

    if parsed.host_str().is_none_or(str::is_empty) {
        return Err(CrawlError::new(CrawlErrorKind::InvalidURL)
            .with_url(trimmed)
            .with_detail("缺少主机名"));
    }

    Ok(parsed)
}

/// 计算 URL 的规范化身份标识。
///
/// 规则（经作者确认）：
/// - scheme 与 host 转小写（`url` crate 解析时已自动完成）
/// - 去除默认端口（`url` crate 解析时已自动完成）
/// - 去除末尾 `/`
/// - 保留 query 原样
/// - 保留 fragment（部分 SPA 使用 fragment 路由）
pub fn normalize(url: &Url) -> String {
    let mut out = String::with_capacity(url.as_str().len());

    out.push_str(url.scheme());
    out.push_str("://");
    out.push_str(url.host_str().unwrap_or_default());
    if let Some(port) = url.port() {
        out.push(':');
        out.push_str(&port.to_string());
    }

    let path = url.path();
    let path = if path == "/" {
        ""
    } else {
        path.strip_suffix('/').unwrap_or(path)
    };
    out.push_str(path);

    if let Some(query) = url.query() {
        out.push('?');
        out.push_str(query);
    }
    if let Some(fragment) = url.fragment() {
        out.push('#');
        out.push_str(fragment);
    }

    out
}

/// 查重结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DedupOutcome {
    /// 首次出现的条目，按输入顺序。
    pub unique: Vec<UrlEntry>,
    /// 与前面条目重复的条目，附其为第几个的唯一项（从 0 起）。
    pub duplicates: Vec<(UrlEntry, usize)>,
}

/// 逐条校验并查重。
///
/// 文档第 18 条：同一次任务中同一 URL 不得重复访问。文档第 16 条：超过
/// 10 个必须报错，不得静默截断，也不得自动只取前 10 个。
pub fn validate_and_dedup(raw_urls: &[String]) -> Result<DedupOutcome> {
    let non_empty: Vec<&String> = raw_urls
        .iter()
        .filter(|u| !u.trim().is_empty())
        .collect();

    if non_empty.is_empty() {
        return Err(CrawlError::new(CrawlErrorKind::InvalidURL)
            .with_detail("未提供任何 URL"));
    }

    if non_empty.len() > MAX_URLS {
        return Err(CrawlError::new(CrawlErrorKind::InvalidURL).with_detail(format!(
            "一次任务最多支持 {MAX_URLS} 个 URL，当前提供了 {} 个。请减少后重试。",
            non_empty.len()
        )));
    }

    let mut unique: Vec<UrlEntry> = Vec::with_capacity(non_empty.len());
    let mut duplicates: Vec<(UrlEntry, usize)> = Vec::new();
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    for raw in non_empty {
        let parsed = validate(raw)?;
        let key = normalize(&parsed);
        let entry = UrlEntry {
            raw: raw.trim().to_string(),
            key: key.clone(),
        };

        match seen.get(&key) {
            Some(&index) => duplicates.push((entry, index)),
            None => {
                seen.insert(key, unique.len());
                unique.push(entry);
            }
        }
    }

    Ok(DedupOutcome {
        unique,
        duplicates,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn norm(s: &str) -> String {
        normalize(&validate(s).unwrap())
    }

    #[test]
    fn 合法_url_通过校验() {
        assert!(validate("https://example.com/a").is_ok());
        assert!(validate("http://example.com").is_ok());
        assert!(validate("https://example.com:8080/a?b=1#c").is_ok());
        assert!(validate("  https://example.com/a  ").is_ok());
    }

    #[test]
    fn 空_url_与非法_url_被拒绝() {
        assert!(validate("").is_err());
        assert!(validate("   ").is_err());
        assert!(validate("not a url").is_err());
        assert!(validate("ftp://example.com/a").is_err());
        assert!(validate("javascript:alert(1)").is_err());
        assert!(validate("file:///c:/a.txt").is_err());
    }

    #[test]
    fn 缺少协议头的输入被拒绝而非自动补全() {
        assert!(validate("example.com/a").is_err());
        assert!(validate("www.example.com").is_err());
    }

    #[test]
    fn 规范化转小写() {
        assert_eq!(norm("HTTPS://EXAMPLE.COM/A"), "https://example.com/A");
    }

    #[test]
    fn 规范化去除默认端口() {
        assert_eq!(norm("http://example.com:80/a"), "http://example.com/a");
        assert_eq!(norm("https://example.com:443/a"), "https://example.com/a");
    }

    #[test]
    fn 规范化保留非默认端口() {
        assert_eq!(norm("https://example.com:8443/a"), "https://example.com:8443/a");
    }

    #[test]
    fn 规范化去除末尾斜杠() {
        assert_eq!(norm("https://example.com/"), "https://example.com");
        assert_eq!(norm("https://example.com/a/"), "https://example.com/a");
        assert_eq!(norm("https://example.com/a"), "https://example.com/a");
    }

    #[test]
    fn 规范化保留_fragment_与_query() {
        assert_eq!(
            norm("https://example.com/a?x=1#sec"),
            "https://example.com/a?x=1#sec"
        );
        assert_eq!(norm("https://example.com/a#frag"), "https://example.com/a#frag");
    }

    #[test]
    fn 仅_fragment_不同的_url_视为不同() {
        assert_ne!(norm("https://example.com/a#p1"), norm("https://example.com/a#p2"));
    }

    #[test]
    fn 仅_query_不同的_url_视为不同() {
        assert_ne!(norm("https://example.com/a?p=1"), norm("https://example.com/a?p=2"));
    }

    #[test]
    fn 查重保留首次出现并报告重复() {
        let input = vec![
            "https://example.com/a".to_string(),
            "https://example.com/b".to_string(),
            "https://example.com/a".to_string(),
        ];
        let out = validate_and_dedup(&input).unwrap();
        assert_eq!(out.unique.len(), 2);
        assert_eq!(out.unique[0].raw, "https://example.com/a");
        assert_eq!(out.unique[1].raw, "https://example.com/b");
        assert_eq!(out.duplicates.len(), 1);
        assert_eq!(out.duplicates[0].1, 0);
    }

    #[test]
    fn 规范化后相同即视为重复() {
        let input = vec![
            "https://example.com/a".to_string(),
            "https://EXAMPLE.com/a/".to_string(),
        ];
        let out = validate_and_dedup(&input).unwrap();
        assert_eq!(out.unique.len(), 1);
        assert_eq!(out.duplicates.len(), 1);
    }

    #[test]
    fn 恰好十个_url_通过() {
        let input: Vec<String> = (0..10)
            .map(|i| format!("https://example.com/{i}"))
            .collect();
        let out = validate_and_dedup(&input).unwrap();
        assert_eq!(out.unique.len(), 10);
    }

    #[test]
    fn 十一个_url_报错而非静默截断() {
        let input: Vec<String> = (0..11)
            .map(|i| format!("https://example.com/{i}"))
            .collect();
        let err = validate_and_dedup(&input).unwrap_err();
        assert_eq!(err.kind, CrawlErrorKind::InvalidURL);
        assert!(err.detail.unwrap().contains("11"));
    }

    #[test]
    fn 空列表报错() {
        assert!(validate_and_dedup(&[]).is_err());
        assert!(validate_and_dedup(&["".to_string(), "  ".to_string()]).is_err());
    }

    #[test]
    fn 空白行被忽略不占用配额() {
        let mut input: Vec<String> = (0..10)
            .map(|i| format!("https://example.com/{i}"))
            .collect();
        input.push(String::new());
        input.push("   ".to_string());
        let out = validate_and_dedup(&input).unwrap();
        assert_eq!(out.unique.len(), 10);
    }

    #[test]
    fn 非法_url_在查重时直接报错() {
        let input = vec![
            "https://example.com/a".to_string(),
            "这不是URL".to_string(),
        ];
        assert!(validate_and_dedup(&input).is_err());
    }
}
