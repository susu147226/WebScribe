use std::path::{Path, PathBuf};

/// Windows 文件名中不允许出现的字符。
const ILLEGAL_CHARS: &[char] = &['\\', '/', ':', '*', '?', '"', '<', '>', '|'];

/// Windows 保留设备名。即使带扩展名，`CON.md` 依然无法创建。
const RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 文件名主干最大字符数（按字符计，中文标题同样适用）。
const MAX_STEM_CHARS: usize = 80;

/// 标题为空或净化后为空时使用的占位名。
pub const FALLBACK_STEM: &str = "untitled";

/// 将网页标题净化为可用的 Windows 文件名主干。
///
/// 规则（经作者确认）：
/// - `\ / : * ? " < > |` 与控制字符 → `_`
/// - 折叠连续空白并去除首尾空白
/// - 截断至 80 个字符
/// - 去除末尾的点与空格（Windows 会静默丢弃，导致文件名与预期不符）
/// - 空标题 → `untitled`
/// - 命中 Windows 保留设备名 → 前置 `_`
pub fn sanitize_stem(title: &str) -> String {
    let replaced: String = title
        .chars()
        .map(|c| {
            // 空白优先于控制字符判定：`\n`、`\t`、`\r` 两者皆是，
            // 但它们应折叠为空格而非下划线
            if c.is_whitespace() {
                ' '
            } else if c.is_control() || ILLEGAL_CHARS.contains(&c) {
                '_'
            } else {
                c
            }
        })
        .collect();

    let collapsed = collapse_whitespace(&replaced);
    let trimmed = collapsed.trim();
    let truncated: String = trimmed.chars().take(MAX_STEM_CHARS).collect();
    let cleaned = truncated.trim_end_matches(['.', ' ']);

    if cleaned.is_empty() {
        return FALLBACK_STEM.to_string();
    }

    if is_reserved(cleaned) {
        return format!("_{cleaned}");
    }

    cleaned.to_string()
}

/// Windows 允许空格，但连续空白在标题里通常来自换行/制表符，合并为单个空格。
fn collapse_whitespace(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_ws = false;
    for c in input.chars() {
        if c.is_whitespace() {
            if !in_ws {
                out.push(' ');
                in_ws = true;
            }
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    out
}

fn is_reserved(stem: &str) -> bool {
    RESERVED_NAMES
        .iter()
        .any(|r| stem.eq_ignore_ascii_case(r))
}

/// 在目标目录中挑选一个尚未被占用的文件路径，重名时追加 `-1`、`-2`……
///
/// 文档第 35 条要求处理非法文件名字符；此函数额外保证同一任务内多次输出
/// 不会互相覆盖。
pub fn unique_path(dir: &Path, stem: &str, extension: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{extension}"));
    if !first.exists() {
        return first;
    }

    let mut n: u32 = 1;
    loop {
        let candidate = dir.join(format!("{stem}-{n}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
        n = n.saturating_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 非法字符被替换为下划线() {
        assert_eq!(sanitize_stem(r#"a\b/c:d*e?f"g<h>i|j"#), "a_b_c_d_e_f_g_h_i_j");
    }

    #[test]
    fn 控制字符被替换() {
        assert_eq!(sanitize_stem("a\u{0}b\u{1f}c"), "a_b_c");
        assert_eq!(sanitize_stem("a\nb\tc"), "a b c");
    }

    #[test]
    fn 正常标题原样保留() {
        assert_eq!(sanitize_stem("Hello World"), "Hello World");
        assert_eq!(sanitize_stem("示例文章 标题"), "示例文章 标题");
    }

    #[test]
    fn 中文标题按字符截断而非字节() {
        let long: String = "中".repeat(200);
        let out = sanitize_stem(&long);
        assert_eq!(out.chars().count(), MAX_STEM_CHARS);
    }

    #[test]
    fn 超长标题截断至八十字符() {
        let long = "a".repeat(200);
        assert_eq!(sanitize_stem(&long).chars().count(), MAX_STEM_CHARS);
    }

    #[test]
    fn 空标题回退为_untitled() {
        assert_eq!(sanitize_stem(""), FALLBACK_STEM);
        assert_eq!(sanitize_stem("   "), FALLBACK_STEM);
        assert_eq!(sanitize_stem("..."), FALLBACK_STEM);
        assert_eq!(sanitize_stem("|||"), "___");
    }

    #[test]
    fn 全部为非法字符时不为空() {
        assert_eq!(sanitize_stem(r#"\/:*?"<>|"#), "_________");
    }

    #[test]
    fn 去除末尾的点与空格() {
        assert_eq!(sanitize_stem("标题..."), "标题");
        assert_eq!(sanitize_stem("标题   "), "标题");
        assert_eq!(sanitize_stem("a b."), "a b");
    }

    #[test]
    fn windows_保留设备名被前置下划线() {
        assert_eq!(sanitize_stem("CON"), "_CON");
        assert_eq!(sanitize_stem("con"), "_con");
        assert_eq!(sanitize_stem("NUL"), "_NUL");
        assert_eq!(sanitize_stem("COM1"), "_COM1");
        assert_eq!(sanitize_stem("LPT9"), "_LPT9");
        // 非保留名不受影响
        assert_eq!(sanitize_stem("CONSOLE"), "CONSOLE");
        assert_eq!(sanitize_stem("COM10"), "COM10");
    }

    #[test]
    fn 连续空白折叠为单个空格() {
        assert_eq!(sanitize_stem("a    b"), "a b");
        assert_eq!(sanitize_stem("a\n\n  b"), "a b");
    }

    #[test]
    fn 重名时追加序号() {
        let dir = std::env::temp_dir().join(format!("websribe-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let p1 = unique_path(&dir, "标题", "md");
        assert_eq!(p1.file_name().unwrap(), "标题.md");
        std::fs::write(&p1, b"x").unwrap();

        let p2 = unique_path(&dir, "标题", "md");
        assert_eq!(p2.file_name().unwrap(), "标题-1.md");
        std::fs::write(&p2, b"x").unwrap();

        let p3 = unique_path(&dir, "标题", "md");
        assert_eq!(p3.file_name().unwrap(), "标题-2.md");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 不同扩展名互不影响() {
        let dir = std::env::temp_dir().join(format!("websribe-test-ext-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let md = unique_path(&dir, "文章", "md");
        std::fs::write(&md, b"x").unwrap();
        let pdf = unique_path(&dir, "文章", "pdf");
        assert_eq!(pdf.file_name().unwrap(), "文章.pdf");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
