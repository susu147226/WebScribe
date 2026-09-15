use url::{Host, Url};

/// 站点分组键。
///
/// 文档第 20 条要求识别多个 URL 是否属于同一站点/大域名，并**明确禁止**使用
/// 字符串 `contains` / `startsWith` / `endsWith` 判断域名关系。此处改用公共
/// 后缀列表（PSL）计算注册域（eTLD+1），因此：
///
/// - `example.com` / `www.example.com` / `docs.example.com` → 同一站点
/// - `notexample.com` 与 `example.com` → 不同站点（字符串包含判断会误判）
/// - `example.co.uk` → 注册域为 `example.co.uk`，而非 `co.uk`
pub fn site_key(url: &Url) -> String {
    match url.host() {
        // IP 字面量必须先行判断：PSL 会把 `127.0.0.1` 误解析为注册域 `0.1`
        Some(Host::Ipv4(ip)) => ip.to_string(),
        Some(Host::Ipv6(ip)) => ip.to_string(),
        Some(Host::Domain(domain)) => match psl::domain_str(domain) {
            Some(registrable) => registrable.to_ascii_lowercase(),
            // `localhost`、未知后缀等回退为主机名本身
            None => domain.to_ascii_lowercase(),
        },
        None => String::new(),
    }
}

/// 判断两个 URL 是否属于同一站点。
pub fn is_same_site(a: &Url, b: &Url) -> bool {
    let ka = site_key(a);
    !ka.is_empty() && ka == site_key(b)
}

/// 将一批 URL 按站点分组，保持各组首次出现的顺序。
pub fn group_by_site<T>(items: &[(String, T)], parse: impl Fn(&str) -> Option<Url>) -> Vec<(String, Vec<usize>)> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();

    for (index, (raw, _)) in items.iter().enumerate() {
        let Some(url) = parse(raw) else { continue };
        let key = site_key(&url);
        if !groups.contains_key(&key) {
            order.push(key.clone());
        }
        groups.entry(key).or_default().push(index);
    }

    order
        .into_iter()
        .map(|key| {
            let members = groups.remove(&key).unwrap_or_default();
            (key, members)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(s: &str) -> String {
        site_key(&Url::parse(s).unwrap())
    }

    #[test]
    fn 同注册域的子域归为同一站点() {
        let expected = "example.com";
        assert_eq!(key("https://example.com/a"), expected);
        assert_eq!(key("https://www.example.com/a"), expected);
        assert_eq!(key("https://docs.example.com/a"), expected);
        assert_eq!(key("https://blog.example.com/a"), expected);
    }

    #[test]
    fn 相似但不同的域名不得误判为同站() {
        // 字符串 contains / endsWith 判断会在这里出错
        assert_ne!(key("https://example.com/a"), key("https://notexample.com/a"));
        assert_ne!(key("https://example.com/a"), key("https://example.com.evil.net/a"));
        assert_ne!(key("https://example.com/a"), key("https://myexample.com/a"));
    }

    #[test]
    fn 不同注册域为不同站点() {
        assert_ne!(key("https://example.com/a"), key("https://example.org/a"));
        assert_ne!(key("https://a.example.com/"), key("https://a.example.org/"));
    }

    #[test]
    fn 多段公共后缀被正确处理() {
        assert_eq!(key("https://a.example.co.uk/x"), "example.co.uk");
        assert_eq!(key("https://a.example.com.cn/x"), "example.com.cn");
        assert_ne!(key("https://a.example.co.uk/"), key("https://b.example.co.jp/"));
    }

    #[test]
    fn 协议与端口不影响站点归属() {
        assert_eq!(key("http://example.com/a"), key("https://example.com/a"));
        assert_eq!(key("https://example.com:8443/a"), key("https://example.com/a"));
    }

    #[test]
    fn ip_地址回退为自身() {
        assert_eq!(key("http://127.0.0.1:8080/a"), "127.0.0.1");
        assert_eq!(key("http://192.168.1.10/a"), "192.168.1.10");
        assert_ne!(key("http://127.0.0.1/a"), key("http://127.0.0.2/a"));
    }

    #[test]
    fn localhost_回退为自身() {
        assert_eq!(key("http://localhost:3000/a"), "localhost");
    }

    #[test]
    fn is_same_site_一致() {
        let a = Url::parse("https://www.example.com/a").unwrap();
        let b = Url::parse("https://docs.example.com/b").unwrap();
        let c = Url::parse("https://other.com/c").unwrap();
        assert!(is_same_site(&a, &b));
        assert!(!is_same_site(&a, &c));
    }

    #[test]
    fn 分组保持首次出现顺序() {
        let items: Vec<(String, ())> = vec![
            ("https://b.com/1".into(), ()),
            ("https://a.com/1".into(), ()),
            ("https://b.com/2".into(), ()),
            ("https://a.com/2".into(), ()),
            ("https://c.com/1".into(), ()),
        ];
        let groups = group_by_site(&items, |s| Url::parse(s).ok());
        assert_eq!(groups.len(), 3);
        assert_eq!(groups[0].0, "b.com");
        assert_eq!(groups[0].1, vec![0, 2]);
        assert_eq!(groups[1].0, "a.com");
        assert_eq!(groups[1].1, vec![1, 3]);
        assert_eq!(groups[2].0, "c.com");
        assert_eq!(groups[2].1, vec![4]);
    }
}
