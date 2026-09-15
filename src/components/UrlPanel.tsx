import { useMemo, useState } from "react";

import { useTaskStore } from "../stores/taskStore";
import { splitUrls } from "../services/urlInput";
import { MAX_PAGINATION, MAX_URLS, type UrlCheck } from "../types";

/** 单条 URL 的校验状态提示。 */
function EntryStatus({ check }: { check: UrlCheck | undefined }) {
  if (!check) {
    return <span className="url-row__hint">校验中…</span>;
  }

  if (check.error) {
    return <span className="url-row__hint url-row__hint--error">{check.error}</span>;
  }

  if (check.duplicateOf !== null) {
    return (
      <span className="url-row__hint url-row__hint--warn">
        与第 {check.duplicateOf + 1} 条重复，将被跳过
      </span>
    );
  }

  return (
    <span className="url-row__hint">
      将并入 <code>{check.docGroup}</code>
    </span>
  );
}

/** 左侧面板：URL 条目列表、输出选项、保存位置、登录与开始抓取。 */
export function UrlPanel() {
  const store = useTaskStore();
  const [dragging, setDragging] = useState(false);

  const entries = store.urlEntries;
  const checks = store.urlChecks;

  const validCount = useMemo(
    () => checks.filter((check) => check.error === null && check.duplicateOf === null).length,
    [checks],
  );
  const overLimit = validCount > MAX_URLS;

  /** 把一段文本并入条目列表。 */
  const absorb = (text: string) => {
    if (text.trim().length === 0) return;
    store.addFromText(text);
  };

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

      {/* ---------- 批量粘贴 ---------- */}
      <section className="section">
        <div className="section__head">
          <h2 className="section__title">粘贴链接</h2>
          <span className={overLimit ? "section__hint section__hint--over" : "section__hint"}>
            {validCount} / {MAX_URLS} 条
          </span>
        </div>

        <textarea
          className="paste-box"
          value={store.pasteInput}
          onChange={(e) => store.setPasteInput(e.target.value)}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (text.trim().length === 0) return;
            e.preventDefault();
            absorb(text);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              absorb(store.pasteInput);
            }
          }}
          placeholder="直接粘贴，一行一个，也可以一行贴多个；按下回车或点「添加」加入列表"
          spellCheck={false}
          aria-label="粘贴链接"
        />

        <div className="row row--between" style={{ marginTop: 7 }}>
          <div className="row">
            <button onClick={() => absorb(store.pasteInput)} disabled={!store.pasteInput.trim()}>
              添加
            </button>
            <button className="ghost" onClick={store.addBlankEntry} disabled={entries.length >= MAX_URLS}>
              手动加一行
            </button>
          </div>
          <button className="ghost" onClick={store.clearEntries} disabled={entries.length === 0}>
            清空
          </button>
        </div>
      </section>

      {/* ---------- 条目列表 ---------- */}
      <section className="section">
        <div className="section__head">
          <h2 className="section__title">链接列表</h2>
          <span className="section__hint">共 {entries.length} 条</span>
        </div>

        {entries.length === 0 ? (
          <p className="url-list__empty">
            还没有链接。把浏览器地址栏的内容粘贴到上方即可，程序会自动拆分并逐条校验。
          </p>
        ) : (
          <ul
            className={dragging ? "url-list url-list--dragging" : "url-list"}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const text = e.dataTransfer.getData("text");
              if (text) absorb(text);
            }}
          >
            {entries.map((entry, index) => {
              const check = checks[index];
              return (
                <li className="url-row" key={index}>
                  <span className="url-row__index">{index + 1}</span>

                  <div className="url-row__main">
                    <input
                      className="url-row__input"
                      type="text"
                      value={entry}
                      onChange={(e) => store.setEntry(index, e.target.value)}
                      placeholder="https://example.com/page"
                      spellCheck={false}
                      title={entry}
                      aria-label={`第 ${index + 1} 条 URL`}
                    />
                    <EntryStatus check={check} />
                  </div>

                  <button
                    className="url-row__remove"
                    onClick={() => store.removeEntry(index)}
                    title="删除这一条"
                    aria-label={`删除第 ${index + 1} 条`}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {store.checkError && <p className="url-row__hint url-row__hint--error">{store.checkError}</p>}
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
            checked={store.mergeDocuments}
            onChange={(e) => store.setMergeDocuments(e.target.checked)}
          />
          相似链接合并为同一文档
        </label>
        <p className="section__hint" style={{ margin: "2px 0 4px 22px" }}>
          同一目录下的多个链接会合并为一份文档；下次抓取相似链接时，会继续追加到该文档末尾。
        </p>
        {store.mergeDocuments && (
          <div className="row" style={{ margin: "0 0 8px 22px" }}>
            <button className="ghost" onClick={() => void store.resetMergeRecords()}>
              清除合并记录
            </button>
            <span className="section__hint">清除后一律新建文档</span>
          </div>
        )}

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
          每个链接独立输出
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
          使用列表中的第一条链接所属站点。请在打开的浏览器窗口中自行输入账号与验证码，
          WebScribe 不会读取或保存您的密码。
        </p>
      </section>

      <button
        className="primary"
        style={{ width: "100%", marginTop: 4 }}
        onClick={() => void store.run()}
        disabled={store.running || overLimit || entries.length === 0}
      >
        {store.running ? "抓取中…" : "开始抓取"}
      </button>
    </div>
  );
}

export { splitUrls };
