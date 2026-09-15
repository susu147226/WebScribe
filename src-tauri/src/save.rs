use crate::error::{CrawlError, CrawlErrorKind, Result};
use crate::naming::{sanitize_stem, unique_path};
use std::path::{Path, PathBuf};

/// 确认目标目录可用。目录不存在时尝试创建，失败则报 `SaveFailed`。
fn ensure_dir(dir: &Path) -> Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(dir).map_err(|e| {
        CrawlError::new(CrawlErrorKind::SaveFailed)
            .with_detail(format!("无法创建保存目录 {}：{e}", dir.display()))
    })
}

/// 将 Markdown 写入目标目录，返回实际写入的路径。
pub fn write_markdown(dir: &Path, title: &str, content: &str) -> Result<PathBuf> {
    ensure_dir(dir)?;

    let stem = sanitize_stem(title);
    let path = unique_path(dir, &stem, "md");

    std::fs::write(&path, content.as_bytes()).map_err(|e| {
        CrawlError::new(CrawlErrorKind::SaveFailed)
            .with_detail(format!("写入 {} 失败：{e}", path.display()))
    })?;

    Ok(path)
}

/// 将 PDF 字节写入目标目录，返回实际写入的路径。
pub fn write_pdf(dir: &Path, title: &str, bytes: &[u8]) -> Result<PathBuf> {
    ensure_dir(dir)?;

    let stem = sanitize_stem(title);
    let path = unique_path(dir, &stem, "pdf");

    std::fs::write(&path, bytes).map_err(|e| {
        CrawlError::new(CrawlErrorKind::SaveFailed)
            .with_detail(format!("写入 {} 失败：{e}", path.display()))
    })?;

    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("websribe-save-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn 写入_markdown_并返回路径() {
        let dir = temp_dir("md");
        let path = write_markdown(&dir, "页面标题", "# 标题\n\n正文\n").unwrap();

        assert_eq!(path.file_name().unwrap(), "页面标题.md");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "# 标题\n\n正文\n"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 非法标题被净化后写入() {
        let dir = temp_dir("sanitize");
        let path = write_markdown(&dir, r#"a/b:c*d?e"f"#, "x").unwrap();
        assert_eq!(path.file_name().unwrap(), "a_b_c_d_e_f.md");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 空标题使用_untitled() {
        let dir = temp_dir("empty");
        let path = write_markdown(&dir, "", "x").unwrap();
        assert_eq!(path.file_name().unwrap(), "untitled.md");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 同名文件不互相覆盖() {
        let dir = temp_dir("dup");
        let p1 = write_markdown(&dir, "同名", "一").unwrap();
        let p2 = write_markdown(&dir, "同名", "二").unwrap();
        let p3 = write_markdown(&dir, "同名", "三").unwrap();

        assert_eq!(p1.file_name().unwrap(), "同名.md");
        assert_eq!(p2.file_name().unwrap(), "同名-1.md");
        assert_eq!(p3.file_name().unwrap(), "同名-2.md");
        assert_eq!(std::fs::read_to_string(&p1).unwrap(), "一");
        assert_eq!(std::fs::read_to_string(&p3).unwrap(), "三");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn markdown_与_pdf_同名互不影响() {
        let dir = temp_dir("bothext");
        let md = write_markdown(&dir, "文章", "x").unwrap();
        let pdf = write_pdf(&dir, "文章", b"%PDF-1.4").unwrap();

        assert_eq!(md.file_name().unwrap(), "文章.md");
        assert_eq!(pdf.file_name().unwrap(), "文章.pdf");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 写入_pdf_字节() {
        let dir = temp_dir("pdf");
        let bytes: Vec<u8> = vec![0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34];
        let path = write_pdf(&dir, "文档", &bytes).unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), bytes);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 目录不存在时自动创建() {
        let base = std::env::temp_dir().join(format!("websribe-mk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let nested = base.join("a").join("b");

        let path = write_markdown(&nested, "标题", "x").unwrap();
        assert!(path.exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn 目录创建失败时报_savefailed() {
        // 用已存在的文件冒充目录，制造必然失败
        let dir = temp_dir("fail");
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, b"x").unwrap();

        let err = write_markdown(&blocker, "标题", "x").unwrap_err();
        assert_eq!(err.kind, CrawlErrorKind::SaveFailed);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 中文内容完整写入_utf8() {
        let dir = temp_dir("utf8");
        let content = "# 中文标题\n\n正文包含中文、English、以及 emoji 🎉\n";
        let path = write_markdown(&dir, "中文标题", content).unwrap();

        let read_back = std::fs::read_to_string(&path).unwrap();
        assert_eq!(read_back, content);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
