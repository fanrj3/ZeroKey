import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { clientTemplate } from "../../scripts/project-template.ts";

test("generated client calls both APIs with injected model/session and keeps upstream errors private", async () => {
  const received: any[] = [];
  const server = createServer((request, response) => {
    let data = "";
    request.on("data", (chunk) => (data += chunk));
    request.on("end", () => {
      received.push({
        path: request.url,
        session: request.headers["x-litellm-session-id"],
        auth: request.headers.authorization,
        body: JSON.parse(data),
      });
      if (request.url === "/v1/responses")
        response.end(
          JSON.stringify({
            output: [
              { content: [{ type: "output_text", text: "responses OK" }] },
            ],
          }),
        );
      else if (received.length > 2) {
        response.statusCode = 403;
        response.end("synthetic-private-key-in-error");
      } else
        response.end(
          JSON.stringify({ choices: [{ message: { content: "chat OK" } }] }),
        );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const names = [
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "LLM_API_PROTOCOL",
    "LITELLM_SESSION_ID",
  ];
  const old = names.map((name) => process.env[name]);
  try {
    const address = server.address() as any;
    Object.assign(process.env, {
      OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OPENAI_API_KEY: "synthetic-token",
      OPENAI_MODEL: "source/test",
      LITELLM_SESSION_ID: "same-conversation",
      LLM_API_PROTOCOL: "chat-completions",
    });
    const { generateText } = await import(
      "data:text/javascript;base64," +
        Buffer.from(clientTemplate).toString("base64")
    );
    assert.equal(await generateText("hello"), "chat OK");
    process.env.LLM_API_PROTOCOL = "responses";
    assert.equal(await generateText("hello"), "responses OK");
    assert.equal(received[0].body.messages[0].content, "hello");
    assert.equal(received[1].body.input, "hello");
    assert.ok(
      received.every(
        (item) =>
          item.session === "same-conversation" &&
          item.auth === "Bearer synthetic-token" &&
          item.body.model === "source/test",
      ),
    );
    process.env.LLM_API_PROTOCOL = "chat-completions";
    await assert.rejects(
      generateText("error"),
      (error: any) =>
        /403/.test(error.message) && !error.message.includes("private-key"),
    );
  } finally {
    names.forEach((name, i) => {
      if (old[i] === undefined) delete process.env[name];
      else process.env[name] = old[i];
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
