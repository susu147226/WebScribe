use serde::{Deserialize, Serialize};

/// 一个页面的抓取结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageDocument {
    pub title: String,
    pub source_url: String,
    /// 形如 `2026-09-15 10:00:00`。
    pub crawled_at: String,
    /// 正文 Markdown（不含标题与元数据块）。
    pub body: String,
}

/// 渲染单个页面。
///
/// 结构取自文档第 33 条，元数据字段仅 `Source` 与 `Crawled At` 两项。
/// 该条同时规定「具体元数据字段如果未确认：不得自行增加或删除」，因此这里
/// 不添加任何额外字段。
pub fn render(page: &PageDocument) -> String {
    let title = page.title.trim();
    let title = if title.is_empty() { "untitled" } else { title };

    format!(
        "# {title}\n> Source: {source}\n>\n> Crawled At: {at}\n\n{body}\n",
        title = title,
        source = page.source_url.trim(),
        at = page.crawled_at.trim(),
        body = page.body.trim()
    )
}

/// 将同一内容集合的多个页面接续为一份文档。
///
/// 文档第 21 条：同站多页不得简单生成互不关联的文件，除非用户选择独立输出。
/// 此处以 `---` 分隔各页，与文档第 33 条给出的接续示例一致。
pub fn join(pages: &[PageDocument]) -> String {
    pages
        .iter()
        .map(render)
        .collect::<Vec<_>>()
        .join("\n---\n")
}

/// 生成当前时间戳，格式与文档第 33 条示例一致。
pub fn now_timestamp() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(title: &str, url: &str, at: &str, body: &str) -> PageDocument {
        PageDocument {
            title: title.into(),
            source_url: url.into(),
            crawled_at: at.into(),
            body: body.into(),
        }
    }

    #[test]
    fn 单页结构符合文档第_33_条() {
        let doc = render(&page(
            "页面标题",
            "https://example.com/article",
            "2026-09-15 10:00:00",
            "正文……",
        ));
        assert_eq!(
            doc,
            "# 页面标题\n> Source: https://example.com/article\n>\n> Crawled At: 2026-09-15 10:00:00\n\n正文……\n"
        );
    }

    #[test]
    fn 只包含_source_与_crawled_at_两个元数据字段() {
        let doc = render(&page("T", "https://e.com/a", "2026-09-15 10:00:00", "B"));
        let meta_lines: Vec<&str> = doc
            .lines()
            .filter(|l| l.starts_with('>'))
            .collect();
        assert_eq!(
            meta_lines,
            vec!["> Source: https://e.com/a", ">", "> Crawled At: 2026-09-15 10:00:00"]
        );
    }

    #[test]
    fn 空标题回退为_untitled() {
        let doc = render(&page("", "https://e.com/a", "2026-09-15 10:00:00", "B"));
        assert!(doc.starts_with("# untitled\n"));
    }

    #[test]
    fn 多页接续以分隔线相连() {
        let docs = vec![
            page("第 1 页", "https://e.com/a?page=1", "2026-09-15 10:00:00", "正文一"),
            page("第 2 页", "https://e.com/a?page=2", "2026-09-15 10:00:10", "正文二"),
        ];
        let joined = join(&docs);

        assert_eq!(joined.matches("\n---\n").count(), 1);
        assert!(joined.contains("# 第 1 页"));
        assert!(joined.contains("# 第 2 页"));
        assert!(joined.contains("?page=1"));
        assert!(joined.contains("?page=2"));
        // 顺序必须与输入一致
        assert!(joined.find("第 1 页").unwrap() < joined.find("第 2 页").unwrap());
    }

    #[test]
    fn 三页接续符合文档示例() {
        let docs = vec![
            page("Page 1", "https://e.com/1", "2026-09-15 10:00:00", "正文……"),
            page("Page 2", "https://e.com/2", "2026-09-15 10:00:10", "正文……"),
            page("Page 3", "https://e.com/3", "2026-09-15 10:00:20", "正文……"),
        ];
        let joined = join(&docs);
        assert_eq!(joined.matches("\n---\n").count(), 2);
        assert_eq!(joined.matches("> Source:").count(), 3);
    }

    #[test]
    fn 正文首尾空白被裁剪() {
        let doc = render(&page("T", "https://e.com/a", "2026-09-15 10:00:00", "\n\n正文\n\n"));
        assert!(doc.ends_with("\n\n正文\n"));
    }

    #[test]
    fn 时间戳格式正确() {
        let ts = now_timestamp();
        // YYYY-MM-DD HH:MM:SS
        assert_eq!(ts.len(), 19);
        assert_eq!(ts.chars().nth(4), Some('-'));
        assert_eq!(ts.chars().nth(10), Some(' '));
        assert_eq!(ts.chars().nth(13), Some(':'));
    }
}
