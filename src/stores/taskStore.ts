import { create } from "zustand";

import { createPendingRows } from "../services/taskRows";
import { mergeEntries, splitUrls } from "../services/urlInput";
import {
  clearMergeRecords,
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
  type UrlCheck,
} from "../types";

/** 输入校验的防抖时长。逐字符校验既无必要也会造成闪烁。 */
const VALIDATE_DEBOUNCE_MS = 250;

export interface LogLine {
  level: "info" | "warn" | "error";
  message: string;
  at: string;
}

interface TaskStore {
  // ---- 输入 ----
  /** 逐条 URL，界面上一条一行。 */
  urlEntries: string[];
  /** 与 `urlEntries` 一一对应的校验结果。长度可能暂时落后于输入。 */
  urlChecks: UrlCheck[];
  /** 全局校验错误，例如超出数量上限。 */
  checkError: string | null;
  /** 批量粘贴框的内容。粘贴后即清空，不作为长期状态。 */
  pasteInput: string;

  saveDir: string;
  format: OutputFormat;
  imageStrategy: ImageStrategy;
  followPagination: boolean;
  maxPagination: number;
  separateOutput: boolean;
  obeyRobots: boolean;
  mergeDocuments: boolean;

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
  setPasteInput: (value: string) => void;
  addFromText: (value: string) => void;
  setEntry: (index: number, value: string) => void;
  removeEntry: (index: number) => void;
  addBlankEntry: () => void;
  clearEntries: () => void;
  revalidate: () => void;

  setSaveDir: (value: string) => void;
  chooseSaveDir: () => Promise<void>;
  setFormat: (value: OutputFormat) => void;
  setImageStrategy: (value: ImageStrategy) => void;
  setFollowPagination: (value: boolean) => void;
  setMaxPagination: (value: number) => void;
  setSeparateOutput: (value: boolean) => void;
  setObeyRobots: (value: boolean) => void;
  setMergeDocuments: (value: boolean) => void;
  resetMergeRecords: () => Promise<void>;

  refreshEnvironment: () => Promise<void>;
  run: () => Promise<void>;
  login: () => Promise<void>;
  attachListeners: () => Promise<() => void>;
  dismissNotice: () => void;
}

