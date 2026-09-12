import net from "node:net";

export type JsonObject = Record<string, unknown>;

export interface DapMessage extends JsonObject {
  seq: number;
  type: "request" | "response" | "event";
}

export interface DapResponse extends DapMessage {
  type: "response";
  request_seq: number;
  success: boolean;
  command: string;
  body?: JsonObject;
  message?: string;
}

export interface DapEvent extends DapMessage {
  type: "event";
  event: string;
  body?: JsonObject;
}

interface PendingRequest {
  command: string;
  resolve: (response: DapResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface EventWaiter {
  name?: string;
  predicate?: (event: DapEvent) => boolean;
  resolve: (event: DapEvent) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ConnectOptions {
  host?: string;
  port?: number;
  socketPath?: string;
  timeoutMs?: number;
}

const MAX_DAP_BODY = 16 * 1024 * 1024;

export class DapClient {
  private socket: net.Socket | undefined;
  private buffer = Buffer.alloc(0);
  private nextSequence = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly events: DapEvent[] = [];
  private readonly eventWaiters: EventWaiter[] = [];
  private capabilities: JsonObject | undefined;
  private endpoint: string | undefined;

  get connected(): boolean {
    return this.socket !== undefined && !this.socket.destroyed;
  }

  get status(): JsonObject {
    return {
      connected: this.connected,
      endpoint: this.endpoint ?? null,
      pendingRequests: this.pending.size,
      queuedEvents: this.events.length,
      capabilities: this.capabilities ?? null,
    };
  }

  async connect(options: ConnectOptions = {}): Promise<JsonObject> {
    if (this.connected) {
      throw new Error("Dolphin DAP is already connected");
    }

    const timeoutMs = options.timeoutMs ?? 10_000;
    const socket = new net.Socket();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.endpoint = options.socketPath ?? `${options.host ?? "127.0.0.1"}:${options.port ?? 5678}`;

    socket.on("data", (chunk) => this.onData(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
    socket.on("error", (error) => this.failConnection(error));
    socket.on("close", () => this.failConnection(new Error("Dolphin DAP connection closed")));

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timed out connecting to Dolphin DAP at ${this.endpoint}`));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      if (options.socketPath !== undefined) {
        socket.connect(options.socketPath);
      } else {
        socket.connect(options.port ?? 5678, options.host ?? "127.0.0.1");
      }
    });

    const initialized = this.waitForEvent("initialized", timeoutMs);
    const response = await this.request(
      "initialize",
      { clientID: "dolphin-dap-mcp", adapterID: "dolphin-dap" },
      timeoutMs,
    );
    await initialized;
    this.capabilities = response.body ?? {};
    return this.status;
  }

  async configureLifecycle(
    mode: "attach" | "launch",
    stopOnEntry: boolean,
    timeoutMs = 10_000,
  ): Promise<DapEvent> {
    const stateEvent = this.waitForEvent(undefined, timeoutMs, (event) =>
      event.event === "stopped" || event.event === "continued",
    );
    await this.request(mode, { stopOnEntry }, timeoutMs);
    await this.request("configurationDone", {}, timeoutMs);
    return stateEvent;
  }

  async request(command: string, argumentsValue: JsonObject = {}, timeoutMs = 10_000): Promise<DapResponse> {
    const socket = this.socket;
    if (socket === undefined || socket.destroyed) {
      throw new Error("Dolphin DAP is not connected");
    }

    const seq = this.nextSequence++;
    const message = { seq, type: "request", command, arguments: argumentsValue };
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const frame = Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
      body,
    ]);

    const response = new Promise<DapResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`DAP request ${command} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(seq, { command, resolve, reject, timer });
    });
    socket.write(frame);
    return response;
  }

  waitForEvent(
    name?: string,
    timeoutMs = 10_000,
    predicate?: (event: DapEvent) => boolean,
  ): Promise<DapEvent> {
    const queuedIndex = this.events.findIndex(
      (event) => (name === undefined || event.event === name) && (predicate?.(event) ?? true),
    );
    if (queuedIndex >= 0) {
      return Promise.resolve(this.events.splice(queuedIndex, 1)[0]!);
    }

    return new Promise<DapEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.eventWaiters.indexOf(waiter);
        if (index >= 0) this.eventWaiters.splice(index, 1);
        reject(new Error(`Timed out waiting for DAP event${name === undefined ? "" : ` ${name}`}`));
      }, timeoutMs);
      const waiter: EventWaiter = {
        ...(name === undefined ? {} : { name }),
        ...(predicate === undefined ? {} : { predicate }),
        resolve,
        reject,
        timer,
      };
      this.eventWaiters.push(waiter);
    });
  }

  drainEvents(): DapEvent[] {
    return this.events.splice(0);
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.request("disconnect", {}, 3_000);
    } finally {
      this.close();
    }
  }

  close(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.endpoint = undefined;
    this.capabilities = undefined;
    if (socket !== undefined && !socket.destroyed) socket.destroy();
    this.failPending(new Error("Dolphin DAP disconnected"));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const separator = this.buffer.indexOf("\r\n\r\n");
      if (separator < 0) return;
      const header = this.buffer.subarray(0, separator).toString("ascii");
      const match = /^Content-Length: (\d+)$/.exec(header);
      if (match === null) {
        this.failConnection(new Error(`Invalid DAP header: ${header}`));
        return;
      }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_DAP_BODY) {
        this.failConnection(new Error(`Invalid DAP body length: ${match[1]}`));
        return;
      }
      const bodyStart = separator + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length);
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        this.routeMessage(JSON.parse(body.toString("utf8")) as DapMessage);
      } catch (error) {
        this.failConnection(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  private routeMessage(message: DapMessage): void {
    if (message.type === "response") {
      const response = message as DapResponse;
      const pending = this.pending.get(response.request_seq);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.request_seq);
      if (response.success) {
        pending.resolve(response);
      } else {
        pending.reject(
          new Error(`DAP ${pending.command} failed: ${response.message ?? "unknown error"}`),
        );
      }
      return;
    }
    if (message.type !== "event") return;

    const event = message as DapEvent;
    const waiterIndex = this.eventWaiters.findIndex(
      (waiter) =>
        (waiter.name === undefined || waiter.name === event.event) &&
        (waiter.predicate?.(event) ?? true),
    );
    if (waiterIndex < 0) {
      this.events.push(event);
      return;
    }
    const waiter = this.eventWaiters.splice(waiterIndex, 1)[0]!;
    clearTimeout(waiter.timer);
    waiter.resolve(event);
  }

  private failConnection(error: Error): void {
    if (this.socket === undefined) return;
    this.socket = undefined;
    this.endpoint = undefined;
    this.capabilities = undefined;
    this.failPending(error);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.eventWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.eventWaiters.length = 0;
  }
}
