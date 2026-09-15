import { useEffect } from "react";

import { TaskTable } from "./components/TaskTable";
import { UrlPanel } from "./components/UrlPanel";
import { useTaskStore } from "./stores/taskStore";
import "./styles.css";

export default function App() {
  const env = useTaskStore((s) => s.env);
  const logs = useTaskStore((s) => s.logs);

  useEffect(() => {
    const store = useTaskStore.getState();
    void store.refreshEnvironment();

    let dispose: (() => void) | undefined;
    void store.attachListeners().then((fn) => {
      dispose = fn;
    });

    return () => dispose?.();
  }, []);

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">WebScribe</h1>
        <span className="app__subtitle">网页文档抓取与 Markdown / PDF 转存</span>

        <div className="app__env">
          {env === null ? (
            <span>正在检查运行时…</span>
          ) : env.ready ? (
            <>
              <span
                className="badge badge--done"
                title={env.logPath ? `日志：${env.logPath}` : undefined}
              >
                <span className="badge__dot" />
                运行时就绪
              </span>
              {!env.browserAvailable && <span>· 浏览器运行时未安装（动态页面不可用）</span>}
            </>
          ) : (
            <span title={env.problem ?? undefined} style={{ color: "var(--danger)" }}>
              运行时未就绪：{env.problem ?? "未知问题"}
            </span>
          )}
        </div>
      </header>

      <div className="app__body">
        <UrlPanel />

        <div className="panel panel--right">
          <TaskTable />

          {logs.length > 0 && (
            <div className="logs">
              {logs.map((line, index) => (
                <div className={`logs__line logs__line--${line.level}`} key={index}>
                  <span className="logs__time">{line.at}</span>
                  <span className="logs__msg">{line.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
