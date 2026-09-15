import { create } from "zustand";

import { mergeUrls, parseUrls } from "../services/urlInput";
import { createPendingRows } from "../services/taskRows";
import {
  environmentStatus,
  onCrawlerEvent,
  openLogin,
  pickSaveDirectory,
  startCrawl,
  validateUrls,
} from "../services/tauri";
import {
  MAX_PAGINATION,
  MAX_URLS,
  STATE_LABELS,
  type CrawlRequest,
  type EnvironmentStatus,
  type ErrorPayload,
  type FinishedPayload,
  type ImageStrategy,
  type OutputFormat,
  type ProgressPayload,
  type TaskRow,
  type TaskState,
} from "../types";

export interface LogLine {
  level: "info" | "warn" | "error";
  message: string;
  at: string;
}

interface TaskStore {
  // ---- 输入 ----
  urlsText: string;
  saveDir: string;
  format: OutputFormat;
  imageStrategy: ImageStrategy;
  followPagination: boolean;
  maxPagination: number;
  separateOutput: boolean;
  obeyRobots: boolean;

  // ---- 运行状态 ----
  tasks: TaskRow[];
  running: boolean;
  validationError: string | null;
  notice: string | null;
  logs: LogLine[];
  env: EnvironmentStatus | null;
  loginBusy: boolean;
  loginDomain: string | null;

  // ---- 动作 ----
  setUrlsText: (value: string) => void;
  appendUrls: (value: string) => void;
  clearUrls: () => void;
  setSaveDir: (value: string) => void;
  chooseSaveDir: () => Promise<void>;
  setFormat: (value: OutputFormat) => void;
  setImageStrategy: (value: ImageStrategy) => void;
  setFollowPagination: (value: boolean) => void;
  setMaxPagination: (value: number) => void;
  setSeparateOutput: (value: boolean) => void;
  setObeyRobots: (value: boolean) => void;

  refreshEnvironment: () => Promise<void>;
  run: () => Promise<void>;
  login: () => Promise<void>;
  attachListeners: () => Promise<() => void>;
  dismissNotice: () => void;
}

