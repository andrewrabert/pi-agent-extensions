# pi-extension-bashbert

This Pi extension starts `bashbert mcp` and dynamically exposes every tool provided by the Bashbert MCP server. It is disabled by default.

Load and enable the extension with:

```sh
pi -e ./extensions/bashbert --bashbert-enabled
```

Tool names use the `bashbert_` prefix by default. Set `--bashbert-prefix` to change it, or set it to an empty string to use the normalized MCP tool names directly:

```sh
pi -e ./extensions/bashbert --bashbert-enabled --bashbert-prefix sandbox_
```

Bashbert must be available on `PATH`. Configure Bashbert outside this extension.

Install the package for the current Pi project with:

```sh
pi install -l ./extensions/bashbert
```
