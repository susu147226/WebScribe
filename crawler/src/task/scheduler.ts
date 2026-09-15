/**
 * 抓取调度。
 *
 * 文档第 42 条要求并发策略必须由作者确认。经作者确认的策略是
 * **同站串行 + 跨站并行（上限 3）**。
 *
 * 文档第 25 条要求默认采用低频、串行、有限重试、合理等待、指数退避，
 * 且同一站点默认串行抓取。
 */

/** 跨站并发上限（经作者确认）。 */
export const MAX_CONCURRENT_SITES = 3;

/** 同一站点两次请求之间的最小间隔。 */
export const MIN_SAME_SITE_DELAY_MS = 1000;

/** 单个 URL 的最大重试次数（文档第 25 条：有限重试）。 */
export const MAX_RETRIES = 3;

/** 退避基数与上限。 */
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;

export interface ScheduledGroup<T> {
  /** 站点分组键（注册域）。 */
  site: string;
  items: T[];
}

export interface RunOptions<T> {
  maxConcurrentSites?: number;
  minDelayMs?: number;
  onItem: (item: T, site: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 按站点分组执行：组内串行、组间并行（受上限约束）。
 *
 * 组内串行保证同一站点的请求不会同时发出；组间的 `minDelayMs` 间隔进一步
 * 降低单个站点的请求频率。
 */
export async function runGrouped<T>(
  groups: ScheduledGroup<T>[],
  options: RunOptions<T>,
): Promise<void> {
  const limit = Math.max(1, options.maxConcurrentSites ?? MAX_CONCURRENT_SITES);
  const minDelay = Math.max(0, options.minDelayMs ?? MIN_SAME_SITE_DELAY_MS);
  const sleep = options.sleep ?? defaultSleep;

  const queue = [...groups];

  const worker = async (): Promise<void> => {
    for (;;) {
      const group = queue.shift();
      if (!group) return;

      let lastRequestAt = 0;
      for (const item of group.items) {
        if (lastRequestAt > 0 && minDelay > 0) {
          const elapsed = Date.now() - lastRequestAt;
          if (elapsed < minDelay) {
            await sleep(minDelay - elapsed);
          }
        }

        lastRequestAt = Date.now();
        try {
          await options.onItem(item, group.site);
        } catch {
          // 单个条目的失败不应中断同站其余条目；
          // 具体错误由 onItem 内部负责上报
        }
      }
    }
  };

  const workers = Array.from({ length: Math.min(limit, queue.length) }, () => worker());
  await Promise.all(workers);
}

/**
 * 指数退避延时。
 *
 * 文档第 25 条：遇到 HTTP 429 必须降低访问频率或暂停，不得不断重试。
 *
 * @param attempt 从 1 开始的第几次重试
 */
export function backoffDelay(
  attempt: number,
  baseMs = BACKOFF_BASE_MS,
  maxMs = BACKOFF_MAX_MS,
): number {
  const exponential = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(exponential, maxMs);
}

/**
 * 判断某个错误是否值得重试。
 *
 * 文档第 24、26 条：命中防御机制（验证码 / Challenge / 访问拒绝）时必须
 * 停止自动抓取并交还用户，**不得重试**。
 */
export function isRetryable(kind: string): boolean {
  return kind === "Timeout" || kind === "NetworkError";
}

/**
 * 遇到 429 时的重试判定：限流属于「降频后可再试」，但仍受最大次数约束。
 */
export function isRateLimitedRetryable(kind: string, attempt: number): boolean {
  return kind === "RateLimited" && attempt < MAX_RETRIES;
}
