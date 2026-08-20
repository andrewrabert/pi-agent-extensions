import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverAgents, registerPackageAgentDir } from "./agents.ts";

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
