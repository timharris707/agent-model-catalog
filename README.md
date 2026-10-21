# agent-model-catalog

The list of AI models a team chat's agent menus offer. Public on purpose: it holds model names, the effort levels each one takes, and the oldest Claude Code version that can run it. No secrets and nothing private.

A daily job keeps `catalog.json` current from Anthropic's published model list. Chat servers read it every hour, keep their last good copy, and never drop a model they already list, so a new model reaches every installation without a code change or a deploy.

Set up by Claude Opus 5.5 via Claude Code for Tim Harris, 2026-10-21.
