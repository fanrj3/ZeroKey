import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

export class TestClient {
  child;
  stderr = "";
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(entry = "scripts/mcp.ts") {
    this.child = spawn(process.execPath, [resolve(entry)], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      let response: any;
      try {
        response = JSON.parse(line);
      } catch {
        for (const p of this.pending.values())
          p.reject(new Error("Non-protocol stdout"));
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.error)
        pending.reject(new Error(JSON.stringify(response.error)));
      else pending.resolve(response.result);
    });
    this.child.on("exit", () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("MCP process exited"));
      }
      this.pending.clear();
    });
  }
  async initialize(version = "2025-11-25") {
    const result = await this.request("initialize", {
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: "zerokey-protocol-test", version: "1.0" },
    });
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );
    return result;
  }
  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("MCP response timeout"));
      }, 60000);
      this.pending.set(id, { resolve: resolveResult, reject, timer });
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }
  call(name: string, args: Record<string, unknown> = {}) {
    return this.request("tools/call", { name, arguments: args });
  }
  async close() {
    this.child.stdin.end();
    await new Promise<void>((done) => {
      if (this.child.exitCode !== null) {
        done();
        return;
      }
      const timer = setTimeout(() => {
        this.child.kill();
        done();
      }, 2000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        done();
      });
    });
  }
}
