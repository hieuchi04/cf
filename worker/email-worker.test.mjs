import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}

globalThis.Response = class TestResponse {
  constructor(body, options = {}) {
    this.body = body;
    this.status = options.status || 200;
    this.headers = options.headers || {};
  }
  async json() { return JSON.parse(this.body); }
};

const moduleUrl = new URL(`./email-worker.js?test=${Date.now()}`, import.meta.url);
const { default: worker, email: receiveEmail } = await import(moduleUrl);

class MemoryKV {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key) ?? null; }
  async put(key, value) { this.values.set(key, String(value)); }
  async delete(key) { this.values.delete(key); }
}

function createEnv() {
  return {
    EMAIL_STORE: new MemoryKV(),
    API_SECRET: "admin-secret",
    ALLOWED_DOMAINS: "hntdev.me",
  };
}

async function request(env, path, options = {}, key = "admin-secret") {
  const headers = new Map(Object.entries({
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  }).map(([name, value]) => [name.toLowerCase(), value]));
  const requestObject = {
    url: `https://worker.test${path}`,
    method: options.method || "GET",
    headers: { get: (name) => headers.get(name.toLowerCase()) || null },
    json: async () => JSON.parse(options.body || "{}"),
  };
  const response = await worker.fetch(requestObject, env, {});
  return { status: response.status, body: await response.json() };
}

test("creates random and custom hntdev.me mailboxes", async () => {
  const env = createEnv();
  const random = await request(env, "/mailboxes", { method: "POST", body: "{}" });
  assert.equal(random.status, 201);
  assert.match(random.body.mailbox.address, /^[a-z]{6,}\d{4}@hntdev\.me$/);

  const custom = await request(env, "/mailboxes", {
    method: "POST",
    body: JSON.stringify({ local: "hieu.dev", domain: "hntdev.me" }),
  });
  assert.equal(custom.status, 201);
  assert.equal(custom.body.mailbox.address, "hieu.dev@hntdev.me");

  const list = await request(env, "/mailboxes");
  assert.equal(list.body.mailboxes.length, 2);
  assert.equal(list.body.mailboxes[0].messageCount, 0);
});

test("creates, uses, and revokes a coding API key", async () => {
  const env = createEnv();
  const created = await request(env, "/api-keys", {
    method: "POST",
    body: JSON.stringify({ name: "Test client" }),
  });
  assert.equal(created.status, 201);
  assert.match(created.body.apiKey.key, /^tm_live_[a-f0-9]{48}$/);

  const codingKey = created.body.apiKey.key;
  const mailbox = await request(env, "/mailboxes", { method: "POST", body: "{}" }, codingKey);
  assert.equal(mailbox.status, 201);

  const forbidden = await request(env, "/api-keys", {}, codingKey);
  assert.equal(forbidden.status, 403);

  const revoked = await request(env, `/api-keys/${created.body.apiKey.id}`, { method: "DELETE" });
  assert.equal(revoked.status, 200);
  const rejected = await request(env, "/mailboxes", {}, codingKey);
  assert.equal(rejected.status, 401);
});

test("deletes a saved mailbox", async () => {
  const env = createEnv();
  const created = await request(env, "/mailboxes", {
    method: "POST",
    body: JSON.stringify({ local: "remove-me" }),
  });
  const address = created.body.mailbox.address;
  const deleted = await request(env, `/mailboxes/${encodeURIComponent(address)}?deleteEmails=true`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  const list = await request(env, "/mailboxes");
  assert.deepEqual(list.body.mailboxes, []);
});

test("preserves HTML content from multipart email", async () => {
  const env = createEnv();
  const encodedSubject = Buffer.from("Mã xác nhận", "utf8").toString("base64");
  const raw = [
    "From: sender@example.com",
    "To: otp@hntdev.me",
    `Subject: =?UTF-8?B?${encodedSubject}?=`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="test-boundary"',
    "",
    "--test-boundary",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    "Your code is 1234",
    "--test-boundary",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    '<html><body><h1>Your code</h1><strong style="color:red">1234</strong></body></html>',
    "--test-boundary--",
  ].join("\r\n");
  const bytes = new TextEncoder().encode(raw);
  let consumed = false;

  await receiveEmail({
    from: "sender@example.com",
    to: "otp@hntdev.me",
    raw: {
      getReader: () => ({
        read: async () => consumed ? { done: true } : (consumed = true, { done: false, value: bytes }),
      }),
    },
  }, env, {});

  const list = await request(env, "/emails?address=otp%40hntdev.me");
  assert.equal(list.body.total, 1);
  const detail = await request(env, `/emails/${list.body.emails[0].id}`);
  assert.equal(detail.body.subject, "Mã xác nhận");
  assert.equal(detail.body.body, "Your code is 1234");
  assert.match(detail.body.html, /<strong style="color:red">1234<\/strong>/);
});

test("repairs multipart content stored by the legacy parser", async () => {
  const env = createEnv();
  const id = crypto.randomUUID();
  const boundary = "--==_mimepart_github_123";
  const legacyBody = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Your GitHub code is 73685014",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    '<html><body><h1>GitHub</h1><a href=3D"https://github.com">73685014</a></body></html>',
    `--${boundary}--`,
  ].join("\r\n");
  await env.EMAIL_STORE.put(`email:${id}`, JSON.stringify({
    id,
    from: "noreply@github.com",
    to: "otp@hntdev.me",
    domain: "hntdev.me",
    subject: "GitHub code",
    date: new Date().toISOString(),
    body: legacyBody,
    read: false,
  }));

  const detail = await request(env, `/emails/${id}`);
  assert.equal(detail.body.body, "Your GitHub code is 73685014");
  assert.match(detail.body.html, /<h1>GitHub<\/h1>/);
  assert.match(detail.body.html, /href="https:\/\/github\.com"/);
});

test("dashboard has valid JavaScript and unique element IDs", async () => {
  const html = await fs.readFile(new URL("../website/index.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "dashboard script must exist");
  assert.doesNotThrow(() => new Function(script));

  const ids = Array.from(html.matchAll(/id="([^"]+)"/g), (match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "dashboard element IDs must be unique");
});
