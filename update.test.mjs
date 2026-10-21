// Tests for update.mjs. Run with `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHANGELOG_URL,
  OVERVIEW_URL,
  formatCatalog,
  main,
  mergeCatalog,
  parseChangelogMinimums,
  parseOverview,
  validateCatalog,
} from "./update.mjs";

// The rows that matter, shaped like the models overview's comparison table.
const OVERVIEW = `
# Models overview

| Feature | Claude Fable 5.1 | Claude Opus 5.5 | Claude Sonnet 5.5 | Claude Haiku 5.5 |
| :--- | :--- | :--- | :--- | :--- |
| Model page | [Claude Fable 5.1](https://example.com/a) | [Claude Opus 5.5](https://example.com/b) | x | y |
| Claude API ID | \`claude-fable-5-1\` | \`claude-opus-5-5\` | \`claude-sonnet-5-5\` | \`claude-haiku-5-5\` |
| Claude API alias | \`claude-fable-5-1\` | \`claude-opus-5-5\` | \`claude-sonnet-5-5\` | \`claude-haiku-5-5\` |
| [Amazon Bedrock ID](https://example.com/c) | \`anthropic.claude-fable-5-1\` | \`anthropic.claude-opus-5-5\` | \`anthropic.claude-sonnet-5-5\` | \`anthropic.claude-haiku-5-5\` |
`;

const CHANGELOG = `# Changelog

## 2.1.302
- Fixed token counts for Haiku 5.5 (\`claude-haiku-5-5\`) behind some gateways

## 2.1.293
- Added Claude Haiku 5.5 (\`claude-haiku-5-5\`), now the default Haiku model

## 2.1.284
- Added Claude Sonnet 5.5 (\`claude-sonnet-5-5\`), now the default Sonnet model
- Added OpenTelemetry guidance to the \`claude-api\` skill

## 2.1.280
- Added Claude Opus 5.5 (\`claude-opus-5-5\`), now the default Opus model
`;

const seed = () => JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url), "utf8"));

test("catalog.json itself passes every rule a reader applies", () => {
  validateCatalog(seed());
});

test("catalog.json is stored in the format the job writes, so a run never rewrites it for nothing", () => {
  assert.equal(formatCatalog(seed()), readFileSync(new URL("./catalog.json", import.meta.url), "utf8"));
});

