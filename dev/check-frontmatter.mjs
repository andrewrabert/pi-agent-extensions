import fs from "node:fs";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

for (const file of fs.globSync("extensions/**/*.md")) {
	try {
		parseFrontmatter(fs.readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
