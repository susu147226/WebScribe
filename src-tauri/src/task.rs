use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::document::{self, PageDocument};
use crate::error::{CrawlError, CrawlErrorKind, Result};
use crate::naming::{sanitize_stem, unique_path};
use crate::protocol::{CrawlOptions, ImageStrategy};

/// 图片在 Markdown 中的占位前缀，与 `crawler/src/markdown/convert.ts` 保持一致。
const ASSETS_PLACEHOLDER: &str = "{{ASSETS}}";

/// 一次抓取任务的累积状态。
///
/// crawler 每抓完一页就推送一条 `result`，此处按原始 URL（`key`）归集，
/// 待 `done` 到达后再统一组装文档并落盘——因为同站多页需要合并为单文件，
/// 必须等全部页面到齐才能确定最终内容。
#[derive(Debug)]
pub struct CrawlRun {
    pub id: String,
    pub save_dir: PathBuf,
    pub options: CrawlOptions,
    /// 图片暂存目录，与下发给 crawler 的 `stagingDir` 一致。
    pub staging_dir: PathBuf,
    /// key → (sequence → 页面文档)，BTreeMap 保证按页码顺序拼接。
    pages: BTreeMap<String, BTreeMap<u32, PageDocument>>,
    /// key 的首次出现顺序，决定输出顺序与文件命名。
    keys: Vec<String>,
    /// 抓取失败的条目。
    pub failures: Vec<FailureRecord>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FailureRecord {
    pub key: String,
    pub url: String,
    pub error_kind: CrawlErrorKind,
    pub message: String,
    pub detail: Option<String>,
    /// 是否命中网站防御机制（文档第 24、26 条）。
    pub is_defense: bool,
}

/// 一个条目产出的文件。
#[derive(Debug, Clone, Serialize)]
pub struct OutputFile {
    pub key: String,
    pub title: String,
    pub markdown_path: Option<String>,
    pub pdf_path: Option<String>,
}

impl CrawlRun {
    pub fn new(
        id: String,
        save_dir: PathBuf,
        options: CrawlOptions,
        staging_dir: PathBuf,
    ) -> Self {
        Self {
            id,
            save_dir,
            options,
            staging_dir,
            pages: BTreeMap::new(),
            keys: Vec::new(),
            failures: Vec::new(),
        }
    }

    pub fn record_page(
        &mut self,
        key: &str,
        sequence: u32,
        title: String,
        url: String,
        markdown: String,
        crawled_at: String,
    ) {
        if !self.pages.contains_key(key) {
            self.keys.push(key.to_string());
        }
        self.pages.entry(key.to_string()).or_default().insert(
            sequence,
            PageDocument {
                title,
                source_url: url,
                crawled_at,
                body: markdown,
            },
        );
    }

    pub fn record_failure(&mut self, failure: FailureRecord) {
        self.failures.push(failure);
    }

    /// 某个条目是否已收到结果。
    pub fn has_pages(&self, key: &str) -> bool {
        self.pages.get(key).is_some_and(|p| !p.is_empty())
    }

    /// 组装并写出全部文档。
    ///
    /// 文档第 21 条：同站多页默认接续为单文件，仅在用户选择「独立输出」时
    /// 拆成多个文件。
    pub fn write_outputs(&self) -> Result<Vec<OutputFile>> {
        let mut written = Vec::new();

        for key in &self.keys {
            let Some(pages) = self.pages.get(key) else {
                continue;
            };
            if pages.is_empty() {
                continue;
            }

            let ordered: Vec<&PageDocument> = pages.values().collect();

            if self.options.separate_output && ordered.len() > 1 {
                for page in &ordered {
                    written.push(self.write_single(page)?);
                }
            } else {
                let joined = document::join(
                    &ordered.iter().map(|p| (*p).clone()).collect::<Vec<_>>(),
                );
                let title = ordered[0].title.clone();
                written.push(self.write_document(key, &title, &joined)?);
            }
        }

        Ok(written)
    }

    /// 将单页写为独立文件。
    fn write_single(&self, page: &PageDocument) -> Result<OutputFile> {
        let content = document::render(page);
        self.write_document("", &page.title, &content)
    }

