import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { findProjectDefaultAgent, readDefaultAgent, writeDefaultAgent } from "./config.ts";

test("reads and validates a default agent setting", () => {
	const root = mkdtempSync(path.join(tmpdir(), "pi-subagent-config-"));
	try {
		const filePath = path.join(root, "subagent.json");
		writeFileSync(filePath, '{"defaultAgent":" orchestrator "}\n');
		assert.deepEqual(readDefaultAgent(filePath), { name: "orchestrator", filePath });
		assert.equal(readDefaultAgent(path.join(root, "missing.json")), undefined);

		writeFileSync(filePath, '{"defaultAgent":""}\n');
		assert.throws(() => readDefaultAgent(filePath), /defaultAgent must be a non-empty string/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("uses the nearest project default agent setting", () => {
	const root = mkdtempSync(path.join(tmpdir(), "pi-subagent-project-config-"));
	try {
		const nested = path.join(root, "src", "nested");
		mkdirSync(path.join(root, ".pi"), { recursive: true });
		mkdirSync(path.join(root, "src", ".pi"), { recursive: true });
		mkdirSync(nested, { recursive: true });
		writeFileSync(path.join(root, ".pi", "subagent.json"), '{"defaultAgent":"root"}\n');
		writeFileSync(path.join(root, "src", ".pi", "subagent.json"), '{"defaultAgent":"nearest"}\n');

		assert.equal(findProjectDefaultAgent(nested)?.name, "nearest");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("writes a default agent setting atomically", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "pi-subagent-write-config-"));
	try {
		const filePath = path.join(root, "config", "subagent.json");
		await writeDefaultAgent(filePath, "review");
		assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")), { defaultAgent: "review" });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
