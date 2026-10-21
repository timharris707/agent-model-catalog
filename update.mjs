// Keeps catalog.json current from Anthropic's published model list.
//
// Run daily by .github/workflows/update.yml: reads the Claude API model ids
// from Anthropic's models overview, adds any the catalog lacks, and fills in
// each Claude model's oldest supporting Claude Code version from the Claude
// Code changelog. It never removes an entry, and it fails loudly when the
// overview stops parsing, so a page redesign can never read as "no new
// models". No dependencies; run with `node update.mjs`, test with `node --test`.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const OVERVIEW_URL = "https://platform.claude.com/docs/en/about-claude/models/overview.md";
export const CHANGELOG_URL = "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md";
/** The effort levels Claude Code's --effort flag takes. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** The most models a reader accepts in one document. */
export const MAX_MODELS = 200;
const ID_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const EFFORT_RE = /^[a-z]{1,16}$/;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/** Markdown table cells of one line, or null when the line is not a row. */
function rowCells(line) {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  return t.split("|").slice(1, t.endsWith("|") ? -1 : undefined).map((c) => c.trim());
}

/** A row label with links, emphasis and code marks stripped, lowercased. */
function labelOf(cell) {
  return cell.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").trim().toLowerCase();
}

function claudeIdIn(cell) {
  for (const m of cell.matchAll(/`([^`]+)`/g)) {
    if (m[1].startsWith("claude-") && ID_RE.test(m[1])) return m[1];
  }
  return null;
}

/** The Claude API model ids in the overview's comparison table. Column by
 *  column it takes the "Claude API alias" row's id when the column has one
 *  (the dateless name) and the "Claude API ID" row's otherwise. Throws when
 *  neither row yields an id: the page changed shape and this parser needs a
 *  look, which must fail the job rather than report "no new models". */
export function parseOverview(markdown) {
  let idRow = null;
  let aliasRow = null;
  for (const line of String(markdown).split("\n")) {
    const cells = rowCells(line);
    if (!cells || cells.length < 2) continue;
    const label = labelOf(cells[0]);
    if (/^claude api (model )?ids?$/.test(label)) idRow ??= cells;
    else if (/^claude api alias(es)?$/.test(label)) aliasRow ??= cells;
  }
  const ids = [];
  const width = Math.max(idRow?.length ?? 0, aliasRow?.length ?? 0);
  for (let i = 1; i < width; i++) {
    const id = claudeIdIn(aliasRow?.[i] ?? "") ?? claudeIdIn(idRow?.[i] ?? "");
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) {
    throw new Error(
      `no Claude API model ids found in ${OVERVIEW_URL}: the page's comparison table changed shape; update parseOverview`,
    );
  }
  return ids;
}

