// Minimal JSON-RPC 2.0 peer over a message transport (newline-delimited JSON on stdio in production,
// in-memory in tests). Knows nothing about ACP methods.

export type JsonRpcId = number | string;
export type JsonObject = Record<string, unknown>;

export interface Transport {
	send(message: JsonObject): void;
	onMessage(listener: (message: JsonObject) => void): void;
	onClose(listener: () => void): void;
}

export class RpcError extends Error {
	readonly code: number;
	readonly data?: unknown;
	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.code = code;
		this.data = data;
	}
	static methodNotFound(method: string) {
		return new RpcError(-32601, `Method not found: ${method}`);
	}
	static invalidParams(message: string) {
		return new RpcError(-32602, message);
	}
	static internal(message: string) {
		return new RpcError(-32603, message);
	}
}

export type RequestHandler = (method: string, params: JsonObject) => Promise<unknown>;
export type NotificationHandler = (method: string, params: JsonObject) => void;

export class JsonRpcPeer {
	private nextId = 1;
	private readonly pending = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
	private readonly transport: Transport;
	private readonly onRequest: RequestHandler;
	private readonly onNotification: NotificationHandler;
	private readonly log: (line: string) => void;

	constructor(transport: Transport, onRequest: RequestHandler, onNotification: NotificationHandler, log: (line: string) => void = () => {}) {
		this.transport = transport;
		this.onRequest = onRequest;
		this.onNotification = onNotification;
		this.log = log;
		transport.onMessage((m) => this.dispatch(m));
		transport.onClose(() => {
			for (const p of this.pending.values()) p.reject(new Error("connection closed"));
			this.pending.clear();
		});
	}

	notify(method: string, params: unknown): void {
		this.transport.send({ jsonrpc: "2.0", method, params });
	}

	request<T = unknown>(method: string, params: unknown): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
			this.transport.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	private dispatch(message: JsonObject): void {
		const { id, method } = message;
		const hasId = id !== undefined && id !== null;
		if (typeof method === "string") {
			const params = (message.params ?? {}) as JsonObject;
			if (!hasId) {
				try {
					this.onNotification(method, params);
				} catch (err) {
					this.log(`notification ${method} failed: ${(err as Error).message}`);
				}
				return;
			}
			this.onRequest(method, params).then(
				(result) => this.transport.send({ jsonrpc: "2.0", id, result: result ?? {} }),
				(err: unknown) => {
					const e = err instanceof RpcError ? err : RpcError.internal((err as Error)?.message ?? String(err));
					this.transport.send({ jsonrpc: "2.0", id, error: { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) } });
				},
			);
			return;
		}
		if (hasId) {
			const p = this.pending.get(id as JsonRpcId);
			if (!p) return;
			this.pending.delete(id as JsonRpcId);
			if (message.error) p.reject(message.error);
			else p.resolve(message.result);
		}
	}
}
