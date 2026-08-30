import assert from "node:assert/strict";
import test from "node:test";
import { AgentEnvironmentOverlay, applyAgentEnvironment } from "./environment.ts";

test("applies agent environment overrides without mutating the inherited environment", () => {
	const inherited = {
		INHERITED: "kept",
		OVERRIDDEN: "old",
		EMPTIED: "old",
		REMOVED: "old",
	};

	const env = applyAgentEnvironment(inherited, {
		OVERRIDDEN: "new",
		EMPTIED: "",
		REMOVED: null,
	});

	assert.deepEqual(env, {
		INHERITED: "kept",
		OVERRIDDEN: "new",
		EMPTIED: "",
	});
	assert.equal(inherited.REMOVED, "old");
});

test("applies and restores a main-agent environment overlay", () => {
	const target: NodeJS.ProcessEnv = {
		INHERITED: "kept",
		OVERRIDDEN: "old",
		REMOVED: "old",
	};
	const overlay = new AgentEnvironmentOverlay(target);

	overlay.apply({ OVERRIDDEN: "new", EMPTY: "", REMOVED: null });
	assert.deepEqual(target, { INHERITED: "kept", OVERRIDDEN: "new", EMPTY: "" });

	overlay.apply({ NEXT: "value" });
	assert.deepEqual(target, { INHERITED: "kept", OVERRIDDEN: "old", REMOVED: "old", NEXT: "value" });

	overlay.restore();
	assert.deepEqual(target, { INHERITED: "kept", OVERRIDDEN: "old", REMOVED: "old" });
});
