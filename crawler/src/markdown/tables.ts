import { JSDOM, VirtualConsole } from "jsdom";

/**
 * 表格表头归一化。
 *
 * **为什么需要这一步：** Turndown 的 GFM 表格规则要求表格首行的单元格是
 * `<th>`（或存在 `<thead>`），否则它判定该表格不可转换，直接放弃并把整张表
 * 以原始 HTML 输出。
 *
 * 现实中的文档站（例如 HarmonyOS 开发者文档）大量使用
 * `<table><tbody><tr><td>参数</td><td>说明</td></tr>...` 这种写法 —— 表头行
 * 也是 `<td>`，也没有 `<thead>`。结果是文档第 13 条要求的「保留表格」实际
 * 退化成了一大段带 `id` 属性的原始 HTML。
 *
 * 处理方式：把无 `<thead>` 的表格首行单元格提升为 `<th>`，并补上显式的
 * `<thead>` / `<tbody>` 结构，使其符合 GFM 规则的判定条件。
 *
 * 嵌套表格（表格里还有表格）保持原样：GFM 规则同样不对它们做转换，
 * 强行改写反而会破坏结构。
 */

/**
 * 表格内部元素的 `id` 属性在 Markdown 中没有意义，顺手清理以减小产物体积。
 * 注意要覆盖表格的全部后代 —— 真实文档站的 `id` 往往挂在单元格内的 `<p>` 上，
 * 只清理表结构元素会漏掉它们。
 */
const NOISY_ID_SELECTOR = "table, table *";

export function promoteTableHeaders(html: string): string {
  // 快速路径：绝大多数页面没有表格，避免无谓的 DOM 解析开销
  if (!html.includes("<table")) return html;

  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});

  let document: Document;
  try {
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
      virtualConsole,
    });
    document = dom.window.document;
  } catch {
    return html;
  }

  try {
    for (const table of Array.from(document.querySelectorAll("table"))) {
      if (table.querySelector("table")) continue; // 跳过嵌套表格
      normalizeTable(document, table);
    }

    for (const element of Array.from(document.querySelectorAll(NOISY_ID_SELECTOR))) {
      element.removeAttribute("id");
    }

    return document.body.innerHTML;
  } finally {
    document.defaultView?.close();
  }
}

/**
 * 去掉单元格内唯一 `<p>` 的包裹。
 *
 * 真实页面普遍写作 `<td><p>内容</p></td>`。`<p>` 是块级元素，转换时会产生
 * 多余换行，把 `| 参数 | 注释 |` 破坏成 `| \n参数\n\n | ...`。
 * 仅在单元格只有这一个 `<p>` 子元素时展开，含多个段落时保持原样。
 */
function unwrapSingleParagraph(cell: Element): void {
  const children = Array.from(cell.children);
  if (children.length !== 1) return;

  const only = children[0];
  if (only.tagName !== "P") return;

  cell.innerHTML = only.innerHTML;
}

function normalizeTable(document: Document, table: Element): void {
  const rows = Array.from(table.querySelectorAll("tr")).filter(
    (row) => row.closest("table") === table,
  );
  if (rows.length === 0) return;

  for (const cell of Array.from(table.querySelectorAll("th, td"))) {
    unwrapSingleParagraph(cell);
  }

  const firstRow = rows[0];
  const alreadyHasHeader =
    table.querySelector("thead") !== null ||
    Array.from(firstRow.children).every((cell) => cell.tagName === "TH");

  if (!alreadyHasHeader) {
    // 首行是数据行样式（td），但位置决定了它是表头：
    // 把这些 td 提升为 th，并包进显式的 thead
    for (const cell of Array.from(firstRow.children)) {
      if (cell.tagName !== "TD") continue;
      const th = document.createElement("th");
      for (const attribute of Array.from(cell.attributes)) {
        th.setAttribute(attribute.name, attribute.value);
      }
      th.innerHTML = cell.innerHTML;
      cell.replaceWith(th);
    }

    const thead = document.createElement("thead");
    firstRow.replaceWith(thead);
    thead.appendChild(firstRow);
  }

  // 其余行确保位于 tbody 内（jsdom 通常已隐式补齐，此处仅作兜底）
  const remaining = rows.slice(1);
  if (remaining.length === 0) return;

  const existingBody = table.querySelector(":scope > tbody");
  if (existingBody) return;

  const tbody = document.createElement("tbody");
  for (const row of remaining) {
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
}
