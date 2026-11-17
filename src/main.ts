// Composition root: ACP over stdio (driver) + Pi (bridge). Started by AIR via bin/pi-air.
// stdout carries ACP only; every diagnostic goes to stderr or the PI_AIR_LOG file.

import { appendFileSync } from "node:fs";
import { AcpAgent } from "./acp/agent.ts";
import type { JsonObject, Transport } from "./acp/jsonrpc.ts";
import { PiBackend } from "./pi/backend.ts";

const LOG_FILE = process.env.PI_AIR_LOG;
const stdoutWrite = process.stdout.write.bind(process.stdout);

function log(line: string): void {
	const stamped = `${new Date().toISOString()} ${line}\n`;
	if (LOG_FILE) appendFileSync(LOG_FILE, stamped);
	else process.stderr.write(stamped);
}

// Anything that tries to print to stdout (libraries, console.log) would corrupt the ACP stream.
console.log = (...args: unknown[]) => log(`console.log: ${args.map(String).join(" ")}`);
console.info = console.log;
console.debug = console.log;
process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
	log(`stray stdout write dropped: ${String(chunk).slice(0, 200)}`);
	const cb = rest.find((r) => typeof r === "function") as (() => void) | undefined;
	cb?.();
	return true;
}) as typeof process.stdout.write;

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
				if (LOG_FILE) log(`<< ${line}`);
				try {
					onMessage(JSON.parse(line) as JsonObject);
				} catch (err) {
					log(`bad json from client: ${(err as Error).message}`);
				}
			}
			nl = buffer.indexOf("\n");
		}
	});
	return {
		send(message) {
			const line = JSON.stringify(message);
			if (LOG_FILE) log(`>> ${line}`);
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

const backend = await PiBackend.create({ log, version: "0.1.0" });
new AcpAgent(stdioTransport(), backend, { log });
log(`pi-junie ACP agent started (pid ${process.pid}, cwd ${process.cwd()})`);
process.stdin.on("end", () => {
	log("stdin closed, exiting");
	process.exit(0);
});
