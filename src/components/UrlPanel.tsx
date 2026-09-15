import { useEffect, useMemo, useState } from "react";

import {
  buildLinkGroups,
  defaultExpandedGroups,
  estimateMinSeconds,
  hostOf,
  problemIndexes,
} from "../services/linkGroups";
import { useTaskStore } from "../stores/taskStore";
import { FALLBACK_LINK_LIMIT_TIERS, type UrlCheck } from "../types";
import { SettingsDialog } from "./SettingsDialog";

/** 单条链接的紧凑状态徽章。详情放在悬停提示里，避免撑高行。 */
function EntryBadge({ check }: { check: UrlCheck | undefined }) {
  if (!check) {
    return (
      <span className="link-row__badge link-row__badge--pending" title="校验中…">
        …
      </span>
    );
  }

  if (check.error) {
    return (
      <span className="link-row__badge link-row__badge--error" title={check.error}>
        !
      </span>
    );
  }

  if (check.duplicateOf !== null) {
    return (
      <span
        className="link-row__badge link-row__badge--warn"
        title={`与第 ${check.duplicateOf + 1} 条重复，将被跳过`}
      >
        =
      </span>
    );
  }

  return (
    <span
      className="link-row__badge link-row__badge--ok"
      title={`将并入 ${check.docGroup}`}
    >
      ✓
    </span>
  );
}

