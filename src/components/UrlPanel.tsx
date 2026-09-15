import { useMemo } from "react";

import { useTaskStore } from "../stores/taskStore";
import { MAX_PAGINATION, MAX_URLS } from "../types";

/** 左侧面板：URL 输入、输出选项、保存位置、登录与开始抓取。 */
export function UrlPanel() {
  const store = useTaskStore();

  const urlCount = useMemo(
    () =>
      store.urlsText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean).length,
    [store.urlsText],
  );

  const overLimit = urlCount > MAX_URLS;

  return (
    <div className="panel panel--left">
      {store.validationError && (
        <div className="alert alert--error">
          <div className="alert__body">{store.validationError}</div>
          <button className="alert__close" onClick={store.dismissNotice} aria-label="关闭">
            ×
          </button>
        </div>
      )}

      {store.notice && (
        <div className="alert alert--info">
          <div className="alert__body">{store.notice}</div>
          <button className="alert__close" onClick={store.dismissNotice} aria-label="关闭">
            ×
          </button>
        </div>
      )}

      {/* ---------- 网页 URL ---------- */}
      <section className="section">
        <div className="section__head">
          <h2 className="section__title">网页 URL</h2>
          <span className={overLimit ? "section__hint section__hint--over" : "section__hint"}>
            {urlCount} / {MAX_URLS} 个
          </span>
        </div>

        <textarea
          value={store.urlsText}
          onChange={(e) => store.setUrlsText(e.target.value)}
          placeholder={"一行一个 URL，例如：\nhttps://example.com/a\nhttps://example.com/b"}
          spellCheck={false}
          aria-label="网页 URL 列表"
        />

        <div className="row row--between" style={{ marginTop: 7 }}>
          <span className="section__hint">一行一个，最多 {MAX_URLS} 个</span>
          <div className="row">
            <button
              className="ghost"
              onClick={() => {
                void navigator.clipboard.readText().then(store.appendUrls).catch(() => {});
              }}
              title="从剪贴板追加 URL"
            >
              添加 URL
            </button>
            <button className="ghost" onClick={store.clearUrls} disabled={urlCount === 0}>
              清空
            </button>
          </div>
        </div>
      </section>

      {/* ---------- 输出格式 ---------- */}
      <section className="section">
        <div className="section__head">
          <h2 className="section__title">输出格式</h2>
        </div>
        <div className="choice-group">
          {(
            [
              ["markdown", "Markdown", "仅生成 .md 文件"],
              ["pdf", "PDF", "经 Chromium 打印为 PDF"],
              ["both", "Markdown + PDF", "两种格式同时生成"],
            ] as const
          ).map(([value, label, desc]) => (
            <label className="choice" key={value}>
              <input
                type="radio"
                name="format"
                checked={store.format === value}
                onChange={() => store.setFormat(value)}
              />
              <span>
                <span className="choice__label">{label}</span>
                <span className="choice__desc" style={{ display: "block" }}>
                  {desc}
                </span>
              </span>
            </label>
          ))}
        </div>
      </section>

      {/* ---------- 图片处理 ---------- */}
      <section className="section">
        <div className="section__head">
          <h2 className="section__title">图片处理</h2>
        </div>
        <div className="choice-group">
          <label className="choice">
            <input
              type="radio"
              name="images"
              checked={store.imageStrategy === "remote"}
              onChange={() => store.setImageStrategy("remote")}
            />
            <span>
              <span className="choice__label">保留远程链接</span>
              <span className="choice__desc" style={{ display: "block" }}>
                Markdown 引用原始图片地址，产物体积小
              </span>
            </span>
          </label>
          <label className="choice">
            <input
              type="radio"
              name="images"
              checked={store.imageStrategy === "local"}
              onChange={() => store.setImageStrategy("local")}
            />
            <span>
              <span className="choice__label">下载到本地</span>
              <span className="choice__desc" style={{ display: "block" }}>
                图片存入同名 .assets 目录，离线可读
              </span>
            </span>
          </label>
        </div>
      </section>

      {/* ---------- 抓取设置 ---------- */}
      <section className="section">
        <div className="section__head">
          <h2 className="section__title">抓取设置</h2>
        </div>

        <label className="checkline">
          <input
            type="checkbox"
            checked={store.followPagination}
            onChange={(e) => store.setFollowPagination(e.target.checked)}
          />
          自动续页
        </label>

        {store.followPagination && (
          <div className="row" style={{ margin: "4px 0 6px 22px" }}>
            <span className="section__hint">最多</span>
            <input
              type="number"
              min={1}
              max={MAX_PAGINATION}
              value={store.maxPagination}
              onChange={(e) => store.setMaxPagination(Number(e.target.value))}
              aria-label="自动续页上限"
            />
            <span className="section__hint">页</span>
          </div>
        )}

        <label className="checkline">
          <input
            type="checkbox"
            checked={store.separateOutput}
            onChange={(e) => store.setSeparateOutput(e.target.checked)}
          />
          每页独立输出
        </label>

        <label className="checkline">
          <input
            type="checkbox"
            checked={store.obeyRobots}
            onChange={(e) => store.setObeyRobots(e.target.checked)}
          />
          遵循 robots.txt
        </label>
        <p className="section__hint" style={{ margin: "2px 0 0 22px" }}>
          您手动填写的 URL 始终可抓取；该设置约束的是自动续页发现的页面。
        </p>
      </section>

      {/* ---------- 保存位置 ---------- */}
      <section className="section">
        <div className="section__head">
          <h2 className="section__title">保存位置</h2>
        </div>
        <div className="path-box">
          <div
            className={store.saveDir ? "path-box__value" : "path-box__value path-box__value--empty"}
            title={store.saveDir || undefined}
          >
            {store.saveDir || "尚未选择"}
          </div>
          <button onClick={() => void store.chooseSaveDir()}>选择</button>
        </div>
      </section>

      {/* ---------- 登录站点 ---------- */}
      <section className="section">
        <div className="section__head">
          <h2 className="section__title">登录站点</h2>
        </div>
        <button onClick={() => void store.login()} disabled={store.loginBusy}>
          {store.loginBusy ? "等待登录窗口…" : "打开浏览器登录"}
        </button>
        <p className="section__hint" style={{ marginTop: 6 }}>
          使用列表中的第一个 URL 所属站点。请在打开的浏览器窗口中自行输入账号与验证码，
          WebScribe 不会读取或保存您的密码。
        </p>
      </section>

      <button
        className="primary"
        style={{ width: "100%", marginTop: 4 }}
        onClick={() => void store.run()}
        disabled={store.running || overLimit}
      >
        {store.running ? "抓取中…" : "开始抓取"}
      </button>
    </div>
  );
}
