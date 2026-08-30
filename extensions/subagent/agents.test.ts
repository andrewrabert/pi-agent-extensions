import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	discoverAgents,
	filterAgents,
	formatAvailableAgentsPrompt,
	parseAgentNames,
	parseMainAgentArgument,
	registerPackageAgentDir,
	type AgentConfig,
} from "./agents.ts";

const agentMarkdown = (name: string, description: string) =>
	`---\nname: ${name}\ndescription: ${description}\n---\n\nSystem prompt for ${name}.\n`;

test("discovers registered package agents in user scope", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-package-agents-"));
	try {
		const agentsDir = join(root, "agents");
		mkdirSync(agentsDir);
		writeFileSync(join(agentsDir, "packaged.md"), agentMarkdown("test-packaged-agent", "Packaged agent"));
		registerPackageAgentDir(agentsDir);

		const agent = discoverAgents(root, "user").agents.find((item) => item.name === "test-packaged-agent");
		assert.equal(agent?.source, "package");
		assert.equal(agent?.description, "Packaged agent");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("project agents override package agents in both scope", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-package-agent-precedence-"));
	try {
		const packageDir = join(root, "package-agents");
		const projectDir = join(root, ".pi", "agents");
		mkdirSync(packageDir);
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(packageDir, "shared.md"), agentMarkdown("test-shared-agent", "Package version"));
		writeFileSync(join(projectDir, "shared.md"), agentMarkdown("test-shared-agent", "Project version"));
		registerPackageAgentDir(packageDir);

		const agent = discoverAgents(root, "both").agents.find((item) => item.name === "test-shared-agent");
		assert.equal(agent?.source, "project");
		assert.equal(agent?.description, "Project version");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("parses agent environment overrides", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-package-agent-env-"));
	try {
		const agentsDir = join(root, "agents");
		mkdirSync(agentsDir);
		writeFileSync(
			join(agentsDir, "environment.md"),
			`---
name: test-environment-agent
description: Agent with environment overrides
env:
  SET_VALUE: value
  EMPTY_VALUE: ""
  UNSET_VALUE: null
---
`,
		);
		registerPackageAgentDir(agentsDir);

		const agent = discoverAgents(root, "user").agents.find((item) => item.name === "test-environment-agent");
		assert.deepEqual(agent?.env, {
			SET_VALUE: "value",
			EMPTY_VALUE: "",
			UNSET_VALUE: null,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("finds the main agent in command-line arguments", () => {
	assert.equal(parseMainAgentArgument(["--agent", "fart"]), "fart");
	assert.equal(parseMainAgentArgument(["--agent=fart"]), "fart");
	assert.equal(parseMainAgentArgument(["--agent", "first", "--agent=last"]), "last");
	assert.equal(parseMainAgentArgument(["--", "--agent", "ignored"]), undefined);
	assert.equal(parseMainAgentArgument(["--agents", "fart"]), undefined);
});

test("parses agent flags as comma-separated trimmed names", () => {
	assert.deepEqual(parseAgentNames(" explore,review ,, execute "), ["explore", "review", "execute"]);
	assert.deepEqual(parseAgentNames(""), []);
	assert.equal(parseAgentNames(undefined), undefined);
});

test("filters agents with tool-equivalent selection precedence", () => {
	const agents = ["explore", "review", "execute"].map(
		(name): AgentConfig => ({
			name,
			description: name,
			systemPrompt: "",
			source: "package",
			filePath: `/${name}.md`,
		}),
	);

	assert.deepEqual(
		filterAgents(agents, { agents: ["explore", "review"], noAgents: true, excludeAgents: ["review"] }).map(
			(agent) => agent.name,
		),
		["explore"],
	);
	assert.deepEqual(filterAgents(agents, { noAgents: true }).map((agent) => agent.name), []);
	assert.deepEqual(
		filterAgents(agents, { noAgents: false, excludeAgents: ["execute"] }).map((agent) => agent.name),
		["explore", "review"],
	);
});

test("formats exact agent names, descriptions, and tools for the system prompt", () => {
	const prompt = formatAvailableAgentsPrompt([
		{
			name: "research",
			description: "Researches the web and notes",
			tools: ["web_search", "noted_*"],
			systemPrompt: "",
			source: "package",
			filePath: "/agents/research.md",
		},
	]);

	assert.match(prompt, /one of these exact agent names/);
	assert.match(prompt, /- research: Researches the web and notes \(tools: web_search, noted_\*\)/);
});
