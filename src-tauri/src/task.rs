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
/// crawler 每抓完一页就推送一条 `result`，此处做两级归集：
///
/// 1. 同一 URL 的分页（`sequence`）按页码顺序拼接；
/// 2. 属于同一**文档分组**（同主机 + 同路径前缀）的多个 URL 再合并为一份文档。
///
/// 待 `done` 到达后再统一组装落盘 —— 全部页面到齐才能确定最终内容。
///
/// **顺序依赖：** 同一文档分组必然同主机，而 crawler 对同一站点的条目是串行
/// 处理的（见 `crawler/src/task/scheduler.ts`），因此结果到达顺序即用户输入
/// 顺序。分组内各 URL 的先后据此确定。
#[derive(Debug)]
pub struct CrawlRun {
    pub id: String,
    pub save_dir: PathBuf,
    pub options: CrawlOptions,
    /// 图片暂存目录，与下发给 crawler 的 `stagingDir` 一致。
    pub staging_dir: PathBuf,
    /// key → 所属文档分组。
    group_by_key: HashMap<String, String>,
    /// 文档分组 → 该组内按首次出现顺序排列的 key。
    group_keys: BTreeMap<String, Vec<String>>,
    /// 文档分组的首次出现顺序。
    group_order: Vec<String>,
    /// key → (sequence → 页面)，BTreeMap 保证按页码顺序拼接。
    pages: BTreeMap<String, BTreeMap<u32, PageDocument>>,
    /// 需要追加的目标：文档分组 → 既有文件路径。
    append_targets: HashMap<String, PathBuf>,
    /// 本次任务是否启用了「相似链接合并为同一文档」。
    /// 关闭时不读写合并记录，避免污染下次启用的任务。
    pub merge_enabled: bool,
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
    /// 是否命中网站防御机制。
    pub is_defense: bool,
}

/// 一份产出文档。
#[derive(Debug, Clone, Serialize)]
pub struct OutputFile {
    /// 该文档所辖的第一个 URL 的规范化 key。
    pub key: String,
    /// 所属文档分组。合并记录按此键更新，供下次任务判断是否追加。
    pub group: String,
    /// 文档标题。
    pub title: String,
    pub markdown_path: Option<String>,
    pub pdf_path: Option<String>,
    /// 是否为追加到既有文档（而非新建）。
    pub appended: bool,
}

/// 写出的结果：文件清单 + 待渲染的 PDF 任务。
#[derive(Debug, Clone, Serialize)]
pub struct WriteOutcome {
    pub files: Vec<OutputFile>,
    #[serde(skip)]
    pub pdf_jobs: Vec<PdfJob>,
}

/// 一份待渲染的 PDF。
#[derive(Debug, Clone)]
pub struct PdfJob {
    pub id: String,
    pub title: String,
    /// 完整的 Markdown 文档内容（追加模式下已包含既有内容）。
    pub markdown: String,
    /// 写入目标；为空时由 `write_pdf_for` 另择不冲突的文件名。
    pub path: Option<PathBuf>,
}

