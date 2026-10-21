# agent-model-catalog

The list of AI models a team chat's agent menus offer. Public on purpose: it holds model names, the effort levels each one takes, and the oldest Claude Code version that can run it. No secrets and nothing private.

A daily job keeps `catalog.json` current from Anthropic's published model list. Chat servers read it every hour and keep their last good copy, so a new model reaches every installation without a code change or a deploy. A server's own built-in models always keep their own settings: this file can only add models. A model the file added stays on a server while the file lists it or someone has pinned it.

## The file

`catalog.json` is `{ "schema": 1, "source": ..., "models": [...] }`, one model per line:

| Field | Meaning |
| --- | --- |
| `id` | The model id a launcher passes as `--model`. Lowercase letters, digits, dots and hyphens; Claude ids start with `claude-`. |
| `provider` | `claude` (runs in Claude Code) or `codex` (runs in the Codex CLI). |
| `efforts` | The effort levels the model's own CLI takes, in order. Every model takes `medium`. |
| `min_claude_code` | The oldest Claude Code that can run the model, or `null` when none is known. A launcher older than this uses its default model instead. |

Readers drop any entry that breaks these rules, ignore a `min_claude_code` of 3.0.0 or above, take at most 200 added models in file order, and ignore a document whose `schema` is not 1, so a breaking format change needs a new schema number. The update job checks every rule before it writes, and never writes more than 200 models.

## How it updates

`.github/workflows/update.yml` runs `update.mjs` every day at 14:17 UTC:

1. Reads the Claude API ids from Anthropic's [models overview](https://platform.claude.com/docs/en/about-claude/models/overview.md).
2. Adds any id the catalog lacks, with Claude Code's effort levels and the version whose [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) entry reads "Added Claude … (`id`)".
3. Fills a missing `min_claude_code` the same way. A minimum already set is never changed.
4. Commits `catalog.json` when it changed.

It never removes a model, so a pin someone stored keeps working after Anthropic retires a model. If the overview page changes shape and no id can be read, the run fails and shows red rather than reporting that nothing is new. Codex entries are kept by hand: the Codex model list is only served to a signed-in Codex CLI, so there is no public source to read.

Run the tests with `node --test` (Node 20 or newer, no dependencies).

Set up by Claude Opus 5.5 via Claude Code for Tim Harris, 2026-10-21.