    /// 写出文档：处理图片占位符、净化文件名、按格式输出 Markdown / PDF。
    fn write_document(&self, key: &str, title: &str, content: &str) -> Result<OutputFile> {
        let stem = sanitize_stem(title);

        // 先落定 Markdown 文件路径，以确定资产目录名
        let markdown_path = if self.options.format.writes_markdown() {
            let (path, body) = self.materialize_assets(&stem, content)?;
            std::fs::write(&path, body.as_bytes()).map_err(|e| {
                CrawlError::new(CrawlErrorKind::SaveFailed)
                    .with_detail(format!("写入 {} 失败：{e}", path.display()))
            })?;
            Some(path)
        } else {
            None
        };

        // PDF 由 crawler 渲染，内容与 Markdown 保持一致
        let pdf_path = if self.options.format.writes_pdf() {
            Some(self.render_pdf_path(&stem, content)?)
        } else {
            None
        };

        Ok(OutputFile {
            key: key.to_string(),
            title: title.to_string(),
            markdown_path: markdown_path.map(|p| p.display().to_string()),
            pdf_path: pdf_path.map(|p| p.display().to_string()),
        })
    }

    /// 把 Markdown 中引用的暂存图片搬到 `<stem>.assets/`，并替换占位符。
    ///
    /// 文档第 34 条：图片策略为 `local` 时使用相对路径引用本地图片。
    fn materialize_assets(&self, stem: &str, content: &str) -> Result<(PathBuf, String)> {
        // 不用 unique_path 提前占位，否则 Markdown 与资产目录名会错位；
        // 先确定唯一主干名，再让两者共用它。
        let (markdown_path, assets_dir) = self.reserve_names(stem);

        if !content.contains(ASSETS_PLACEHOLDER) {
            return Ok((markdown_path, content.to_string()));
        }

        // 占位符只在 local 策略下由 crawler 写入；remote 策略下不该出现。
        // 真出现时说明两端策略不一致，此时原样返回，避免静默改写用户内容。
        if self.options.image_strategy != ImageStrategy::Local {
            eprintln!("[WebScribe] 检测到非预期图片占位符，图片策略可能不一致");
            return Ok((markdown_path, content.to_string()));
        }

        let staging_assets = self.staging_dir.join("assets");
        let relative = assets_dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("{stem}.assets"));

        let mut used: HashMap<String, ()> = HashMap::new();
        let mut failed = false;

        for name in extract_asset_names(content) {
            if used.contains_key(&name) {
                continue;
            }
            let source = staging_assets.join(&name);
            if !source.is_file() {
                failed = true;
                continue;
            }
            std::fs::create_dir_all(&assets_dir).map_err(|e| {
                CrawlError::new(CrawlErrorKind::SaveFailed)
                    .with_detail(format!("创建资产目录 {} 失败：{e}", assets_dir.display()))
            })?;
            let destination = assets_dir.join(&name);
            std::fs::copy(&source, &destination).map_err(|e| {
                CrawlError::new(CrawlErrorKind::SaveFailed)
                    .with_detail(format!("复制图片 {} 失败：{e}", source.display()))
            })?;
            used.insert(name, ());
        }

        if failed {
            // 有图片未取到，保留远程 URL 已无从恢复，退化为不含资产目录的引用
            eprintln!("[WebScribe] 部分图片未能从暂存目录取回，已跳过");
        }

        let body = content.replace(ASSETS_PLACEHOLDER, &relative);
        Ok((markdown_path, body))
    }

    /// 为 Markdown 与资产目录预留一对不冲突的名字。
    fn reserve_names(&self, stem: &str) -> (PathBuf, PathBuf) {
        let mut candidate_stem = stem.to_string();
        let mut n: u32 = 0;

        loop {
            let markdown = self.save_dir.join(format!("{candidate_stem}.md"));
            let assets = self.save_dir.join(format!("{candidate_stem}.assets"));

            let markdown_taken = markdown.exists();
            let assets_taken = assets.exists();

            // 纯 PDF 输出时不占用 .md 名字，只看资产目录是否冲突
            let conflict = if self.options.format.writes_markdown() {
                markdown_taken || assets_taken
            } else {
                assets_taken
            };

            if !conflict {
                return (markdown, assets);
            }

            n = n.saturating_add(1);
            candidate_stem = format!("{stem}-{n}");
        }
    }

    /// 生成 PDF 文件路径（内容由 crawler 渲染后回传）。
    fn render_pdf_path(&self, stem: &str, _content: &str) -> Result<PathBuf> {
        Ok(unique_path(&self.save_dir, stem, "pdf"))
    }

    /// 需要渲染 PDF 的文档清单，供命令层逐一向 crawler 请求。
    pub fn pdf_jobs(&self) -> Vec<PdfJob> {
        if !self.options.format.writes_pdf() {
            return Vec::new();
        }

        let mut jobs = Vec::new();
        for key in &self.keys {
            let Some(pages) = self.pages.get(key) else {
                continue;
            };
            if pages.is_empty() {
                continue;
            }
            let ordered: Vec<PageDocument> = pages.values().cloned().collect();

            if self.options.separate_output && ordered.len() > 1 {
                for page in &ordered {
                    jobs.push(PdfJob {
                        id: format!("{key}#{}", page.source_url),
                        title: page.title.clone(),
                        markdown: document::render(page),
                    });
                }
            } else {
                jobs.push(PdfJob {
                    id: key.clone(),
                    title: ordered[0].title.clone(),
                    markdown: document::join(&ordered),
                });
            }
        }
        jobs
    }

