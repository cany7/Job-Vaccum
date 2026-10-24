import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import type { ApiResult, ConnectionState } from "../shared/api";
import { MAX_LINE_BYTES, PROTOCOL_VERSION, type Method, type Request, type ServiceMessage } from "../shared/protocol";

export interface BackendOptions {
  executable: string;
  args: string[];
  dataDir: string;
  startupMs?: number;
  requestMs?: number;
}
type Pending = { finish: (result: ApiResult<unknown>) => void; timer: NodeJS.Timeout };
const failure = (code: string, message: string): ApiResult<never> =>
  ({ ok: false, error: { code, message, retryable: false } });

/** One owned service, one streaming reader, no automatic restart or replay. */
export class Backend extends EventEmitter {
  state: ConnectionState = { phase: "starting" };
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  private stderr = "";
  private startup: NodeJS.Timeout;
  private closed = false;
  private stopping = false;
  private shutdown?: Promise<void>;

  constructor(private options: BackendOptions) {
    super();
    this.child = spawn(options.executable, [...options.args, "--data-dir", options.dataDir], {
      cwd: options.dataDir, stdio: "pipe", shell: false, detached: true,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    this.startup = setTimeout(() => this.fail("The backend did not become ready within 10 seconds."), options.startupMs ?? 10_000);
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      // Backend stderr contains its own controlled, non-sensitive error messages.
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-8192);
    });
    this.child.stdin.on("error", () => {
      if (!this.stopping) this.fail("The backend input channel closed unexpectedly.");
    });
    this.child.on("error", () => this.fail("Could not launch the local backend. Check the application installation or development environment."));
    // exit fires even if a scrape child still holds inherited stdio open;
    // waiting for close here would leave those children alive indefinitely.
    this.child.once("exit", () => this.killGroup("SIGKILL"));
    this.child.on("close", (code, signal) => {
      this.closed = true;
      clearTimeout(this.startup);
      if (!this.stopping && this.state.phase !== "failed") {
        if (this.state.phase === "starting") {
          this.setState({ phase: "failed", message: this.stderr.trim() || "The backend exited before the ready handshake." });
        } else {
          this.setState({ phase: "exited", exit_code: code, signal, message: "The local backend process ended." });
        }
      }
      this.finishPending("WORKER_EXITED", "The backend connection closed. Quit and reopen Job Vaccum.");
      this.emit("closed");
    });
  }

  private setState(state: ConnectionState) {
    this.state = state;
    this.emit("state", state);
  }

  private fail(message: string) {
    if (this.stopping || this.state.phase === "failed" || this.state.phase === "exited") return;
    clearTimeout(this.startup);
    this.setState({ phase: "failed", message });
    this.finishPending("WORKER_EXITED", message);
    void this.stop();
  }

  private receive(chunk: Buffer) {
    if (this.stopping || this.state.phase === "failed") return;
    try {
      this.buffer += this.decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error("oversized");
        this.message(JSON.parse(line) as ServiceMessage);
        if (this.stopping) return;
      }
      if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES) throw new Error("oversized");
    } catch {
      this.fail("The backend sent an invalid protocol message. Quit and reopen Job Vaccum.");
    }
  }

  private message(message: ServiceMessage) {
    if (this.state.phase === "starting") {
      if (message.type !== "event" || message.name !== "ready" || message.data?.protocol_version !== PROTOCOL_VERSION) {
        this.fail("The backend protocol is incompatible. Expected protocol v1.");
        return;
      }
      clearTimeout(this.startup);
      this.setState({ phase: "ready", ready: message.data });
      return;
    }
    if (message.type === "event") {
      if (!["schedules.updated", "run.updated", "run.stats", "jobs.changed", "cleanup.completed", "operation.completed", "operation.failed", "model.test.completed"].includes(message.name)
        || !Number.isInteger(message.seq) || !message.data) throw new Error("Unexpected event");
      // Let response promises register operation IDs before completion is delivered.
      queueMicrotask(() => this.emit("service-event", message));
      return;
    }
    if (message.type !== "response") throw new Error("Unexpected event");
    if (typeof message.ok !== "boolean") throw new Error("Invalid response");
    if (message.id === null) throw new Error("Unmatched protocol error");
    const pending = this.pending.get(message.id);
    if (!pending) return; // A timed-out read may finish later; it is never replayed.
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    pending.finish(message.ok ? { ok: true, result: message.result } : { ok: false, error: message.error });
  }

  request<T>(method: Method, params: Record<string, unknown> = {}): Promise<ApiResult<T>> {
    if (this.state.phase !== "ready" || this.stopping) {
      return Promise.resolve(failure("WORKER_EXITED", "The backend is not connected."));
    }
    const id = randomUUID();
    const request: Request = { type: "request", id, method, params };
    const encoded = JSON.stringify(request) + "\n";
    if (Buffer.byteLength(encoded) - 1 > MAX_LINE_BYTES) {
      return Promise.resolve(failure("VALIDATION_ERROR", "Message exceeds the 1 MiB limit."));
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(failure("TIMEOUT", "The backend request timed out. Check the connection before trying again."));
      }, this.options.requestMs ?? (method === "app.diagnostics" ? 30_000 : 10_000));
      this.pending.set(id, { timer, finish: (result) => resolve(result as ApiResult<T>) });
      this.child.stdin.write(encoded, "utf8", (error) => {
        if (error) this.fail("Could not send a request to the backend.");
      });
    });
  }

  private finishPending(code: string, message: string) {
    for (const { finish, timer } of this.pending.values()) {
      clearTimeout(timer);
      finish(failure(code, message));
    }
    this.pending.clear();
  }

  private killGroup(signal: NodeJS.Signals) {
    if (this.child.pid) {
      try { process.kill(-this.child.pid, signal); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }

  stop(): Promise<void> {
    this.shutdown ??= this.stopOwnedProcess();
    return this.shutdown;
  }

  private async stopOwnedProcess() {
    this.stopping = true;
    clearTimeout(this.startup);
    this.finishPending("CANCELLED", "Job Vaccum is quitting.");
    if (this.closed) return;
    this.child.stdin.end();
    for (const [waitMs, signal] of [[10_000, "SIGTERM"], [1000, "SIGKILL"], [1000, null]] as const) {
      await new Promise<void>((resolve) => {
        const onClose = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { this.off("closed", onClose); resolve(); }, waitMs);
        this.once("closed", onClose);
      });
      if (this.closed) return;
      if (signal) this.killGroup(signal);
    }
  }
}
