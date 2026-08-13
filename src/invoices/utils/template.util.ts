/**
 * A deliberately tiny Mustache-shaped renderer.
 *
 * The invoice template is a designer-owned HTML file that has to stay editable
 * without touching TypeScript, so it needs placeholders — but pulling in a
 * templating dependency for one document (and, with it, a second way of
 * rendering HTML in a codebase that already hand-builds mail bodies) is not
 * worth it. This supports exactly what the invoice needs and nothing else:
 *
 *   {{path}}          escaped interpolation
 *   {{{path}}}        raw interpolation (for pre-built markup / data URIs)
 *   {{#path}}…{{/path}}   array → repeat per item, truthy → render once,
 *                         falsy/empty → omit
 *   {{^path}}…{{/path}}   the inverse
 *
 * `path` may be dotted (`totals.subtotal`). Inside a section, lookups resolve
 * against the item first and fall back to the enclosing context, so an item row
 * can still reach `company.name`. `{{.}}` is the current item itself, which is
 * how the plain-string terms list renders.
 */

type Ctx = Record<string, unknown>;

const SECTION = /\{\{([#^])\s*([\w.]+)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/g;
const RAW = /\{\{\{\s*([\w.]+)\s*\}\}\}/g;
const ESCAPED = /\{\{\s*([\w.]+|\.)\s*\}\}/g;

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function lookup(path: string, stack: unknown[]): unknown {
  // Walk the context stack outwards so an item can still see the document.
  for (let i = stack.length - 1; i >= 0; i--) {
    const scope = stack[i];
    if (path === ".") return scope;
    if (scope == null || typeof scope !== "object") continue;

    let value: unknown = scope;
    let found = true;
    for (const key of path.split(".")) {
      if (value == null || typeof value !== "object" || !(key in value)) {
        found = false;
        break;
      }
      value = (value as Ctx)[key];
    }
    if (found) return value;
  }
  return undefined;
}

function isFalsy(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === false ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function render(template: string, stack: unknown[]): string {
  // Sections first: their bodies may themselves contain sections, and resolving
  // interpolations first would consume placeholders belonging to an item scope.
  const withSections = template.replace(
    SECTION,
    (_match, sigil: string, path: string, body: string) => {
      const value = lookup(path, stack);
      const truthy = !isFalsy(value);

      if (sigil === "^") return truthy ? "" : render(body, stack);
      if (!truthy) return "";

      if (Array.isArray(value)) {
        return value.map((item) => render(body, [...stack, item])).join("");
      }
      return render(
        body,
        value && typeof value === "object" ? [...stack, value] : stack,
      );
    },
  );

  return withSections
    .replace(RAW, (_m, path: string) => String(lookup(path, stack) ?? ""))
    .replace(ESCAPED, (_m, path: string) => escapeHtml(lookup(path, stack)));
}

export function renderTemplate(template: string, context: Ctx): string {
  return render(template, [context]);
}
