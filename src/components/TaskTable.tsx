import { useTaskStore } from "../stores/taskStore";
import { ERROR_LABELS, type TaskRow } from "../types";
import { StatusBadge } from "./StatusBadge";

/** 进度条。失败与被阻止时用对应颜色，避免误读为「进行中」。 */
function Progress({ row }: { row: TaskRow }) {
  const variant =
    row.errorKind === null
      ? ""
      : row.isDefense
        ? " progress__fill--blocked"
        : " progress__fill--failed";

  return (
    <div className="progress" role="progressbar" aria-valuenow={Math.round(row.progress * 100)}>
      <div
        className={`progress__fill${variant}`}
        style={{ width: `${Math.max(0, Math.min(100, row.progress * 100))}%` }}
      />
    </div>
  );
}

function ErrorNote({ row }: { row: TaskRow }) {
  if (!row.errorKind) return null;

  const label = ERROR_LABELS[row.errorKind] ?? row.errorKind;

  return (
    <div className={row.isDefense ? "error-note error-note--defense" : "error-note"}>
      <span>{label}</span>
      {row.isDefense && (
        <span> —— 已停止自动抓取，请在浏览器中手动处理后重试。WebScribe 不会绕过网站防护。</span>
      )}
      {row.errorDetail && (
        <div className="error-note__detail">{row.errorDetail}</div>
      )}
    </div>
  );
}

/** 任务表格：URL / 状态 / 当前步骤 / 进度 / 错误信息 / 输出文件。 */
export function TaskTable() {
  const tasks = useTaskStore((s) => s.tasks);

  if (tasks.length === 0) {
    return (
      <div className="empty">
        <div className="empty__title">还没有任务</div>
        <div className="empty__desc">
          在左侧填入网页 URL、选择输出格式与保存位置，然后点击「开始抓取」。
          <br />
          普通页面走轻量 HTTP 请求；只有动态页面才会启用浏览器渲染。
        </div>
      </div>
    );
  }

  const completed = tasks.filter((t) => t.state === "Completed").length;
  const failed = tasks.filter((t) => t.state === "Failed").length;
  const blocked = tasks.filter((t) => t.state === "Blocked").length;

  return (
    <>
      <div className="summary">
        <div className="summary__item">
          <strong>{tasks.length}</strong>总计
        </div>
        <div className="summary__item">
          <strong>{completed}</strong>已完成
        </div>
        {failed > 0 && (
          <div className="summary__item">
            <strong>{failed}</strong>失败
          </div>
        )}
        {blocked > 0 && (
          <div className="summary__item">
            <strong>{blocked}</strong>被网站防护阻止
          </div>
        )}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: "34%" }}>URL</th>
              <th style={{ width: 96 }}>状态</th>
              <th style={{ width: "26%" }}>当前步骤</th>
              <th style={{ width: 82 }}>进度</th>
              <th style={{ width: "24%" }}>输出文件</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((row) => (
              <tr key={row.key}>
                <td className="cell-url">
                  {row.url}
                  {row.title && <span className="cell-url__title">{row.title}</span>}
                </td>
                <td>
                  <StatusBadge state={row.state} label={row.stateLabel} />
                </td>
                <td className="cell-step">
                  {row.step}
                  <ErrorNote row={row} />
                </td>
                <td>
                  <Progress row={row} />
                </td>
                <td className="cell-files">
                  {row.outputFiles.length === 0 ? (
                    <span style={{ color: "var(--text-faint)" }}>—</span>
                  ) : (
                    row.outputFiles.map((file) => (
                      <span key={file} title={file}>
                        {file.split(/[\\/]/).pop()}
                      </span>
                    ))
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
