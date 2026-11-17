#!/usr/bin/env node
import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import { createServer } from "./mcp-server.ts";
import { callBroker } from "./broker-client.ts";

class ObservedTransport extends StdioServerTransport {
  private client = "unknown";
  private toolsAvailable = false;
  private listRequests = new Set<string | number>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private record(closed = false) {
    void callBroker("mcp-session", {
      pid: process.pid,
      client: this.client,
      toolsAvailable: this.toolsAvailable,
      closed,
    }).catch(() => {});
  }
  override async start() {
    const receive = this.onmessage;
    this.onmessage = (message) => {
      if ("method" in message) {
        if (message.method === "initialize")
          this.client = String(
            (message.params as any)?.clientInfo?.name ?? "unknown",
          );
        if (message.method === "notifications/initialized") {
          this.record();
          this.heartbeat = setInterval(() => this.record(), 20000);
          this.heartbeat.unref();
        }
        if (message.method === "tools/list" && "id" in message)
          this.listRequests.add(message.id);
      }
      receive?.(message);
    };
    return super.start();
  }
  override async send(message: Parameters<StdioServerTransport["send"]>[0]) {
    await super.send(message);
    if (
      "id" in message &&
      message.id !== undefined &&
      this.listRequests.delete(message.id) &&
      "result" in message
    ) {
      this.toolsAvailable = true;
      this.record();
    }
  }
  override async close() {
    clearInterval(this.heartbeat);
    this.record(true);
    return super.close();
  }
}

// SDK factory negotiates both current and older Agent protocol versions.
const handle = serveStdio(() => createServer(), {
  transport: new ObservedTransport(),
  onerror: () => console.error("ZeroKey MCP: 本机连接异常。"),
});
process.on("SIGINT", () => {
  void handle.close();
});
process.on("SIGTERM", () => {
  void handle.close();
});
