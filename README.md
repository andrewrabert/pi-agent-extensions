# pi-agent-extensions

Personal extensions for [Pi](https://pi.dev/), distributed as a Pi package.

## Extensions

- **loop-verifier** — iteratively runs an agent and verifier until accepted or the cycle limit is reached.
- **noted-mcp** — exposes tools from a local [`noted`](https://github.com/andrewrabert/noted) MCP server.
- **subagent** — starts persistent background Pi agents that can be messaged and stopped.
- **andrewrabert-dev** — registers Andrew Rabert's bundled development agents with the subagent extension.
- **web-research** — provides public-web search and page fetching tools with SSRF protections.

## Themes

- **ansi-dark**
- **base16**
- **terminal-tinted**

## Install

```sh
pi install git:github.com/andrewrabert/pi-agent-extensions
```

Update with:

```sh
pi update --extensions
```

The noted extension runs `noted server mcp` from `PATH`. Set `NOTED_COMMAND` to override the executable.

The subagent extension accepts bundled agent directories through the shared `subagent:register-agent-path` event. Bundled agents have lower precedence than user agents in `~/.pi/agent/agents`, which in turn have lower precedence than project agents in `.pi/agents`.

Subagents use persistent SDK sessions. Their transcripts are stored in a directory named for the parent session ID beside the parent transcript, so they do not appear in `/resume`. The child session ID is also the public subagent ID used by `subagent_send` and `subagent_stop`.

In agent frontmatter, the `agent` tool grant expands to all three lifecycle tools: `subagent`, `subagent_send`, and `subagent_stop`. Their usage instructions come from the extension's tool metadata rather than individual agent prompts.
