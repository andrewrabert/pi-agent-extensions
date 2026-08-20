import assert from "node:assert/strict";
import test from "node:test";
import { resolveToolPatterns } from "./tool-patterns.ts";

const available = ["read", "noted_search_notes", "noted_read_note", "bash"];

test("expands asterisk patterns in registered-tool order", () => {
	assert.deepEqual(resolveToolPatterns(["noted_*"], available), {
		tools: ["noted_search_notes", "noted_read_note"],
		unmatched: [],
	});
});

test("a bare asterisk selects every tool", () => {
	assert.deepEqual(resolveToolPatterns(["*"], available), { tools: available, unmatched: [] });
});

test("combines exact names and patterns without duplicates", () => {
	assert.deepEqual(resolveToolPatterns(["read", "noted_*", "noted_read_note"], available), {
		tools: ["read", "noted_search_notes", "noted_read_note"],
		unmatched: [],
	});
});

test("reports exact names and patterns that match no registered tool", () => {
	assert.deepEqual(resolveToolPatterns(["write", "missing_*"], available), {
		tools: [],
		unmatched: ["write", "missing_*"],
	});
});
