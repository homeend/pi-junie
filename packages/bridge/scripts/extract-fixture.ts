// Turns a recorded Junie <-> AIR wire log (acp-messages.jsonl) into a trimmed, redacted replay fixture.
// Usage: node scripts/extract-fixture.ts <acp-messages.jsonl> <fixture-name> [--max-prompts N]
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const [input, name, ...rest] = process.argv.slice(2);
if (!input || !name) {
	console.error("usage: extract-fixture.ts <acp-messages.jsonl> <fixture-name> [--max-prompts N]");
	process.exit(1);
}
const maxPromptsIdx = rest.indexOf("--max-prompts");
const maxPrompts = maxPromptsIdx >= 0 ? Number(rest[maxPromptsIdx + 1]) : Number.POSITIVE_INFINITY;

const HOME = homedir();
const SECRET_KEY = /(key|token|secret|authorization|password)/i;

function redact(value: unknown, keyName = ""): unknown {
	if (typeof value === "string") {
		if (SECRET_KEY.test(keyName)) return "<redacted>";
		return value.split(HOME).join("/home/user");
	}
	if (Array.isArray(value)) {
		// MCP env entries are [{name, value}] pairs: redact by the entry's name
		return value.map((v) =>
			v && typeof v === "object" && "name" in v && "value" in v && SECRET_KEY.test(String((v as { name: string }).name))
				? { ...(v as object), value: "<redacted>" }
				: redact(v, keyName),
		);
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			if (k === "type" && typeof v === "string" && v.startsWith("com.agentclientprotocol")) continue; // logger artefact
			out[k] = k === "headers" && v && typeof v === "object" ? Object.fromEntries(Object.keys(v).map((h) => [h, "<redacted>"])) : redact(v, k);
		}
		return out;
	}
	return value;
}

function truncateText(value: unknown): unknown {
	if (typeof value === "string") return value.length > 600 ? `${value.slice(0, 600)}…<truncated ${value.length - 600}>` : value;
	if (Array.isArray(value)) return value.map(truncateText);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateText(v)]));
	return value;
}

type Logged = { direction: "IN" | "OUT"; message: Record<string, unknown> };
const lines = readFileSync(input, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Logged);

const client: unknown[] = [];
const reference: unknown[] = [];
let prompts = 0;
for (const { direction, message } of lines) {
	const msg = redact(message) as Record<string, unknown>;
	if (direction === "IN") {
		if (msg.method === "session/prompt" && ++prompts > maxPrompts) break;
		client.push(msg);
	} else {
		const result = msg.result as { sessions?: unknown[] } | undefined;
		if (Array.isArray(result?.sessions) && result.sessions.length > 2) result.sessions = result.sessions.slice(0, 2); // keep fixtures small
		reference.push(truncateText(msg));
	}
}

const fixture = { name, source: basename(dirname(dirname(input))), client, reference };
const out = join(import.meta.dirname, "..", "test", "fixtures", `${name}.json`);
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${out}: ${client.length} client messages, ${reference.length} reference messages`);