    /// PDF 字节回传后写入磁盘。
    pub fn write_pdf_for(&self, job: &PdfJob, bytes: &[u8]) -> Result<PathBuf> {
        std::fs::create_dir_all(&self.save_dir).map_err(|e| {
            CrawlError::new(CrawlErrorKind::SaveFailed)
                .with_detail(format!("创建保存目录失败：{e}"))
        })?;
        let stem = sanitize_stem(&job.title);
        let path = unique_path(&self.save_dir, &stem, "pdf");
        std::fs::write(&path, bytes).map_err(|e| {
            CrawlError::new(CrawlErrorKind::SaveFailed)
                .with_detail(format!("写入 {} 失败：{e}", path.display()))
        })?;
        Ok(path)
    }
}

#[derive(Debug, Clone)]
pub struct PdfJob {
    pub id: String,
    pub title: String,
    pub markdown: String,
}

/// 从 Markdown 中抽取所有 `{{ASSETS}}/name` 引用中的文件名。
fn extract_asset_names(content: &str) -> Vec<String> {
    let prefix = format!("{ASSETS_PLACEHOLDER}/");
    let mut names = Vec::new();
    let mut rest = content;

    while let Some(index) = rest.find(&prefix) {
        let after = &rest[index + prefix.len()..];
        let end = after
            .find(|c: char| c == ')' || c == '"' || c == '\'' || c.is_whitespace())
            .unwrap_or(after.len());
        let name = after[..end].trim();
        if !name.is_empty() && !name.contains('/') && !name.contains('\\') {
            names.push(name.to_string());
        }
        rest = &after[end..];
    }

    names
}

/// 校验输出格式与图片策略的组合是否合法。
pub fn validate_options(options: &CrawlOptions) -> Result<()> {
    if options.max_pagination == 0 || options.max_pagination > 5 {
        return Err(CrawlError::new(CrawlErrorKind::InvalidURL).with_detail(
            "自动续页上限必须在 1 到 5 之间（文档第 22 条）",
        ));
    }
    Ok(())
}

/// 计算某个页面的输出主干名，供前端预览。
pub fn preview_stem(title: &str) -> String {
    sanitize_stem(title)
}