test("the overview's API ids are read column by column, alias first", () => {
  assert.deepEqual(parseOverview(OVERVIEW), ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  const dated = `| **Claude API ID** | \`claude-x-6-20270101\` | \`claude-y-6\` |\n| Claude API alias | \`claude-x-6\` | |`;
  assert.deepEqual(parseOverview(dated), ["claude-x-6", "claude-y-6"]);
});

test("a page that no longer has the id row fails loudly instead of reporting nothing new", () => {
  for (const page of [
    "",
    "<!DOCTYPE html><html><body>Models</body></html>",
    OVERVIEW.replace(/Claude API ID/, "API name").replace(/Claude API alias/, "Shortcut"),
    "| Claude API ID | to be announced |",
  ]) {
    assert.throws(() => parseOverview(page), /no Claude API model ids/);
  }
});

test("minimums come only from 'Added Claude …' entries, oldest version first", () => {
  const mins = parseChangelogMinimums(CHANGELOG);
  assert.deepEqual(Object.fromEntries(mins), {
    "claude-haiku-5-5": "2.1.293",
    "claude-sonnet-5-5": "2.1.284",
    "claude-opus-5-5": "2.1.280",
  });
  assert.equal(mins.has("claude-api"), false);
});

test("a new published model is added after the last Claude entry, with its minimum", () => {
  const { catalog, added } = mergeCatalog(seed(), ["claude-opus-5-5", "claude-opus-6"], new Map([["claude-opus-6", "2.1.320"]]));
  assert.deepEqual(added, ["claude-opus-6"]);
  const ids = catalog.models.map((m) => m.id);
  assert.equal(ids.indexOf("claude-opus-6"), ids.indexOf("claude-haiku-5-5") + 1);
  assert.deepEqual(catalog.models.find((m) => m.id === "claude-opus-6"), {
    id: "claude-opus-6",
    provider: "claude",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    min_claude_code: "2.1.320",
  });
  validateCatalog(catalog);
});

test("nothing new: the catalog is unchanged", () => {
  const before = seed();
  const { catalog, added, filled } = mergeCatalog(before, ["claude-opus-5-5", "claude-sonnet-5-5"], parseChangelogMinimums(CHANGELOG));
  assert.deepEqual([added, filled], [[], []]);
  assert.deepEqual(catalog, before);
});

test("never proposes a removal: models the page stopped listing all stay", () => {
  const before = seed();
  const { catalog } = mergeCatalog(before, ["claude-opus-7"], new Map());
  for (const m of before.models) assert.ok(catalog.models.some((n) => n.id === m.id), m.id);
});

test("a missing minimum is filled; one already set is never changed", () => {
  const before = seed();
  const { catalog, filled } = mergeCatalog(before, [], new Map([["claude-sonnet-5", "2.1.200"], ["claude-opus-5-5", "2.1.1"]]));
  assert.deepEqual(filled, ["claude-sonnet-5"]);
  assert.equal(catalog.models.find((m) => m.id === "claude-sonnet-5").min_claude_code, "2.1.200");
  assert.equal(catalog.models.find((m) => m.id === "claude-opus-5-5").min_claude_code, "2.1.280");
});

test("the validator refuses what a reader would refuse", () => {
  const bad = [
    { id: "claude-x; rm -rf ~" },
    { id: "Claude-X" },
    { id: "claude-x", provider: "codex" },
    { id: "gpt-x", provider: "claude" },
    { efforts: ["low", "high"] },
    { efforts: ["medium", "ultra"] },
    { min_claude_code: "v2.1.0" },
  ];
  for (const change of bad) {
    const c = seed();
    c.models[0] = { ...c.models[0], ...change };
    assert.throws(() => validateCatalog(c), undefined, JSON.stringify(change));
  }
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "catalog-"));
  const file = join(dir, "catalog.json");
  writeFileSync(file, readFileSync(new URL("./catalog.json", import.meta.url), "utf8"));
  return file;
}
const pages = (overview, changelog = CHANGELOG) => async (url) => {
  if (url === OVERVIEW_URL) return overview;
  if (url === CHANGELOG_URL) {
    if (changelog instanceof Error) throw changelog;
    return changelog;
  }
  throw new Error(`unexpected ${url}`);
};

test("a run that finds a new model writes it and says so", async () => {
  const file = scratch();
  const page = OVERVIEW.replace("claude-haiku-5-5` |\n| Claude API alias", "claude-haiku-5-5` | `claude-opus-6` |\n| Claude API alias");
  const summary = await main({ file, get: pages(page, CHANGELOG + "\n## 2.1.330\n- Added Claude Opus 6 (`claude-opus-6`), now the default\n"), log: () => {} });
  assert.equal(summary, "add claude-opus-6");
  const written = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(written.models.find((m) => m.id === "claude-opus-6").min_claude_code, "2.1.330");
});

test("a run with nothing new leaves the file byte for byte", async () => {
  const file = scratch();
  const before = readFileSync(file, "utf8");
  assert.equal(await main({ file, get: pages(OVERVIEW), log: () => {} }), "");
  assert.equal(readFileSync(file, "utf8"), before);
});

test("an unparseable overview fails the run and leaves the file untouched", async () => {
  const file = scratch();
  const before = readFileSync(file, "utf8");
  await assert.rejects(main({ file, get: pages("<html>redesigned</html>"), log: () => {} }), /no Claude API model ids/);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("a run that would pass the readers' 200-model limit fails and leaves the file untouched", async () => {
  const file = scratch();
  const models = Array.from({ length: 200 }, (_, i) => ({ id: `claude-model-${i}`, provider: "claude", efforts: ["medium"], min_claude_code: null }));
  writeFileSync(file, formatCatalog({ schema: 1, source: OVERVIEW_URL, models }));
  const before = readFileSync(file, "utf8");
  await assert.rejects(main({ file, get: pages("| Claude API ID | `claude-model-200` |"), log: () => {} }), /at most 200/);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("a changelog outage still adds the model, without a minimum, and warns", async () => {
  const file = scratch();
  const lines = [];
  const page = OVERVIEW.replace("claude-haiku-5-5` |\n| Claude API alias", "claude-haiku-5-5` | `claude-opus-6` |\n| Claude API alias");
  await main({ file, get: pages(page, new Error("HTTP 503")), log: (l) => lines.push(l) });
  assert.match(lines.join("\n"), /::warning::/);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).models.find((m) => m.id === "claude-opus-6").min_claude_code, null);
});