function versionOlder(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

/** Model id → the oldest Claude Code version whose changelog entry reads
 *  "Added Claude <name> (`<id>`)". Other mentions of an id never count. */
export function parseChangelogMinimums(markdown) {
  const mins = new Map();
  let version = null;
  for (const line of String(markdown).split("\n")) {
    const h = /^##\s+v?(\d{1,4}\.\d{1,4}\.\d{1,4})\b/.exec(line);
    if (h) {
      version = h[1];
      continue;
    }
    const a = /^\s*[-*]\s+Added Claude [^`(\n]*\(`(claude-[a-z0-9.-]+)`\)/.exec(line);
    if (a && version && ID_RE.test(a[1])) {
      const seen = mins.get(a[1]);
      if (!seen || versionOlder(version, seen)) mins.set(a[1], version);
    }
  }
  return mins;
}

/** Add every published id the catalog lacks, after its last Claude entry,
 *  and fill a Claude entry's missing minimum when the changelog names one.
 *  Never removes an entry and never changes a minimum already set. */
export function mergeCatalog(catalog, published, minimums) {
  const models = catalog.models.map((m) => ({ ...m, efforts: [...m.efforts] }));
  const added = [];
  const filled = [];
  for (const m of models) {
    if (m.provider === "claude" && m.min_claude_code == null && minimums.has(m.id)) {
      m.min_claude_code = minimums.get(m.id);
      filled.push(m.id);
    }
  }
  for (const id of published) {
    if (models.some((m) => m.id === id)) continue;
    let at = models.length;
    for (let j = models.length - 1; j >= 0; j--) {
      if (models[j].provider === "claude") {
        at = j + 1;
        break;
      }
    }
    models.splice(at, 0, { id, provider: "claude", efforts: [...CLAUDE_EFFORTS], min_claude_code: minimums.get(id) ?? null });
    added.push(id);
  }
  return { catalog: { ...catalog, models }, added, filled };
}

/** The rules every reader applies, enforced on this file before it is
 *  written: a reader drops an entry that breaks them, so this job never
 *  publishes one. Throws with the first problem. */
export function validateCatalog(catalog) {
  if (!catalog || catalog.schema !== 1 || !Array.isArray(catalog.models)) {
    throw new Error("catalog.json must be { schema: 1, models: [...] }");
  }
  // Readers refuse a whole document past this size, so publishing one would
  // stop every later update from reaching them.
  if (catalog.models.length > MAX_MODELS) {
    throw new Error(`catalog.json would list ${catalog.models.length} models; readers accept at most ${MAX_MODELS}`);
  }
  const seen = new Set();
  for (const m of catalog.models) {
    const id = m?.id;
    if (typeof id !== "string" || !ID_RE.test(id)) throw new Error(`bad model id ${JSON.stringify(id)}`);
    if (seen.has(id)) throw new Error(`${id} is listed twice`);
    seen.add(id);
    if (m.provider !== "claude" && m.provider !== "codex") throw new Error(`${id}: unknown provider`);
    if ((m.provider === "claude") !== id.startsWith("claude-")) throw new Error(`${id}: only Claude ids start with claude-`);
    if (!Array.isArray(m.efforts) || m.efforts.length === 0 || m.efforts.length > 12) {
      throw new Error(`${id}: efforts must be a list of 1 to 12 levels`);
    }
    for (const e of m.efforts) {
      if (typeof e !== "string" || !EFFORT_RE.test(e)) throw new Error(`${id}: bad effort level`);
      if (m.provider === "claude" && !CLAUDE_EFFORTS.includes(e)) throw new Error(`${id}: Claude Code has no effort level ${e}`);
    }
    if (new Set(m.efforts).size !== m.efforts.length) throw new Error(`${id}: an effort level repeats`);
    if (!m.efforts.includes("medium")) throw new Error(`${id}: must take the medium effort`);
    if (m.min_claude_code != null && !(typeof m.min_claude_code === "string" && VERSION_RE.test(m.min_claude_code))) {
      throw new Error(`${id}: min_claude_code must be a version like 2.1.280`);
    }
  }
}

/** One model per line, so a diff shows exactly which model changed. */
export function formatCatalog(catalog) {
  const rows = catalog.models.map(
    (m) => "    " + JSON.stringify({ id: m.id, provider: m.provider, efforts: m.efforts, min_claude_code: m.min_claude_code ?? null }),
  );
  return (
    `{\n  "schema": ${JSON.stringify(catalog.schema)},\n  "source": ${JSON.stringify(catalog.source ?? OVERVIEW_URL)},\n` +
    `  "models": [\n${rows.join(",\n")}\n  ]\n}\n`
  );
}

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return res.text();
}

/** Read, merge, validate, write. Returns what changed, as one line. */
export async function main({ file = "catalog.json", get = fetchText, log = console.log } = {}) {
  const before = readFileSync(file, "utf8");
  const catalog = JSON.parse(before);
  validateCatalog(catalog);
  const published = parseOverview(await get(OVERVIEW_URL));
  let minimums = new Map();
  try {
    minimums = parseChangelogMinimums(await get(CHANGELOG_URL));
  } catch (e) {
    // Secondary source: a new model is still added, its minimum filled later.
    log(`::warning::Claude Code changelog unavailable (${e.message}); minimums are filled on a later run`);
  }
  const { catalog: next, added, filled } = mergeCatalog(catalog, published, minimums);
  validateCatalog(next);
  const lost = catalog.models.filter((m) => !next.models.some((n) => n.id === m.id));
  if (lost.length) throw new Error(`refusing to remove ${lost.map((m) => m.id).join(", ")}`);
  const text = formatCatalog(next);
  if (text !== before) writeFileSync(file, text);
  const parts = [];
  if (added.length) parts.push(`add ${added.join(", ")}`);
  if (filled.length) parts.push(`minimum Claude Code for ${filled.join(", ")}`);
  const summary = parts.join("; ");
  log(summary ? `catalog.json: ${summary}` : `catalog.json is current (${published.length} published Claude models, all listed)`);
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then((summary) => {
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `summary=${summary}\n`);
    })
    .catch((e) => {
      console.error(`::error::${e.message}`);
      process.exit(1);
    });
}
