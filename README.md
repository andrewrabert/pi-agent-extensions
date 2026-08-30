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

The subagent extension accepts bundled agent directories through the shared `subagent:register-agent-path` event. Bundled agents have lower precedence than user agents in `~/.pi/agent/agents`, which in turn have lower precedence than project agents in `.pi/agents`. Project agents are included only for trusted projects.

At session startup, the extension snapshots the available agents and injects their exact names, descriptions, and tool grants into the system prompt. The `subagent` tool validates names against that same snapshot. Use `/reload` or start a new Pi process after changing agent definitions. Use `--agents <list>` for a comma-separated allowlist, `--exclude-agents <list>` for a comma-separated denylist, or `--no-agents` to disable all subagents by default. An explicit `--agents` allowlist takes precedence over `--no-agents`, matching Pi's tool-selection flags.

Subagents use persistent SDK sessions. Their transcripts are stored in a directory named for the parent session ID beside the parent transcript, so they do not appear in `/resume`. The child session ID is also the public subagent ID used by `subagent_send` and `subagent_stop`.

In agent frontmatter, the `agent` tool grant expands to all three lifecycle tools: `subagent`, `subagent_send`, and `subagent_stop`. Their usage instructions come from the extension's tool metadata rather than individual agent prompts.

Agent definitions can override inherited environment variables. A string sets a variable, including an empty string, while `null` removes an inherited variable. Variables omitted from `env` remain inherited. A main agent selected with `--agent` applies its environment to the Pi process during extension loading and restores the inherited environment when unloaded. A child subagent applies its environment independently to each `bash` invocation.

Persist a global default main agent in `~/.pi/agent/subagent.json` or use `/agent-default <name>`. A trusted project's nearest `.pi/subagent.json` takes precedence over the global file, and `--agent` takes precedence over both. Set `defaultAgent` to `default`, or pass `--agent default`, to start without a main agent.

```json
{
  "defaultAgent": "orchestrator"
}
```

```yaml
env:
  API_URL: "https://example.com"
  EMPTY_VALUE: ""
  REMOVE_INHERITED_VAR: null
```
