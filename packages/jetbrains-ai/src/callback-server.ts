import { createServer, type ServerResponse } from "node:http";

interface OAuthCallbackServerOptions<T> {
	providerName: string;
	host: string;
	port: number;
	path: string;
	state?: string;
	complete: (code: string) => Promise<T>;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface OAuthCallbackServer<T> {
	redirectUri: string;
	wait(): Promise<T | undefined>;
	close(): void;
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function sendPage(response: ServerResponse, status: number, title: string, message: string): void {
	response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	response.end(
		`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`,
	);
}

export async function startOAuthCallbackServer<T>(
	options: OAuthCallbackServerOptions<T>,
): Promise<OAuthCallbackServer<T>> {
	const { providerName, signal } = options;
	if (signal?.aborted) throw new Error("Login cancelled");

	let resolveWait: (value: T | undefined) => void = () => {};
	let rejectWait: (error: Error) => void = () => {};
	const waitPromise = new Promise<T | undefined>((resolve, reject) => {
		resolveWait = resolve;
		rejectWait = reject;
	});
	waitPromise.catch(() => undefined);

	let claimed = false;
	let settled = false;
	let serverClosed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const finish = (result: { value: T | undefined } | { error: Error }): void => {
		if (settled) return;
		settled = true;
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		if ("error" in result) rejectWait(result.error);
		else resolveWait(result.value);
	};
	const onAbort = () => finish({ error: new Error("Login cancelled") });

	const server = createServer((request, response) => {
		void (async () => {
			const url = new URL(request.url ?? "/", "http://localhost");
			if (request.method !== "GET" || url.pathname !== options.path) {
				sendPage(response, 404, "Callback route not found", "This sign-in callback is not available.");
				return;
			}
			if (options.state !== undefined && url.searchParams.get("state") !== options.state) {
				sendPage(response, 400, "State mismatch", "The authorization response did not match this sign-in.");
				return;
			}
			if (claimed || settled) {
				sendPage(response, 409, "Sign-in already handled", "This sign-in has already been handled.");
				return;
			}
			const error = url.searchParams.get("error");
			if (error) {
				const description = url.searchParams.get("error_description") ?? error;
				sendPage(response, 400, "Authorization failed", description);
				finish({ error: new Error(`${providerName} authorization failed: ${description}`) });
				return;
			}
			const code = url.searchParams.get("code");
			if (!code) {
				sendPage(response, 400, "Missing authorization code", "The authorization response did not include a code.");
				return;
			}
			claimed = true;
			try {
				const value = await options.complete(code);
				sendPage(response, 200, `Signed in to ${providerName}`, "You may now close this page.");
				finish({ value });
			} catch (error) {
				const failure = error instanceof Error ? error : new Error(String(error));
				sendPage(response, 502, `${providerName} sign-in failed`, failure.message);
				finish({ error: failure });
			}
		})();
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("OAuth callback server did not bind to TCP");
	}

	server.on("error", (error) => finish({ error }));
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) onAbort();
	if (!settled && options.timeoutMs !== undefined) {
		timer = setTimeout(() => finish({ error: new Error(`${providerName} sign-in timed out`) }), options.timeoutMs);
	}
	return {
		redirectUri: `http://${options.host.includes(":") ? `[${options.host}]` : options.host}:${address.port}${options.path}`,
		wait: () => waitPromise,
		close: () => {
			finish({ error: new Error("OAuth callback server closed") });
			if (!serverClosed) {
				serverClosed = true;
				server.close();
			}
		},
	};
}