/// 判断保存目录是否可用于写出。
pub fn ensure_save_dir(dir: &Path) -> Result<()> {
    if dir.as_os_str().is_empty() {
        return Err(CrawlError::new(CrawlErrorKind::SaveFailed).with_detail("未选择保存位置"));
    }
    std::fs::create_dir_all(dir).map_err(|e| {
        CrawlError::new(CrawlErrorKind::SaveFailed)
            .with_detail(format!("无法使用保存目录 {}：{e}", dir.display()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{ImageStrategy, OutputFormat};

    fn options(format: OutputFormat, image: ImageStrategy, separate: bool) -> CrawlOptions {
        CrawlOptions {
            format,
            image_strategy: image,
            follow_pagination: false,
            max_pagination: 5,
            separate_output: separate,
            obey_robots: true,
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("websribe-task-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn 抽取资产名() {
        let content = "![a]({{ASSETS}}/abc.png) 和 ![b]({{ASSETS}}/def.jpg)\n";
        assert_eq!(extract_asset_names(content), vec!["abc.png", "def.jpg"]);
    }

    #[test]
    fn 抽取资产名忽略重复与非法路径() {
        let content = "![a]({{ASSETS}}/a.png) ![b]({{ASSETS}}/a.png) ![c]({{ASSETS}}/x/y.png)";
        let names = extract_asset_names(content);
        assert!(names.contains(&"a.png".to_string()));
        // 含分隔符的路径不应被当作单个文件名
        assert!(!names.contains(&"x/y.png".to_string()));
    }

    #[test]
    fn 无资产引用的文档正常写出() {
        let dir = temp_dir("plain");
        let run = CrawlRun::new(
            "t1".into(),
            dir.clone(),
            options(OutputFormat::Markdown, ImageStrategy::Remote, false),
            dir.clone(),
        );
        let (path, body) = run.materialize_assets("标题", "# 标题\n\n正文\n").unwrap();
        assert_eq!(path.file_name().unwrap(), "标题.md");
        assert_eq!(body, "# 标题\n\n正文\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 本地图片被搬运并替换占位符() {
        let dir = temp_dir("assets");
        let staging = dir.join("staging");
        std::fs::create_dir_all(staging.join("assets")).unwrap();
        std::fs::write(staging.join("assets").join("pic.png"), b"PNG").unwrap();

        let run = CrawlRun::new(
            "t1".into(),
            dir.join("out"),
            options(OutputFormat::Markdown, ImageStrategy::Local, false),
            staging.clone(),
        );
        std::fs::create_dir_all(dir.join("out")).unwrap();

        let (path, body) = run
            .materialize_assets("文章", "![图]({{ASSETS}}/pic.png)\n")
            .unwrap();

        assert_eq!(path.file_name().unwrap(), "文章.md");
        assert!(body.contains("(文章.assets/pic.png)"));
        assert!(!body.contains("{{ASSETS}}"));
        assert!(dir.join("out").join("文章.assets").join("pic.png").is_file());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 多页默认接续为单文件() {
        let dir = temp_dir("join");
        let run = CrawlRun::new(
            "t1".into(),
            dir.clone(),
            options(OutputFormat::Markdown, ImageStrategy::Remote, false),
            dir.clone(),
        );
        let mut run = run;
        run.record_page("k", 0, "第 1 页".into(), "https://e.com/1".into(), "正文一".into(), "2026-09-15 10:00:00".into());
        run.record_page("k", 1, "第 2 页".into(), "https://e.com/2".into(), "正文二".into(), "2026-09-15 10:00:10".into());

        let outputs = run.write_outputs().unwrap();
        assert_eq!(outputs.len(), 1);

        let path = outputs[0].markdown_path.as_ref().unwrap();
        let content = std::fs::read_to_string(path).unwrap();
        assert!(content.contains("正文一"));
        assert!(content.contains("正文二"));
        assert!(content.contains("\n---\n"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 独立输出时每页一个文件() {
        let dir = temp_dir("separate");
        let mut run = CrawlRun::new(
            "t1".into(),
            dir.clone(),
            options(OutputFormat::Markdown, ImageStrategy::Remote, true),
            dir.clone(),
        );
        run.record_page("k", 0, "第 1 页".into(), "https://e.com/1".into(), "正文一".into(), "2026-09-15 10:00:00".into());
        run.record_page("k", 1, "第 2 页".into(), "https://e.com/2".into(), "正文二".into(), "2026-09-15 10:00:10".into());

        let outputs = run.write_outputs().unwrap();
        assert_eq!(outputs.len(), 2);
        assert!(outputs.iter().all(|o| o.markdown_path.is_some()));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 无结果条目被跳过不报错() {
        let dir = temp_dir("empty");
        let run = CrawlRun::new(
            "t1".into(),
            dir.clone(),
            options(OutputFormat::Markdown, ImageStrategy::Remote, false),
            dir.clone(),
        );
        // 全部条目均失败，没有任何页面结果
        assert!(run.write_outputs().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pdf_任务仅在选择_pdf_输出时产生() {
        let dir = temp_dir("pdfjob");
        let mut run = CrawlRun::new(
            "t1".into(),
            dir.clone(),
            options(OutputFormat::Markdown, ImageStrategy::Remote, false),
            dir.clone(),
        );
        run.record_page("k", 0, "标题".into(), "https://e.com/1".into(), "正文".into(), "2026-09-15 10:00:00".into());
        assert!(run.pdf_jobs().is_empty());

        let mut run_pdf = CrawlRun::new(
            "t2".into(),
            dir.clone(),
            options(OutputFormat::Both, ImageStrategy::Remote, false),
            dir.clone(),
        );
        run_pdf.record_page("k", 0, "标题".into(), "https://e.com/1".into(), "正文".into(), "2026-09-15 10:00:00".into());
        assert_eq!(run_pdf.pdf_jobs().len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 续页上限越界被拒绝() {
        let mut opts = options(OutputFormat::Markdown, ImageStrategy::Remote, false);
        opts.max_pagination = 0;
        assert!(validate_options(&opts).is_err());

        opts.max_pagination = 6;
        assert!(validate_options(&opts).is_err());

        opts.max_pagination = 5;
        assert!(validate_options(&opts).is_ok());
    }

    #[test]
    fn 文件名冲突时资产目录同步改名() {
        let dir = temp_dir("collide");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("标题.md"), b"x").unwrap();

        let run = CrawlRun::new(
            "t1".into(),
            dir.clone(),
            options(OutputFormat::Markdown, ImageStrategy::Local, false),
            dir.clone(),
        );
        let (path, _) = run.materialize_assets("标题", "正文").unwrap();
        assert_eq!(path.file_name().unwrap(), "标题-1.md");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
