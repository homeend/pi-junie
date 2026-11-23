// Composition root: ACP over stdio (driver) + Pi (bridge). Started by AIR via bin/pi-air.
// stdout carries ACP only; diagnostics go to PI_AIR_LOG (or stderr).
//
// Log line format: <ISO time> <LEVEL> <scope> <message>
//   scopes: pi-junie (process), acp (requests), wire (raw JSON-RPC, redacted), pi (bridge), http (LLM calls)
// PI_AIR_WIRE=0 disables the raw wire lines; PI_AIR_DEBUG=1 enables debug lines.

import { fileURLToPath } from "node:url";
import { appendFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { junieCredentials, junieModelChoice } from "pi-junie-config/credentials";
import { loadJunieProfiles, profileDirectories } from "pi-junie-config/profiles";
import { describeJunieSettings, resolveJunieSettings } from "pi-junie-config/settings";
import { AcpAgent } from "./acp/agent.ts";
import type { JsonObject, Transport } from "./acp/jsonrpc.ts";
import { createLogger, type LogLevel, redactSecrets } from "./core/log.ts";
import { PiBackend } from "./pi/backend.ts";
import { withoutPlaceholderAuth } from "./pi/proxy-auth.ts";

const LOG_FILE = process.env.PI_AIR_LOG;
const WIRE = process.env.PI_AIR_WIRE !== "0";
const DEBUG = process.env.PI_AIR_DEBUG === "1";
const stdoutWrite = process.stdout.write.bind(process.stdout);

function sink(level: LogLevel, scope: string, message: string): void {
	if (level === "debug" && !DEBUG) return;
	const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${scope} ${message}\n`;
	if (LOG_FILE) appendFileSync(LOG_FILE, line);
	else process.stderr.write(line);
}
const log = createLogger(sink);
const httpLog = log.child("http");

// Anything that tries to print to stdout (libraries, console.log) would corrupt the ACP stream.
console.log = (...args: unknown[]) => log.warn(`console.log: ${args.map(String).join(" ")}`);
console.info = console.log;
console.debug = (...args: unknown[]) => log.debug(`console.debug: ${args.map(String).join(" ")}`);
console.warn = (...args: unknown[]) => log.warn(`console.warn: ${args.map(String).join(" ")}`);
console.error = (...args: unknown[]) => log.error(`console.error: ${args.map(String).join(" ")}`);
process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
	log.warn(`stray stdout write dropped: ${String(chunk).slice(0, 200)}`);
	const cb = rest.find((r) => typeof r === "function") as (() => void) | undefined;
	cb?.();
	return true;
}) as typeof process.stdout.write;

process.on("uncaughtException", (err) => log.error(`uncaughtException: ${err.stack ?? err}`));
process.on("unhandledRejection", (reason) => log.error(`unhandledRejection: ${(reason as Error)?.stack ?? String(reason)}`));
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
	process.on(signal, () => {
		log.info(`received ${signal}, exiting`);
		process.exit(0);
	});
}
process.on("exit", (code) => log.info(`process exit code=${code}`));

// Log every outgoing LLM request (method, URL, status, duration; body excerpt on failure), after dropping the
// placeholder API key Pi's SDK clients add (the AIR proxy authenticates through its own headers, like Junie).
const realFetch = withoutPlaceholderAuth(globalThis.fetch);
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	const method = init?.method ?? (input instanceof Request ? input.method : "GET");
	const started = Date.now();
	httpLog.info(`-> ${method} ${url}`);
	try {
		const res = await realFetch(input, init);
		const took = Date.now() - started;
		if (res.ok) httpLog.info(`<- ${res.status} ${method} ${url} ${took}ms`);
		else {
			const body = await res.clone().text().catch(() => "<unreadable>");
			httpLog.error(`<- ${res.status} ${res.statusText} ${method} ${url} ${took}ms body: ${redactSecrets(body.slice(0, 1000))}`);
		}
		return res;
	} catch (err) {
		httpLog.error(`<- network error ${method} ${url} after ${Date.now() - started}ms: ${(err as Error).message}`);
		throw err;
	}
};

function stdioTransport(): Transport {
	let onMessage: (m: JsonObject) => void = () => {};
	let buffer = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		buffer += chunk;
		let nl = buffer.indexOf("\n");
		while (nl >= 0) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (line) {
				if (WIRE) sink("info", "pi-junie:wire", `<< ${redactSecrets(line)}`);
				try {
					onMessage(JSON.parse(line) as JsonObject);
				} catch (err) {
					log.error(`bad json from client: ${(err as Error).message}`);
				}
			}
			nl = buffer.indexOf("\n");
		}
	});
	return {
		send(message) {
			const line = JSON.stringify(message);
			if (WIRE) sink("info", "pi-junie:wire", `>> ${redactSecrets(line)}`);
			stdoutWrite(`${line}\n`);
		},
		onMessage(listener) {
			onMessage = listener;
		},
		onClose(listener) {
			process.stdin.on("end", listener);
		},
	};
}

log.info(`starting pid=${process.pid} node=${process.version} cwd=${process.cwd()} log=${LOG_FILE ?? "stderr"}`);
const junieSettings = describeJunieSettings(resolveJunieSettings());
if (junieSettings) log.info(`Junie settings from the environment: ${junieSettings}`);
// Junie's custom model profiles: the process's project (.junie/models, for headless runs) and $JUNIE_HOME/models.
const junieProfiles = loadJunieProfiles(profileDirectories(process.cwd()));
for (const [id, error] of Object.entries(junieProfiles.errors)) log.error(`Junie profile ${id} not loaded: ${error}`);
const backend = await PiBackend.create({
	logger: log.child("pi"),
	version: "0.1.0",
	trustProject: process.env.PI_AIR_TRUST_PROJECT !== "0", // PI_AIR_TRUST_PROJECT=0: no project skills
	// Junie compatibility: AIR's IDE router as `execute_tool` (PI_AIR_JUNIE_EXECUTE_TOOL=0 keeps the MCP name)
	junieCompat: { executeToolAlias: process.env.PI_AIR_JUNIE_EXECUTE_TOOL !== "0" },
	// Junie's keys and model choice from the environment (JUNIE_API_KEY, JUNIE_<VENDOR>_API_KEY, JUNIE_MODEL, ...).
	junie: { credentials: junieCredentials(), model: junieModelChoice(), profiles: junieProfiles.profiles },
	// Built-in plugins from this repository's packages: Junie Config (Junie's settings from the environment; inert
	// without them) and Junie Cost (PI_AIR_JUNIE_COST=0 leaves it out).
	bundledPlugins: [
		fileURLToPath(new URL("../../junie-config", import.meta.url)),
		...(process.env.PI_AIR_JUNIE_COST === "0" ? [] : [fileURLToPath(new URL("../../junie-cost", import.meta.url))]),
	],
	// Plugins installed with `pi install` (e.g. subagents) are found in the user's Pi agent dir; PI_AIR_PLUGINS=0 skips them.
	piAgentDir: process.env.PI_AIR_PLUGINS === "0" ? undefined : getAgentDir(),
	// New chats open with a welcome message (Pi version, subagents available or not); PI_AIR_WELCOME=0 turns it off.
	welcome: process.env.PI_AIR_WELCOME !== "0",
});
new AcpAgent(stdioTransport(), backend, { logger: log.child("acp") });
log.info("ready");
process.stdin.on("end", () => {
	log.info("stdin closed by client, exiting");
	process.exit(0);
});
