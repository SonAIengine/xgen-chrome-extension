export function getPageTitle(): string {
  return document.title || '';
}

export function getVisibleHeadings(): string[] {
  const headings = document.querySelectorAll('h1, h2, h3');
  return Array.from(headings)
    .map((el) => el.textContent?.trim() ?? '')
    .filter(Boolean)
    .slice(0, 10);
}

export function getTableData(
  containerSelector?: string,
  maxRows = 20,
): { headers: string[]; rows: string[][]; totalRows: number } | null {
  const container = containerSelector
    ? document.querySelector(containerSelector)
    : document.body;

  if (!container) return null;

  const table = container.querySelector('table');
  if (!table) return null;

  const headerCells = table.querySelectorAll('thead th, thead td');
  const headers = Array.from(headerCells).map(
    (cell) => cell.textContent?.trim() ?? '',
  );

  const bodyRows = table.querySelectorAll('tbody tr');
  const totalRows = bodyRows.length;
  const rows = Array.from(bodyRows)
    .slice(0, maxRows)
    .map((row) =>
      Array.from(row.querySelectorAll('td')).map(
        (cell) => cell.textContent?.trim() ?? '',
      ),
    );

  return { headers, rows, totalRows };
}

export function getFormValues(
  containerSelector?: string,
): Record<string, string> {
  const container = containerSelector
    ? document.querySelector(containerSelector)
    : document.body;

  if (!container) return {};

  const values: Record<string, string> = {};
  const inputs = container.querySelectorAll<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >('input, select, textarea');

  for (const input of inputs) {
    const name =
      input.name ||
      input.id ||
      input.getAttribute('aria-label') ||
      (input instanceof HTMLSelectElement ? '' : input.placeholder);
    if (!name) continue;

    if (input instanceof HTMLInputElement && input.type === 'checkbox') {
      values[name] = input.checked ? 'checked' : 'unchecked';
    } else {
      values[name] = input.value;
    }
  }

  return values;
}

export function clickElement(selector: string, text?: string): boolean {
  const candidates = document.querySelectorAll<HTMLElement>(selector);
  for (const el of candidates) {
    if (text && !el.textContent?.includes(text)) continue;
    el.click();
    return true;
  }
  return false;
}

export function fillInput(selector: string, value: string): boolean {
  const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    selector,
  );
  if (!el) return false;

  const nativeInputValueSetter =
    Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )?.set;

  nativeInputValueSetter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

export function getSelectedText(): string {
  return window.getSelection()?.toString().trim() ?? '';
}
