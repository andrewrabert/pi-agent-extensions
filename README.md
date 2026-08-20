# pi-agent-extensions

Personal extensions for [Pi](https://pi.dev/), distributed as a Pi package.

## Extensions

- **loop-verifier** — iteratively runs an agent and verifier until accepted or the cycle limit is reached.
- **noted-mcp** — exposes tools from a local [`noted`](https://github.com/andrewrabert/noted) MCP server.
- **subagent** — delegates work to specialized Pi agents in single, parallel, or chained modes.
- **web-research** — provides public-web search and page fetching tools with SSRF protections.

## Install

```sh
pi install git:github.com/andrewrabert/pi-agent-extensions
```

Update with:

```sh
pi update --extensions
```

The noted extension runs `noted server mcp` from `PATH`. Set `NOTED_COMMAND` to override the executable.