function nowLabel(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

/** 只有当校验结果确实发生变化时才写回，避免无谓的重渲染。 */
function checksEqual(a: readonly UrlCheck[], b: readonly UrlCheck[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((left, i) => {
    const right = b[i];
    return (
      left.raw === right.raw &&
      left.key === right.key &&
      left.docGroup === right.docGroup &&
      left.error === right.error &&
      left.duplicateOf === right.duplicateOf
    );
  });
}

let validateTimer: ReturnType<typeof setTimeout> | undefined;

export const useTaskStore = create<TaskStore>()((set, get) => ({
  urlEntries: [],
  urlChecks: [],
  checkError: null,
  pasteInput: "",

  saveDir: "",
  format: "markdown",
  imageStrategy: "remote",
  followPagination: false,
  maxPagination: MAX_PAGINATION,
  separateOutput: false,
  obeyRobots: true,
  mergeDocuments: true,

  tasks: [],
  running: false,
  validationError: null,
  notice: null,
  logs: [],
  env: null,
  loginBusy: false,
  loginDomain: null,

  setPasteInput: (value) => set({ pasteInput: value }),

  addFromText: (value) => {
    const { entries, overLimit } = mergeEntries(get().urlEntries, value, MAX_URLS);

    set({
      urlEntries: entries,
      pasteInput: "",
      validationError: overLimit
        ? `一次任务最多 ${MAX_URLS} 个 URL，当前有 ${entries.length} 个。请删除多余项。`
        : null,
    });

    get().revalidate();
  },

  setEntry: (index, value) => {
    const entries = [...get().urlEntries];
    if (index < 0 || index >= entries.length) return;
    entries[index] = value;

    // 只改内容，不因换行再拆分 —— 用户可能正在逐字输入
    set({ urlEntries: entries, validationError: null });
    get().revalidate();
  },

  removeEntry: (index) => {
    const entries = get().urlEntries.filter((_, i) => i !== index);
    set({ urlEntries: entries, validationError: null });
    get().revalidate();
  },

  addBlankEntry: () => {
    const entries = get().urlEntries;
    if (entries.length >= MAX_URLS) {
      set({ validationError: `一次任务最多 ${MAX_URLS} 个 URL。` });
      return;
    }
    set({ urlEntries: [...entries, ""], validationError: null });
    get().revalidate();
  },

  clearEntries: () => {
    set({ urlEntries: [], pasteInput: "", urlChecks: [], checkError: null, validationError: null });
  },

  /** 请求主程序逐条校验。带防抖，避免连续输入时反复往返。 */
  revalidate: () => {
    if (validateTimer) clearTimeout(validateTimer);

    validateTimer = setTimeout(() => {
      const entries = get().urlEntries;
      if (entries.length === 0) {
        set({ urlChecks: [], checkError: null });
        return;
      }

      void validateUrls(entries)
        .then((result) => {
          // 校验期间输入可能又变了，丢弃过期结果
          if (!entriesEqual(get().urlEntries, entries)) return;
          if (checksEqual(get().urlChecks, result.checks) && get().checkError === result.error) {
            return;
          }
          set({ urlChecks: result.checks, checkError: result.error });
        })
        .catch(() => {
          // 校验失败不应打断输入，下一轮会再试
        });
    }, VALIDATE_DEBOUNCE_MS);
  },

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
  setMergeDocuments: (value) => set({ mergeDocuments: value }),

  resetMergeRecords: async () => {
    try {
      const cleared = await clearMergeRecords();
      set({
        notice:
          cleared > 0
            ? `已清除 ${cleared} 条合并记录，下次抓取会新建文档。`
            : "没有可清除的合并记录。",
      });
    } catch (error) {
      set({ notice: `清除合并记录失败：${String(error)}` });
    }
  },

  refreshEnvironment: async () => {
    try {
      set({ env: await environmentStatus() });
    } catch (error) {
      set({ env: null, notice: `无法读取环境状态：${String(error)}` });
    }
  },

  run: async () => {
    const state = get();
    const urls = state.urlEntries.map((entry) => entry.trim()).filter(Boolean);

    if (urls.length === 0) {
      set({ validationError: "请至少输入一个 URL。" });
      return;
    }
    if (!state.saveDir.trim()) {
      set({ validationError: "请先选择保存位置。" });
      return;
    }

    // 以主程序的校验结果为准，界面上的结果可能尚未刷新
    let validation;
    try {
      validation = await validateUrls(state.urlEntries);
    } catch (error) {
      set({ validationError: `URL 校验失败：${String(error)}` });
      return;
    }

    set({ urlChecks: validation.checks, checkError: validation.error });

    if (validation.error) {
      set({ validationError: validation.error });
      return;
    }

    const invalid = validation.checks.filter((check) => check.error !== null);
    if (invalid.length > 0) {
      set({ validationError: `第 ${validation.checks.indexOf(invalid[0]) + 1} 行尚未填写或格式不正确。` });
      return;
    }

    const duplicateCount = validation.checks.filter((c) => c.duplicateOf !== null).length;
    const notice =
      duplicateCount > 0
        ? `已跳过 ${duplicateCount} 个重复 URL，实际抓取 ${validation.checks.length - duplicateCount} 个。`
        : null;

    set({
      validationError: null,
      notice,
      running: true,
      tasks: createPendingRows(
        validation.checks
          .filter((check) => check.duplicateOf === null && check.key !== null)
          .map((check) => ({ key: check.key as string, raw: check.raw })),
      ),
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
      mergeDocuments: state.mergeDocuments,
      saveDir: state.saveDir,
    };

    try {
      const outcome = await startCrawl(request);
      if (outcome.merging > 0) {
        set({
          notice: `${notice ? `${notice} ` : ""}其中 ${outcome.merging} 份文档将追加到已有文件。`,
        });
      }
    } catch (error) {
      set({ running: false, notice: `启动抓取失败：${String(error)}` });
    }
  },

  login: async () => {
    const state = get();
    const first = state.urlEntries.find((entry) => entry.trim().length > 0);
    if (!first) {
      set({ validationError: "请先在 URL 列表中填写要登录的站点地址。" });
      return;
    }

    set({ loginBusy: true, validationError: null });
    try {
      await openLogin(first);
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
          const appended = payload.outputs.filter((o) => o.appended).length;

          return {
            running: false,
            notice: appended > 0 ? `${appended} 份文档已追加到已有文件。` : state.notice,
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
            {
              level: "error",
              message: `PDF 生成失败（${payload.id}）：${payload.message}`,
              at: nowLabel(),
            },
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
        set({
          loginDomain: payload.domain,
          notice: `已打开浏览器，请在窗口中自行完成登录：${payload.domain}`,
        });
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

function entriesEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

export { splitUrls };
