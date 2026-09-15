declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";

  /** 表格、删除线、任务列表等 GitHub Flavored Markdown 扩展。 */
  export const gfm: TurndownService.Plugin;
  export const tables: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
  export const taskListItems: TurndownService.Plugin;
  export const highlightedCodeBlock: TurndownService.Plugin;
}
