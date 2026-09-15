import robotsParserFactory from "robots-parser";
import { USER_AGENT } from "../http/fetch.js";

/**
 * robots-parser 自带的类型声明使用了自我遮蔽的 `declare module 'robots-parser';`，
 * 导致导入结果被推断为模块命名空间而非可调用函数。这里给出准确的本地类型并断言。
 */
interface RobotsParser {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
  isDisallowed(url: string, userAgent?: string): boolean | undefined;
  getCrawlDelay(userAgent?: string): number | undefined;
  getSitemaps(): string[];
}

type RobotsParserFactory = (url: string, contents: string) => RobotsParser;

const createRobotsParser = robotsParserFactory as unknown as RobotsParserFactory;

/**
 * robots.txt 处理。
 *
 * 文档第 27 条要求该规则必须由作者明确。经作者确认的策略是：
 * **严格遵循，但用户在输入框中显式指定的 URL 豁免。**
 *
 * 换言之：
 * - 用户直接粘贴的 URL —— 用户已明确表达抓取意图，不受 Disallow 限制
 * - 程序自动发现的页面（多页接续等）—— 必须遵循 Disallow
 *
 * 无论是否豁免，都会读取 robots.txt，以便获取 Crawl-delay 并降低访问频率。
 */

interface RobotsEntry {
  parser: RobotsParser | null;
  /** robots.txt 拉取失败时为真，此时按「未声明限制」处理。 */
  unavailable: boolean;
}

export interface RobotsDecision {
  allowed: boolean;
  /** 站点在 robots.txt 中声明的抓取间隔（秒）。 */
  crawlDelaySeconds: number | null;
  /** 拒绝原因，仅在 `allowed` 为 false 时有值。 */
  reason: string | null;
  /** robots.txt 是否成功获取。 */
  robotsAvailable: boolean;
}

export class RobotsCache {
  private readonly entries = new Map<string, RobotsEntry>();
  private readonly timeoutMs: number;

  constructor(timeoutMs = 10_000) {
    this.timeoutMs = timeoutMs;
  }

  /** 获取并缓存某个 origin 的 robots.txt。 */
  private async load(origin: string): Promise<RobotsEntry> {
    const cached = this.entries.get(origin);
    if (cached) return cached;

    const robotsUrl = new URL("/robots.txt", origin).toString();
    let entry: RobotsEntry;

    try {
      const response = await fetch(robotsUrl, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/plain,*/*;q=0.8" },
        redirect: "follow",
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (response.ok) {
        const text = await response.text();
        entry = { parser: createRobotsParser(robotsUrl, text), unavailable: false };
      } else {
        // 404 / 403 等：视为未声明限制
        entry = { parser: null, unavailable: true };
      }
    } catch {
      entry = { parser: null, unavailable: true };
    }

    this.entries.set(origin, entry);
    return entry;
  }

  /**
   * 判断某个 URL 是否允许抓取。
   *
   * @param url 目标地址
   * @param userSpecified 该 URL 是否由用户在输入框中显式指定
   */
  async check(url: string, userSpecified: boolean): Promise<RobotsDecision> {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return { allowed: false, crawlDelaySeconds: null, reason: "URL 无法解析", robotsAvailable: false };
    }

    const entry = await this.load(origin);
    const robotsAvailable = !entry.unavailable;

    if (!entry.parser) {
      return { allowed: true, crawlDelaySeconds: null, reason: null, robotsAvailable };
    }

    const delay = entry.parser.getCrawlDelay(USER_AGENT);
    const crawlDelaySeconds = typeof delay === "number" && delay > 0 ? delay : null;

    if (userSpecified) {
      // 用户显式指定的 URL 豁免 Disallow 判定
      return { allowed: true, crawlDelaySeconds, reason: null, robotsAvailable };
    }

    const allowed = entry.parser.isAllowed(url, USER_AGENT);
    if (allowed === false) {
      return {
        allowed: false,
        crawlDelaySeconds,
        reason: "目标站点的 robots.txt 禁止抓取该地址",
        robotsAvailable,
      };
    }

    return { allowed: true, crawlDelaySeconds, reason: null, robotsAvailable };
  }
}