/** 左侧面板：粘贴、链接列表、常驻操作栏。设置项在弹窗里。 */
export function UrlPanel() {
  const store = useTaskStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);

  const entries = store.urlEntries;
  const checks = store.urlChecks;

  const groups = useMemo(() => buildLinkGroups(entries, checks), [entries, checks]);
  const problems = useMemo(() => problemIndexes(checks), [checks]);
  const visible = useMemo(
    () => (store.onlyProblems ? problems : entries.map((_, i) => i)),
    [store.onlyProblems, problems, entries],
  );

  const tiers = store.env?.linkLimitTiers?.length
    ? store.env.linkLimitTiers
    : FALLBACK_LINK_LIMIT_TIERS;

  const validCount = checks.filter((c) => c.error === null && c.duplicateOf === null).length;
  const overLimit = validCount > store.maxUrls;
  const minSeconds = estimateMinSeconds(groups);

  // 条目变化后，把默认展开状态应用到尚未做过选择的组
  useEffect(() => {
    if (entries.length === 0) {
      store.setGroupsExpanded([]);
      return;
    }
    store.setGroupsExpanded([...defaultExpandedGroups(groups)]);
    // 仅在分组结构变化时重置，避免用户手动展开后被打回
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.map((g) => g.key).join("|"), entries.length > 0]);

  const absorb = (text: string) => {
    if (text.trim().length === 0) return;
    store.addFromText(text);
  };

  /** 渲染一条链接。 */
  const renderRow = (index: number) => (
    <li className="link-row" key={index}>
      <span className="link-row__index">{index + 1}</span>

      <input
        className="link-row__input"
        type="text"
        value={entries[index]}
        onChange={(e) => store.setEntry(index, e.target.value)}
        placeholder="https://example.com/page"
        spellCheck={false}
        title={entries[index]}
        aria-label={`第 ${index + 1} 条链接`}
      />

      <EntryBadge check={checks[index]} />

      <button
        className="link-row__remove"
        onClick={() => store.removeEntry(index)}
        title="删除这一条"
        aria-label={`删除第 ${index + 1} 条`}
      >
        ×
      </button>
    </li>
  );

  return (
    <div className="panel panel--left">
      {/* ---------- 顶部：固定 ---------- */}
      <div className="panel__top">
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
          placeholder="把链接粘贴到这里：一行一个，一行多个也会自动拆开；按回车加入列表"
          spellCheck={false}
          aria-label="粘贴链接"
        />

        <div className="row row--wrap paste-actions">
          <button onClick={() => absorb(store.pasteInput)} disabled={!store.pasteInput.trim()}>
            添加
          </button>
          <button
            className="ghost"
            onClick={store.addBlankEntry}
            disabled={entries.length >= store.maxUrls}
          >
            加一行
          </button>
          <button
            className="ghost"
            onClick={() => void store.exportLinks()}
            disabled={entries.length === 0}
            title="把当前链接列表保存为文本文件"
          >
            导出
          </button>
          <button
            className="ghost"
            onClick={() => void store.importLinks()}
            title="从文本文件读入链接列表"
          >
            导入
          </button>
          <button className="ghost" onClick={store.clearEntries} disabled={entries.length === 0}>
            清空
          </button>
        </div>

        <div className="row row--between paste-actions">
          <label className="tier">
            <span className="section__hint">上限</span>
            <select
              value={store.maxUrls}
              onChange={(e) => store.setMaxUrls(Number(e.target.value))}
              aria-label="链接数量上限"
            >
              {tiers.map((tier) => (
                <option key={tier} value={tier}>
                  {tier}
                </option>
              ))}
            </select>
          </label>

          <span className={overLimit ? "section__hint section__hint--over" : "section__hint"}>
            {validCount} / {store.maxUrls} 条可用
          </span>
        </div>

        {minSeconds > 1 && (
          <div className="paste-actions">
            <span className="section__hint" title="同一站点串行抓取，每次请求间隔至少 1 秒">
              同一站点最多 {Math.round(minSeconds)} 条 · 预计至少 {minSeconds} 秒
            </span>
          </div>
        )}
      </div>

      {/* ---------- 中部：独立滚动 ---------- */}
      <div
        className={dragging ? "panel__list panel__list--dragging" : "panel__list"}
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
        {entries.length === 0 ? (
          <p className="url-list__empty">
            还没有链接。把浏览器地址栏的内容粘贴到上方即可，程序会自动拆分、逐条校验，
            并标出哪几条会合并成同一份文档。
          </p>
        ) : (
          <>
            <div className="list-bar">
              <span className="section__hint">共 {entries.length} 条 · {groups.length} 份文档</span>
              {problems.length > 0 && (
                <label className="checkline checkline--inline">
                  <input
                    type="checkbox"
                    checked={store.onlyProblems}
                    onChange={(e) => store.setOnlyProblems(e.target.checked)}
                  />
                  <span className="section__hint section__hint--over">
                    只看问题（{problems.length}）
                  </span>
                </label>
              )}
            </div>

            {store.onlyProblems ? (
              <ul className="url-list">{visible.map(renderRow)}</ul>
            ) : (
              groups.map((group) => {
                const expanded = store.expandedGroups.has(group.key);
                return (
                  <div className="group" key={group.key}>
                    <button
                      className={
                        group.problemCount > 0 ? "group__head group__head--problem" : "group__head"
                      }
                      onClick={() => store.toggleGroup(group.key)}
                      aria-expanded={expanded}
                    >
                      <span className="group__caret">{expanded ? "▾" : "▸"}</span>
                      <span className="group__label" title={group.label || undefined}>
                        {group.label ? hostOf(group.label) : "未归组"}
                        {group.label && group.label.includes("/") && (
                          <span className="group__path">
                            {group.label.slice(hostOf(group.label).length)}
                          </span>
                        )}
                      </span>
                      <span className="group__meta">
                        {group.problemCount > 0 && (
                          <span className="group__problem">{group.problemCount} 条有问题</span>
                        )}
                        {group.indexes.length} 条
                      </span>
                    </button>

                    {expanded && <ul className="url-list">{group.indexes.map(renderRow)}</ul>}
                  </div>
                );
              })
            )}
          </>
        )}

        {store.checkError && (
          <p className="url-list__empty url-list__empty--error">{store.checkError}</p>
        )}
      </div>

      {/* ---------- 底部：固定 ---------- */}
      <div className="panel__bottom">
        <div className="path-box">
          <div
            className={store.saveDir ? "path-box__value" : "path-box__value path-box__value--empty"}
            title={store.saveDir || undefined}
          >
            {store.saveDir || "尚未选择保存位置"}
          </div>
          <button onClick={() => void store.chooseSaveDir()}>选择</button>
        </div>

        <div className="row row--between">
          <div className="row">
            <button className="ghost" onClick={() => setSettingsOpen(true)}>
              设置
            </button>
            <button
              className="ghost"
              onClick={() => void store.login()}
              disabled={store.loginBusy}
              title="使用列表中的第一条链接所属站点"
            >
              {store.loginBusy ? "等待登录…" : "登录站点"}
            </button>
          </div>

          <button
            className="primary"
            onClick={() => void store.run()}
            disabled={store.running || overLimit || entries.length === 0}
          >
            {store.running ? "抓取中…" : "开始抓取"}
          </button>
        </div>
      </div>

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