function nowLabel(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

export const useTaskStore = create<TaskStore>()((set, get) => ({
  urlsText: "",
  saveDir: "",
  format: "markdown",
  imageStrategy: "remote",
  followPagination: false,
  maxPagination: MAX_PAGINATION,
  separateOutput: false,
  obeyRobots: true,

  tasks: [],
  running: false,
  validationError: null,
  notice: null,
  logs: [],
  env: null,
  loginBusy: false,
  loginDomain: null,

  setUrlsText: (value) => set({ urlsText: value, validationError: null }),

  appendUrls: (value) => {
    // 文档第 16 条：超过 10 个必须提示，不得静默截断
    const { urls, overLimit } = mergeUrls(get().urlsText, value, MAX_URLS);

    if (overLimit) {
      set({
        urlsText: urls.join("\n"),
        validationError: `一次任务最多 ${MAX_URLS} 个 URL，当前已有 ${urls.length} 个。请删除多余项后再开始抓取。`,
      });
      return;
    }
    set({ urlsText: urls.join("\n"), validationError: null });
  },

  clearUrls: () => set({ urlsText: "", validationError: null }),

  setSaveDir: (value) => set({ saveDir: value }),

  chooseSaveDir: async () => {
    const dir = await pickSaveDirectory();
    if (dir) set({ saveDir: dir });
  },

  setFormat: (value) => set({ format: value }),
  setImageStrategy: (value) => set({ imageStrategy: value }),
  setFollowPagination: (value) => set({ followPagination: value }),
  setMaxPagination: (value) =>
    set({ maxPagination: Math.min(Math.max(1, value), MAX_PAGINATION) }),
  setSeparateOutput: (value) => set({ separateOutput: value }),
  setObeyRobots: (value) => set({ obeyRobots: value }),

  refreshEnvironment: async () => {
    try {
      set({ env: await environmentStatus() });
    } catch (error) {
      set({ env: null, notice: `无法读取环境状态：${String(error)}` });
    }
  },

  run: async () => {
    const state = get();
    const urls = parseUrls(state.urlsText);

    if (urls.length === 0) {
      set({ validationError: "请至少输入一个 URL。" });
      return;
    }
    if (urls.length > MAX_URLS) {
      set({
        validationError: `一次任务最多 ${MAX_URLS} 个 URL，当前提供了 ${urls.length} 个。`,
      });
      return;
    }
    if (!state.saveDir.trim()) {
      set({ validationError: "请先选择保存位置。" });
      return;
    }

    // 先由 Rust 侧做权威校验与去重，再决定是否启动
    let validation;
    try {
      validation = await validateUrls(urls);
    } catch (error) {
      set({ validationError: `URL 校验失败：${String(error)}` });
      return;
    }

    if (validation.error) {
      set({ validationError: validation.error });
      return;
    }

    const duplicateCount = validation.duplicates.length;
    const notice =
      duplicateCount > 0
        ? `已跳过 ${duplicateCount} 个重复 URL，实际抓取 ${validation.accepted.length} 个。`
        : null;

    set({
      validationError: null,
      notice,
      running: true,
      // key 必须来自 Rust 规范化后的值，不能用原始输入 —— 见 taskRows.ts 说明
      tasks: createPendingRows(validation.accepted),
      logs: [],
    });

    const request: CrawlRequest = {
      urls,
      format: state.format,
      imageStrategy: state.imageStrategy,
      followPagination: state.followPagination,
      maxPagination: state.maxPagination,
      separateOutput: state.separateOutput,
      obeyRobots: state.obeyRobots,
      saveDir: state.saveDir,
    };

    try {
      await startCrawl(request);
    } catch (error) {
      set({ running: false, notice: `启动抓取失败：${String(error)}` });
    }
  },

  login: async () => {
    const state = get();
    const urls = parseUrls(state.urlsText);
    if (urls.length === 0) {
      set({ validationError: "请先在 URL 列表中填写要登录的站点地址。" });
      return;
    }

    set({ loginBusy: true, validationError: null });
    try {
      await openLogin(urls[0]);
    } catch (error) {
      set({ loginBusy: false, notice: `打开登录窗口失败：${String(error)}` });
    }
  },

  attachListeners: async () => {
    const unlisteners = await Promise.all([
      onCrawlerEvent<ProgressPayload>("crawler://progress", (payload) => {
        set((state) => ({
          tasks: state.tasks.map((task) =>
            task.key === payload.key
              ? {
                  ...task,
                  url: payload.url || task.url,
                  state: payload.state,
                  stateLabel: payload.stateLabel ?? STATE_LABELS[payload.state],
                  step: payload.step,
                  progress: payload.progress,
                }
              : task,
          ),
        }));
      }),

      onCrawlerEvent<{ key: string; title: string }>("crawler://result", (payload) => {
        set((state) => ({
          tasks: state.tasks.map((task) =>
            task.key === payload.key ? { ...task, title: payload.title } : task,
          ),
        }));
      }),

      onCrawlerEvent<ErrorPayload>("crawler://error", (payload) => {
        set((state) => ({
          tasks: state.tasks.map((task) =>
            task.key === payload.key
              ? {
                  ...task,
                  state: payload.isDefense ? "Blocked" : "Failed",
                  stateLabel: payload.isDefense ? "被阻止" : "失败",
                  step: payload.message,
                  errorKind: payload.errorKind,
                  errorMessage: payload.message,
                  errorDetail: payload.detail,
                  isDefense: payload.isDefense,
                }
              : task,
          ),
        }));
      }),

      onCrawlerEvent<{ key: string; url: string; reason: string }>(
        "crawler://skipped",
        (payload) => {
          set((state) => ({
            tasks: state.tasks.map((task) =>
              task.key === payload.key
                ? {
                    ...task,
                    state: "Skipped" as TaskState,
                    stateLabel: "已跳过",
                    step: payload.reason,
                  }
                : task,
            ),
          }));
        },
      ),

      onCrawlerEvent<FinishedPayload>("crawler://finished", (payload) => {
        set((state) => {
          const outputsByKey = new Map<string, string[]>();
          for (const output of payload.outputs) {
            const files = outputsByKey.get(output.key) ?? [];
            if (output.markdownPath) files.push(output.markdownPath);
            if (output.pdfPath) files.push(output.pdfPath);
            outputsByKey.set(output.key, files);
          }

          const pdfByKey = new Map(payload.pdfs);

          return {
            running: false,
            tasks: state.tasks.map((task) => {
              const files = outputsByKey.get(task.key) ?? [];
              const extraPdf = pdfByKey.get(task.key);
              return {
                ...task,
                outputFiles: extraPdf && !files.includes(extraPdf) ? [...files, extraPdf] : files,
              };
            }),
          };
        });
      }),

      onCrawlerEvent<{ message: string }>("crawler://save-error", (payload) => {
        set({ running: false, notice: `保存失败：${payload.message}` });
      }),

      onCrawlerEvent<{ id: string; message: string }>("crawler://pdf-error", (payload) => {
        set((state) => ({
          logs: [
            ...state.logs,
            { level: "error", message: `PDF 生成失败（${payload.id}）：${payload.message}`, at: nowLabel() },
          ],
        }));
      }),

      onCrawlerEvent<{ level: "info" | "warn" | "error"; message: string }>(
        "crawler://log",
        (payload) => {
          set((state) => ({
            logs: [...state.logs, { ...payload, at: nowLabel() }].slice(-200),
          }));
        },
      ),

      onCrawlerEvent<{ domain: string }>("crawler://login-opened", (payload) => {
        set({ loginDomain: payload.domain, notice: `已打开浏览器，请在窗口中自行完成登录：${payload.domain}` });
      }),

      onCrawlerEvent<{ domain: string }>("crawler://login-saved", (payload) => {
        set({ notice: `已保存 ${payload.domain} 的登录状态，后续抓取会自动复用。` });
      }),

      onCrawlerEvent<{ domain: string; saved: boolean }>("crawler://login-closed", (payload) => {
        set({
          loginBusy: false,
          loginDomain: null,
          notice: payload.saved
            ? `已保存 ${payload.domain} 的登录状态。`
            : `${payload.domain} 的登录未保存（窗口在完成登录前被关闭）。`,
        });
      }),
    ]);

    return () => {
      for (const unlisten of unlisteners) unlisten();
    };
  },

  dismissNotice: () => set({ notice: null, validationError: null }),
}));
