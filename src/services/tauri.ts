import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import type {
  CrawlRequest,
  EnvironmentStatus,
  StartOutcome,
  UrlValidation,
} from "../types";

/** 与 Rust 侧 `commands.rs` 暴露的 Tauri 命令一一对应。 */

/** 逐条校验 URL。返回与输入行一一对应的结果。 */
export function validateUrls(urls: string[]): Promise<UrlValidation> {
  return invoke<UrlValidation>("validate_urls", { urls });
}

/** 查询运行时环境是否齐备。 */
export function environmentStatus(): Promise<EnvironmentStatus> {
  return invoke<EnvironmentStatus>("environment_status");
}

/** 启动抓取任务。 */
export function startCrawl(request: CrawlRequest): Promise<StartOutcome> {
  return invoke<StartOutcome>("start_crawl", { request });
}

/** 打开有头浏览器供用户自行登录。 */
export function openLogin(url: string): Promise<void> {
  return invoke<void>("open_login", { url });
}

/**
 * 清除合并记录。之后所有任务都会新建文档，不再追加到既有文件。
 *
 * @returns 被清除的记录条数
 */
export function clearMergeRecords(): Promise<number> {
  return invoke<number>("clear_merge_records");
}

/**
 * 弹出系统文件夹选择器。
 *
 * 文档第 31 条：保存位置使用 Tauri 原生目录选择器；经作者确认。
 * @returns 用户取消时返回 null
 */
export async function pickSaveDirectory(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "选择保存位置",
  });

  if (selected === null) return null;
  return Array.isArray(selected) ? (selected[0] ?? null) : selected;
}

/** 订阅一个 crawler 事件。 */
export function onCrawlerEvent<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<T>(event, (e) => handler(e.payload));
}
