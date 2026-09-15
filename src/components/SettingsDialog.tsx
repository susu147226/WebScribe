import { useEffect } from "react";

import { useTaskStore } from "../stores/taskStore";
import { MAX_PAGINATION } from "../types";

/**
 * 设置弹窗。
 *
 * 输出格式、图片处理、抓取设置三项合计约 545 px，比链接列表本身还高。
 * 把它们收进弹窗后，面板可以把高度全部让给链接列表与常驻操作栏。
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const store = useTaskStore();

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="modal__backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="抓取设置"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h2 className="modal__title">抓取设置</h2>
          <button className="modal__close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="modal__body">
          <section className="section">
            <div className="section__head">
              <h3 className="section__title">输出格式</h3>
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

          <section className="section">
            <div className="section__head">
              <h3 className="section__title">图片处理</h3>
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

          <section className="section">
            <div className="section__head">
              <h3 className="section__title">文档合并</h3>
            </div>

            <label className="checkline">
              <input
                type="checkbox"
                checked={store.mergeDocuments}
                onChange={(e) => store.setMergeDocuments(e.target.checked)}
              />
              相似链接合并为同一文档
            </label>
            <p className="section__hint" style={{ margin: "2px 0 6px 22px" }}>
              同一目录下的多个链接会合并为一份文档；下次抓取相似链接时，
              会继续追加到该文档末尾。
            </p>

            {store.mergeDocuments && (
              <div className="row" style={{ margin: "0 0 4px 22px" }}>
                <button className="ghost" onClick={() => void store.resetMergeRecords()}>
                  清除合并记录
                </button>
                <span className="section__hint">清除后一律新建文档</span>
              </div>
            )}
          </section>

          <section className="section">
            <div className="section__head">
              <h3 className="section__title">抓取行为</h3>
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
              您手动填写的链接始终可抓取；该设置约束的是自动续页发现的页面。
            </p>
          </section>
        </div>

        <div className="modal__foot">
          <button className="primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
