// Tiny structured logger shared by all layers. The sink is decided by the composition root.

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSink = (level: LogLevel, scope: string, message: string) => void;

export interface Logger {
	debug(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
	child(scope: string): Logger;
}

export function createLogger(sink: LogSink, scope = "pi-junie"): Logger {
	return {
		debug: (m) => sink("debug", scope, m),
		info: (m) => sink("info", scope, m),
		warn: (m) => sink("warn", scope, m),
		error: (m) => sink("error", scope, m),
		child: (s) => createLogger(sink, `${scope}:${s}`),
	};
}

export const silentLogger: Logger = createLogger(() => {});

/** Masks secret-looking values in a JSON-ish string (header values, tokens, keys). */
export function redactSecrets(text: string): string {
	return text
		.replace(/("(?:[\w-]*(?:key|token|secret|authorization|password)[\w-]*)"\s*:\s*)"[^"]*"/gi, '$1"<redacted>"')
		.replace(/("name"\s*:\s*"[^"]*(?:KEY|TOKEN|SECRET|PASSWORD)[^"]*"\s*,\s*"value"\s*:\s*)"[^"]*"/g, '$1"<redacted>"');
}