impl CrawlRun {
    pub fn new(
        id: String,
        save_dir: PathBuf,
        options: CrawlOptions,
        staging_dir: PathBuf,
        group_by_key: HashMap<String, String>,
        append_targets: HashMap<String, PathBuf>,
    ) -> Self {
        Self {
            id,
            save_dir,
            options,
            staging_dir,
            group_by_key,
            group_keys: BTreeMap::new(),
            group_order: Vec::new(),
            pages: BTreeMap::new(),
            append_targets,
            merge_enabled: false,
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
            // 分组信息在任务启动时由 Rust 侧算好下发；缺失时退化为「各自成组」，
            // 保证不会因为映射缺失而丢内容
            let group = self
                .group_by_key
                .get(key)
                .cloned()
                .unwrap_or_else(|| key.to_string());

            if !self.group_keys.contains_key(&group) {
                self.group_order.push(group.clone());
            }
            self.group_keys
                .entry(group)
                .or_default()
                .push(key.to_string());
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
    /// 同一文档分组的所有页面合并为一份；命中合并记录且文件仍在时追加到该文件。
    /// 开启「独立输出」时改为每个 URL 一份文档。
    pub fn write_outputs(&self) -> Result<WriteOutcome> {
        let mut files = Vec::new();
        let mut pdf_jobs = Vec::new();

        for group in &self.group_order {
            let Some(keys) = self.group_keys.get(group) else {
                continue;
            };

            if self.options.separate_output {
                for key in keys {
                    let Some(pages) = self.pages.get(key) else {
                        continue;
                    };
                    if pages.is_empty() {
                        continue;
                    }
                    let ordered: Vec<PageDocument> = pages.values().cloned().collect();
                    let title = ordered[0].title.clone();
                    let content = document::join(&ordered);

                    let (file, job) = self.write_one(key, group, &title, &content, false)?;
                    files.push(file);
                    pdf_jobs.extend(job);
                }
            } else {
                let ordered = self.ordered_pages(keys);
                if ordered.is_empty() {
                    continue;
                }

                let title = ordered[0].title.clone();
                let content = document::join(&ordered);
                let key = keys.first().cloned().unwrap_or_default();

                // 分组有既有文件时才走追加
                let append = self.append_targets.contains_key(group);
                let (file, job) = self.write_one(&key, group, &title, &content, append)?;
                files.push(file);
                pdf_jobs.extend(job);
            }
        }

        Ok(WriteOutcome { files, pdf_jobs })
    }

    /// 按「先 URL 顺序、后页码顺序」取出分组内的全部页面。
    fn ordered_pages(&self, keys: &[String]) -> Vec<PageDocument> {
        let mut out = Vec::new();
        for key in keys {
            if let Some(pages) = self.pages.get(key) {
                out.extend(pages.values().cloned());
            }
        }
        out
    }

    /// 写出一份文档，返回文件记录与（可选的）PDF 任务。
    fn write_one(
        &self,
        key: &str,
        group: &str,
        title: &str,
        content: &str,
        append: bool,
    ) -> Result<(OutputFile, Option<PdfJob>)> {
        let existing = if append {
            self.append_targets.get(group).cloned()
        } else {
            None
        };

        let (markdown_path, stem, final_markdown) = match &existing {
            // ---- 追加：沿用既有文件名与资产目录 ----
            Some(path) => {
                let stem = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| sanitize_stem(title));
                let assets_dir = path.with_extension("assets");

                let previous = std::fs::read_to_string(path).unwrap_or_default();
                let merged = append_sections(&previous, content);
                let body = self.replace_assets(&assets_dir, &stem, &merged)?;

                std::fs::write(path, body.as_bytes()).map_err(|e| {
                    CrawlError::new(CrawlErrorKind::SaveFailed)
                        .with_detail(format!("写入 {} 失败：{e}", path.display()))
                })?;

                (Some(path.clone()), stem, body)
            }
            // ---- 新建 ----
            None => {
                let stem = sanitize_stem(title);
                let (path, assets_dir) = self.reserve_names(&stem);
                let body = self.replace_assets(&assets_dir, &stem, content)?;

                std::fs::write(&path, body.as_bytes()).map_err(|e| {
                    CrawlError::new(CrawlErrorKind::SaveFailed)
                        .with_detail(format!("写入 {} 失败：{e}", path.display()))
                })?;

                (Some(path), stem, body)
            }
        };

        // 纯 PDF 输出时不产生 Markdown 文件
        let markdown_path = if self.options.format.writes_markdown() {
            markdown_path
        } else {
            None
        };

        let (pdf_path, pdf_job) = if self.options.format.writes_pdf() {
            let path = self.pdf_target(&stem, existing.as_deref());
            let job = PdfJob {
                id: key.to_string(),
                title: if title.trim().is_empty() {
                    stem.clone()
                } else {
                    title.to_string()
                },
                // 追加模式下 PDF 同样要覆盖整份文档，因此用合并后的内容
                markdown: final_markdown,
                path: Some(path.clone()),
            };
            (Some(path.display().to_string()), Some(job))
        } else {
            (None, None)
        };

        Ok((
            OutputFile {
                key: key.to_string(),
                group: group.to_string(),
                title: title.to_string(),
                markdown_path: markdown_path.map(|p| p.display().to_string()),
                pdf_path,
                appended: existing.is_some(),
            },
            pdf_job,
        ))
    }

    /// 决定 PDF 的写入路径：追加模式下沿用既有的同名 PDF，否则取不冲突的新名。
    fn pdf_target(&self, stem: &str, existing_markdown: Option<&Path>) -> PathBuf {
        if let Some(markdown) = existing_markdown {
            let sibling = markdown.with_extension("pdf");
            if sibling.exists() {
                return sibling;
            }
        }
        unique_path(&self.save_dir, stem, "pdf")
    }

    /// 把 Markdown 中引用的暂存图片搬到 `assets_dir`，并替换占位符。
    ///
    /// 图片策略为 `local` 时使用相对路径引用本地图片。
    fn replace_assets(&self, assets_dir: &Path, stem: &str, content: &str) -> Result<String> {
        if !content.contains(ASSETS_PLACEHOLDER) {
            return Ok(content.to_string());
        }

        // 占位符只在 local 策略下由 crawler 写入；remote 策略下不该出现。
        // 真出现时说明两端策略不一致，此时原样返回，避免静默改写用户内容。
        if self.options.image_strategy != ImageStrategy::Local {
            eprintln!("[WebScribe] 检测到非预期图片占位符，图片策略可能不一致");
            return Ok(content.to_string());
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
            std::fs::create_dir_all(assets_dir).map_err(|e| {
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

        Ok(content.replace(ASSETS_PLACEHOLDER, &relative))
    }

    /// 为 Markdown 与资产目录预留一对不冲突的名字。
    fn reserve_names(&self, stem: &str) -> (PathBuf, PathBuf) {
        let mut candidate_stem = stem.to_string();
        let mut n: u32 = 0;

        loop {
            let markdown = self.save_dir.join(format!("{candidate_stem}.md"));
            let assets = self.save_dir.join(format!("{candidate_stem}.assets"));

            // 纯 PDF 输出时不占用 .md 名字，只看资产目录是否冲突
            let conflict = if self.options.format.writes_markdown() {
                markdown.exists() || assets.exists()
            } else {
                assets.exists()
            };

            if !conflict {
                return (markdown, assets);
            }

            n = n.saturating_add(1);
            candidate_stem = format!("{stem}-{n}");
        }
    }

    /// PDF 字节回传后写入磁盘。
    pub fn write_pdf_for(&self, job: &PdfJob, bytes: &[u8]) -> Result<PathBuf> {
        std::fs::create_dir_all(&self.save_dir).map_err(|e| {
            CrawlError::new(CrawlErrorKind::SaveFailed)
                .with_detail(format!("创建保存目录失败：{e}"))
        })?;

        let path = match &job.path {
            Some(path) => path.clone(),
            None => unique_path(&self.save_dir, &sanitize_stem(&job.title), "pdf"),
        };

        std::fs::write(&path, bytes).map_err(|e| {
            CrawlError::new(CrawlErrorKind::SaveFailed)
                .with_detail(format!("写入 {} 失败：{e}", path.display()))
        })?;

        Ok(path)
    }
}

/// 把新内容追加到既有文档末尾，以分隔线隔开。
///
/// 既有内容为空（例如文件被清空）时直接返回新内容，避免产出一个以 `---`
/// 开头的空文档。
fn append_sections(existing: &str, addition: &str) -> String {
    let existing = existing.trim_end();
    let addition = addition.trim();

    if existing.is_empty() {
        return format!("{addition}\n");
    }
    if addition.is_empty() {
        return format!("{existing}\n");
    }

    format!("{existing}\n\n---\n{addition}\n")
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
        return Err(CrawlError::new(CrawlErrorKind::InvalidURL)
            .with_detail("自动续页上限必须在 1 到 5 之间"));
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
    use crate::protocol::OutputFormat;

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
        let dir = std::env::temp_dir().join(format!("webscribe-task-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 构造一个把每个 key 各自成组的简单映射。
    fn own_groups(keys: &[&str]) -> HashMap<String, String> {
        keys.iter()
            .map(|k| (k.to_string(), k.to_string()))
            .collect()
    }

    fn run_with(
        dir: &Path,
        format: OutputFormat,
        image: ImageStrategy,
        separate: bool,
        group_by_key: HashMap<String, String>,
        append_targets: HashMap<String, PathBuf>,
    ) -> CrawlRun {
        CrawlRun::new(
            "t1".into(),
            dir.to_path_buf(),
            options(format, image, separate),
            dir.to_path_buf(),
            group_by_key,
            append_targets,
        )
    }

    // ---- 资产名抽取 ----

    #[test]
    fn 抽取资产名() {
        let content = "![a]({{ASSETS}}/abc.png) 和 ![b]({{ASSETS}}/def.jpg)\n";
        assert_eq!(extract_asset_names(content), vec!["abc.png", "def.jpg"]);
    }

    #[test]
    fn 抽取资产名忽略非法路径() {
        let content = "![a]({{ASSETS}}/a.png) ![b]({{ASSETS}}/x/y.png)";
        let names = extract_asset_names(content);
        assert!(names.contains(&"a.png".to_string()));
        assert!(!names.contains(&"x/y.png".to_string()));
    }

    // ---- 追加拼接 ----

    #[test]
    fn 追加以分隔线隔开() {
        let out = append_sections("# 一\n\n正文一\n", "# 二\n\n正文二\n");
        assert_eq!(out, "# 一\n\n正文一\n\n---\n# 二\n\n正文二\n");
    }

    #[test]
    fn 既有内容为空时直接采用新内容() {
        assert_eq!(append_sections("", "# 新\n\n正文\n"), "# 新\n\n正文\n");
        assert_eq!(append_sections("   \n", "# 新\n\n正文\n"), "# 新\n\n正文\n");
    }

    #[test]
    fn 新内容为空时保持既有内容() {
        assert_eq!(append_sections("# 旧\n\n正文\n", ""), "# 旧\n\n正文\n");
    }

    #[test]
    fn 多次追加依次叠加() {
        let first = append_sections("", "A");
        let second = append_sections(&first, "B");
        let third = append_sections(&second, "C");
        assert_eq!(third.matches("\n---\n").count(), 2);
        assert!(third.find('A').unwrap() < third.find('B').unwrap());
        assert!(third.find('B').unwrap() < third.find('C').unwrap());
    }

    // ---- 分组归并 ----

    #[test]
    fn 同一分组的多个_url_合并为一份文档() {
        let dir = temp_dir("group-merge");
        let groups: HashMap<String, String> = [
            ("k1".to_string(), "example.com/docs".to_string()),
            ("k2".to_string(), "example.com/docs".to_string()),
        ]
        .into_iter()
        .collect();

        let mut run = run_with(
            &dir,
            OutputFormat::Markdown,
            ImageStrategy::Remote,
            false,
            groups,
            HashMap::new(),
        );
        run.record_page("k1", 0, "第一章".into(), "https://example.com/docs/a".into(), "正文一".into(), "2026-09-15 10:00:00".into());
        run.record_page("k2", 0, "第二章".into(), "https://example.com/docs/b".into(), "正文二".into(), "2026-09-15 10:00:10".into());

        let outcome = run.write_outputs().unwrap();
        assert_eq!(outcome.files.len(), 1, "同组应只产出一份文档");

        let path = outcome.files[0].markdown_path.as_ref().unwrap();
        let content = std::fs::read_to_string(path).unwrap();
        assert!(content.contains("第一章"));
        assert!(content.contains("第二章"));
        assert!(content.contains("\n---\n"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 不同分组各产出一份文档() {
        let dir = temp_dir("group-split");
        let mut run = run_with(
            &dir,
            OutputFormat::Markdown,
            ImageStrategy::Remote,
            false,
            own_groups(&["k1", "k2"]),
            HashMap::new(),
        );
        run.record_page("k1", 0, "甲".into(), "https://a.com/x".into(), "甲内容".into(), "2026-09-15 10:00:00".into());
        run.record_page("k2", 0, "乙".into(), "https://b.com/y".into(), "乙内容".into(), "2026-09-15 10:00:01".into());

        let outcome = run.write_outputs().unwrap();
        assert_eq!(outcome.files.len(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 分组内分页页面按页码接续() {
        let dir = temp_dir("group-pages");
        let groups: HashMap<String, String> =
            [("k1".to_string(), "example.com/docs".to_string())].into_iter().collect();

        let mut run = run_with(&dir, OutputFormat::Markdown, ImageStrategy::Remote, false, groups, HashMap::new());
        run.record_page("k1", 1, "第 2 页".into(), "https://example.com/docs/a?p=2".into(), "正文二".into(), "2026-09-15 10:00:10".into());
        run.record_page("k1", 0, "第 1 页".into(), "https://example.com/docs/a".into(), "正文一".into(), "2026-09-15 10:00:00".into());

        let outcome = run.write_outputs().unwrap();
        let content = std::fs::read_to_string(outcome.files[0].markdown_path.as_ref().unwrap()).unwrap();
        assert!(content.find("正文一").unwrap() < content.find("正文二").unwrap(), "页码顺序错误");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 独立输出时每个_url_一份文档() {
        let dir = temp_dir("separate");
        let groups: HashMap<String, String> = [
            ("k1".to_string(), "example.com/docs".to_string()),
            ("k2".to_string(), "example.com/docs".to_string()),
        ]
        .into_iter()
        .collect();

        let mut run = run_with(&dir, OutputFormat::Markdown, ImageStrategy::Remote, true, groups, HashMap::new());
        run.record_page("k1", 0, "第一章".into(), "https://example.com/docs/a".into(), "正文一".into(), "2026-09-15 10:00:00".into());
        run.record_page("k2", 0, "第二章".into(), "https://example.com/docs/b".into(), "正文二".into(), "2026-09-15 10:00:10".into());

        let outcome = run.write_outputs().unwrap();
        assert_eq!(outcome.files.len(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- 跨任务追加 ----

    #[test]
    fn 命中记录时追加到既有文档() {
        let dir = temp_dir("append");
        let existing = dir.join("示例文档.md");
        std::fs::write(&existing, "# 示例文档\n> Source: https://example.com/docs/a\n>\n> Crawled At: 2026-09-15 10:00:00\n\n第一次的正文\n").unwrap();

        let groups: HashMap<String, String> =
            [("k2".to_string(), "example.com/docs".to_string())].into_iter().collect();
        let appends: HashMap<String, PathBuf> =
            [("example.com/docs".to_string(), existing.clone())].into_iter().collect();

        let mut run = run_with(&dir, OutputFormat::Markdown, ImageStrategy::Remote, false, groups, appends);
        run.record_page("k2", 0, "第二章".into(), "https://example.com/docs/b".into(), "第二次的正文".into(), "2026-09-15 11:00:00".into());

        let outcome = run.write_outputs().unwrap();
        assert_eq!(outcome.files.len(), 1);
        assert!(outcome.files[0].appended, "应标记为追加");
        assert_eq!(outcome.files[0].markdown_path.as_ref().unwrap(), &existing.display().to_string());

        let content = std::fs::read_to_string(&existing).unwrap();
        assert!(content.contains("第一次的正文"), "既有内容不应丢失");
        assert!(content.contains("第二次的正文"));
        assert!(content.find("第一次的正文").unwrap() < content.find("第二次的正文").unwrap());
        assert!(content.contains("\n---\n"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 未命中记录时新建文档() {
        let dir = temp_dir("append-none");
        let groups: HashMap<String, String> =
            [("k1".to_string(), "example.com/other".to_string())].into_iter().collect();

        let mut run = run_with(&dir, OutputFormat::Markdown, ImageStrategy::Remote, false, groups, HashMap::new());
        run.record_page("k1", 0, "新文档".into(), "https://example.com/other/a".into(), "正文".into(), "2026-09-15 10:00:00".into());

        let outcome = run.write_outputs().unwrap();
        assert!(!outcome.files[0].appended);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 连续两次追加内容依次叠加() {
        let dir = temp_dir("append-twice");
        let existing = dir.join("连载.md");
        std::fs::write(&existing, "# 连载\n\n第一段\n").unwrap();

        for text in ["第二段", "第三段"] {
            let groups: HashMap<String, String> =
                [("k".to_string(), "example.com/s".to_string())].into_iter().collect();
            let appends: HashMap<String, PathBuf> =
                [("example.com/s".to_string(), existing.clone())].into_iter().collect();

            let mut run = run_with(&dir, OutputFormat::Markdown, ImageStrategy::Remote, false, groups, appends);
            run.record_page("k", 0, "连载".into(), "https://example.com/s/a".into(), text.into(), "2026-09-15 10:00:00".into());
            run.write_outputs().unwrap();
        }

        let content = std::fs::read_to_string(&existing).unwrap();
        assert_eq!(content.matches("\n---\n").count(), 2);
        assert!(content.find("第二段").unwrap() < content.find("第三段").unwrap());

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- 图片 ----

    #[test]
    fn 本地图片被搬运并替换占位符() {
        let dir = temp_dir("assets");
        let staging = dir.join("staging");
        std::fs::create_dir_all(staging.join("assets")).unwrap();
        std::fs::write(staging.join("assets").join("pic.png"), b"PNG").unwrap();

        let out_dir = dir.join("out");
        std::fs::create_dir_all(&out_dir).unwrap();

        // 暂存目录与保存目录分开设置
        let run = CrawlRun::new(
            "t1".into(),
            out_dir.clone(),
            options(OutputFormat::Markdown, ImageStrategy::Local, false),
            staging.clone(),
            HashMap::new(),
            HashMap::new(),
        );

        let body = run
            .replace_assets(&out_dir.join("文章.assets"), "文章", "![图]({{ASSETS}}/pic.png)\n")
            .unwrap();

        assert!(body.contains("(文章.assets/pic.png)"), "占位符未被替换为相对路径");
        assert!(!body.contains("{{ASSETS}}"));
        assert!(out_dir.join("文章.assets").join("pic.png").is_file(), "图片未被搬运");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 暂存目录缺少图片时占位符仍被替换() {
        let dir = temp_dir("assets-missing");
        let out_dir = dir.join("out");
        std::fs::create_dir_all(&out_dir).unwrap();

        let run = CrawlRun::new(
            "t1".into(),
            out_dir.clone(),
            options(OutputFormat::Markdown, ImageStrategy::Local, false),
            dir.join("staging"),
            HashMap::new(),
            HashMap::new(),
        );

        let body = run
            .replace_assets(&out_dir.join("文章.assets"), "文章", "![图]({{ASSETS}}/nope.png)")
            .unwrap();

        // 取不到图片时不应留下无法解析的占位符
        assert!(!body.contains("{{ASSETS}}"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 无资产引用时内容不变() {
        let dir = temp_dir("assets-none");
        let run = run_with(&dir, OutputFormat::Markdown, ImageStrategy::Remote, false, HashMap::new(), HashMap::new());
        assert_eq!(run.replace_assets(&dir, "标题", "# 标题\n\n正文\n").unwrap(), "# 标题\n\n正文\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- 文件名 ----

    #[test]
    fn 文件名冲突时资产目录同步改名() {
        let dir = temp_dir("collide");
        std::fs::write(dir.join("标题.md"), b"x").unwrap();

        let run = run_with(&dir, OutputFormat::Markdown, ImageStrategy::Local, false, HashMap::new(), HashMap::new());
        let (path, _) = run.reserve_names("标题");
        assert_eq!(path.file_name().unwrap(), "标题-1.md");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- PDF 任务 ----

    #[test]
    fn pdf_任务仅在选择_pdf_输出时产生() {
        let dir = temp_dir("pdfjob");

        let mut md_run = run_with(&dir, OutputFormat::Markdown, ImageStrategy::Remote, false, own_groups(&["k"]), HashMap::new());
        md_run.record_page("k", 0, "标题".into(), "https://e.com/1".into(), "正文".into(), "2026-09-15 10:00:00".into());
        assert!(md_run.write_outputs().unwrap().pdf_jobs.is_empty());

        let mut pdf_run = run_with(&dir, OutputFormat::Both, ImageStrategy::Remote, false, own_groups(&["k"]), HashMap::new());
        pdf_run.record_page("k", 0, "标题".into(), "https://e.com/1".into(), "正文".into(), "2026-09-15 10:00:00".into());
        let outcome = pdf_run.write_outputs().unwrap();
        assert_eq!(outcome.pdf_jobs.len(), 1);
        assert!(outcome.files[0].pdf_path.is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 追加模式下_pdf_采用合并后的完整内容() {
        let dir = temp_dir("append-pdf");
        let existing = dir.join("文档.md");
        std::fs::write(&existing, "# 文档\n\n第一次的正文\n").unwrap();

        let groups: HashMap<String, String> =
            [("k".to_string(), "example.com/s".to_string())].into_iter().collect();
        let appends: HashMap<String, PathBuf> =
            [("example.com/s".to_string(), existing.clone())].into_iter().collect();

        let mut run = run_with(&dir, OutputFormat::Both, ImageStrategy::Remote, false, groups, appends);
        run.record_page("k", 0, "文档".into(), "https://example.com/s/a".into(), "第二次的正文".into(), "2026-09-15 11:00:00".into());

        let outcome = run.write_outputs().unwrap();
        let job = &outcome.pdf_jobs[0];
        assert!(job.markdown.contains("第一次的正文"), "PDF 应包含既有内容");
        assert!(job.markdown.contains("第二次的正文"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pdf_写入到指定路径() {
        let dir = temp_dir("pdf-write");
        let run = run_with(&dir, OutputFormat::Pdf, ImageStrategy::Remote, false, HashMap::new(), HashMap::new());
        let target = dir.join("输出.pdf");
        let job = PdfJob {
            id: "k".into(),
            title: "输出".into(),
            markdown: "# x".into(),
            path: Some(target.clone()),
        };
        let written = run.write_pdf_for(&job, b"%PDF-1.4").unwrap();
        assert_eq!(written, target);
        assert_eq!(std::fs::read(&target).unwrap(), b"%PDF-1.4");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- 其它 ----

    #[test]
    fn 无结果条目被跳过不报错() {
        let dir = temp_dir("empty");
        let run = run_with(&dir, OutputFormat::Markdown, ImageStrategy::Remote, false, HashMap::new(), HashMap::new());
        assert!(run.write_outputs().unwrap().files.is_empty());
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
    fn 分组映射缺失时退化为各自成组() {
        let dir = temp_dir("no-map");
        let mut run = run_with(&dir, OutputFormat::Markdown, ImageStrategy::Remote, false, HashMap::new(), HashMap::new());
        run.record_page("k1", 0, "甲".into(), "https://a.com/x".into(), "甲".into(), "2026-09-15 10:00:00".into());
        run.record_page("k2", 0, "乙".into(), "https://b.com/y".into(), "乙".into(), "2026-09-15 10:00:01".into());

        // 映射缺失时不应丢内容，只是各自成文档
        assert_eq!(run.write_outputs().unwrap().files.len(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
