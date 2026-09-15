use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 文档合并记录。
///
/// 记录「文档分组 → 上一次产出的文件」，用于跨任务追加：若新任务的链接与上次
/// 属于同一文档分组（同主机 + 同路径前缀），且上次的文件仍然存在，则把新内容
/// 追加到该文件末尾，而不是另建一份文档。
///
/// 存放在应用数据目录下的 `merge-records.json`。这是本工具唯一的持久化状态，
/// 不是数据库，用户可随时清除。
///
/// 注意：该文件只记录文档分组与输出路径，不含任何抓取内容或认证信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergeRecord {
    /// 记录格式版本，便于日后迁移。
    pub version: u32,
    pub groups: HashMap<String, MergeEntry>,
    /// 每个链接上次抓取到的内容指纹，用于「内容无变化就跳过」。
    /// 旧版本记录里没有这一节，读取时按空处理。
    #[serde(default)]
    pub pages: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeEntry {
    /// 产出文件的绝对路径。
    pub file: String,
    /// 该文档的标题，用于在界面上提示「将追加到哪份文档」。
    pub title: String,
    /// 最近一次写入时间。
    pub updated_at: String,
}

const CURRENT_VERSION: u32 = 1;

impl Default for MergeRecord {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            groups: HashMap::new(),
            pages: HashMap::new(),
        }
    }
}

/// 内容指纹。
///
/// 用 FNV-1a 而非 `DefaultHasher`：后者不保证跨进程、跨版本稳定，不能用于
/// 持久化比对。这里只需判断「内容是否变过」，64 位足够。
pub fn content_fingerprint(title: &str, markdown: &str) -> String {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;

    let mut hash = OFFSET;
    for byte in title.as_bytes().iter().chain(b"\n").chain(markdown.as_bytes()) {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{hash:016x}")
}

impl MergeRecord {
    /// 读取记录。文件不存在或损坏时返回空记录 —— 合并记录缺失只影响「是否追加」，
    /// 不应阻断抓取。
    pub fn load(path: &Path) -> Self {
        let Ok(text) = std::fs::read_to_string(path) else {
            return Self::default();
        };

        match serde_json::from_str::<Self>(&text) {
            Ok(record) if record.version == CURRENT_VERSION => record,
            _ => Self::default(),
        }
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_string_pretty(self)?;
        std::fs::write(path, text)
    }

    /// 查询某个文档分组上一次的产出文件。
    ///
    /// 文件已被移动或删除时返回 `None`，此时应当新建文档而非追加到不存在的路径。
    pub fn existing_file(&self, group: &str) -> Option<PathBuf> {
        let entry = self.groups.get(group)?;
        let path = PathBuf::from(&entry.file);
        path.is_file().then_some(path)
    }

    /// 上次产出的标题，供界面提示。
    pub fn existing_title(&self, group: &str) -> Option<&str> {
        self.groups.get(group).map(|entry| entry.title.as_str())
    }

    pub fn remember(&mut self, group: &str, file: &Path, title: &str) {
        self.version = CURRENT_VERSION;
        self.groups.insert(
            group.to_string(),
            MergeEntry {
                file: file.display().to_string(),
                title: title.to_string(),
                updated_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            },
        );
    }

    /// 清除全部记录，之后所有任务都会新建文档、也不再跳过任何页面。
    pub fn clear(&mut self) {
        self.groups.clear();
        self.pages.clear();
    }

    pub fn is_empty(&self) -> bool {
        self.groups.is_empty() && self.pages.is_empty()
    }

    /// 上次抓取该链接时的内容指纹。
    pub fn fingerprint_of(&self, key: &str) -> Option<&str> {
        self.pages.get(key).map(String::as_str)
    }

    /// 记录本次抓取到的内容指纹。
    pub fn remember_fingerprint(&mut self, key: &str, fingerprint: &str) {
        self.pages.insert(key.to_string(), fingerprint.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("webscribe-merge-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("merge-records.json")
    }

    #[test]
    fn 文件不存在时返回空记录() {
        let path = std::env::temp_dir().join("webscribe-nonexistent/merge-records.json");
        let record = MergeRecord::load(&path);
        assert!(record.is_empty());
    }

    #[test]
    fn 记录可往返读写() {
        let path = temp_path("roundtrip");
        let doc = path.parent().unwrap().join("doc.md");
        std::fs::write(&doc, b"x").unwrap();

        let mut record = MergeRecord::default();
        record.remember("example.com/docs", &doc, "示例文档");
        record.save(&path).unwrap();

        let loaded = MergeRecord::load(&path);
        assert_eq!(loaded.existing_file("example.com/docs"), Some(doc.clone()));
        assert_eq!(loaded.existing_title("example.com/docs"), Some("示例文档"));

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn 记录的文件已被删除时视为不存在() {
        let path = temp_path("missing");
        let doc = path.parent().unwrap().join("gone.md");

        let mut record = MergeRecord::default();
        // 刻意不创建该文件
        record.remember("example.com/docs", &doc, "已删除的文档");

        assert_eq!(record.existing_file("example.com/docs"), None);
        // 标题仍可查，界面可据此说明情况
        assert_eq!(record.existing_title("example.com/docs"), Some("已删除的文档"));

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn 未记录的分组返回_none() {
        let record = MergeRecord::default();
        assert_eq!(record.existing_file("example.com/x"), None);
        assert_eq!(record.existing_title("example.com/x"), None);
    }

    #[test]
    fn 清除后不再命中() {
        let path = temp_path("clear");
        let doc = path.parent().unwrap().join("doc.md");
        std::fs::write(&doc, b"x").unwrap();

        let mut record = MergeRecord::default();
        record.remember("example.com/docs", &doc, "标题");
        assert!(record.existing_file("example.com/docs").is_some());

        record.clear();
        assert!(record.is_empty());
        assert_eq!(record.existing_file("example.com/docs"), None);

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn 损坏的记录文件不导致失败() {
        let path = temp_path("corrupt");
        std::fs::write(&path, b"{ this is not json").unwrap();

        let record = MergeRecord::load(&path);
        assert!(record.is_empty(), "损坏时应退化为空记录而非报错");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn 版本不匹配时退化为空记录() {
        let path = temp_path("version");
        std::fs::write(&path, br#"{"version": 999, "groups": {"a": {"file": "x", "title": "t", "updatedAt": "now"}}}"#).unwrap();

        assert!(MergeRecord::load(&path).is_empty());

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn 记录不含抓取内容或凭据字段() {
        let path = temp_path("fields");
        let doc = path.parent().unwrap().join("doc.md");
        std::fs::write(&doc, b"x").unwrap();

        let mut record = MergeRecord::default();
        record.remember("example.com/docs", &doc, "标题");
        let json = serde_json::to_string(&record).unwrap().to_lowercase();

        for forbidden in ["cookie", "token", "password", "authorization", "session", "markdown"] {
            assert!(
                !json.contains(forbidden),
                "合并记录不应包含 {forbidden}"
            );
        }

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
