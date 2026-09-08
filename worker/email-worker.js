import PostalMime from "postal-mime";

/**
 * Cloudflare Email Worker + HTTP API — Multi-Domain
 *
 * Hỗ trợ nhận email từ nhiều domain trên cùng 1 Worker.
 * Mỗi email lưu kèm field `domain` (trích từ địa chỉ `to`).
 * API hỗ trợ filter ?domain= và GET /domains để lấy danh sách domain.
 *
 * KV Namespace : EMAIL_STORE
 * Secret       : API_SECRET
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
};

const FIRST_NAMES = [
  "adam", "alex", "alice", "amber", "andrew", "anna", "arthur", "bella",
  "ben", "blake", "brandon", "brian", "carter", "charlie", "chloe",
  "claire", "daisy", "daniel", "david", "dylan", "edward", "ella",
  "emily", "emma", "ethan", "felix", "fiona", "george", "grace",
  "harry", "hazel", "henry", "iris", "isaac", "jack", "james",
  "jason", "julia", "kevin", "laura", "leo", "lily", "lucas",
  "luna", "mason", "mia", "nathan", "nina", "oliver", "oscar",
  "peter", "rachel", "ruby", "sarah", "sofia", "thomas", "victor",
  "violet", "william", "zoe"
];

const LAST_NAMES = [
  "adams", "allen", "baker", "bell", "brooks", "brown", "campbell",
  "carter", "clark", "collins", "cooper", "cox", "diaz", "evans",
  "foster", "garcia", "gray", "green", "hall", "harris", "hayes",
  "hill", "hughes", "jackson", "james", "kelly", "king", "lee",
  "lewis", "martin", "miller", "mitchell", "moore", "morgan", "nelson",
  "parker", "perry", "price", "reed", "rivera", "roberts", "ross",
  "scott", "smith", "stone", "taylor", "thomas", "turner", "walker",
  "ward", "white", "wood", "wright", "young"
];

// ─── Email Handler ────────────────────────────────────────────────────────────

export async function email(message, env, ctx) {
  try {
    const parsedEmail = await PostalMime.parse(message.raw);
    const content = normalizeParsedContent(parsedEmail);

    // Trích domain từ địa chỉ nhận, ví dụ: "inbox@site2.com" → "site2.com"
    const toAddress = normalizeEmail(message.to || "");
    const toDomain = toAddress.split("@")[1] || "unknown";

    const emailData = {
      id:      crypto.randomUUID(),
      from:    message.from,
      to:      toAddress,
      domain:  toDomain,                                        // ← multi-domain
      subject: parsedEmail.subject || "(no subject)",
      date:    new Date().toISOString(),
      body:    content.text,
      html:    content.html,
      read:    false,
    };

    // Lưu email
    await env.EMAIL_STORE.put(`email:${emailData.id}`, JSON.stringify(emailData));

    // Cập nhật global index
    await appendToIndex(env, "index", emailData.id);

    // Cập nhật per-domain index, ví dụ: "index:site2.com"
    await appendToIndex(env, `index:${toDomain}`, emailData.id);

    if (toAddress) await appendToIndex(env, `index:addr:${toAddress}`, emailData.id);

    // Cập nhật danh sách domain đã biết
    const domainsRaw = await env.EMAIL_STORE.get("domains");
    const domains = domainsRaw ? JSON.parse(domainsRaw) : [];
    if (!domains.includes(toDomain)) {
      domains.push(toDomain);
      domains.sort();
      await env.EMAIL_STORE.put("domains", JSON.stringify(domains));
    }

  } catch (err) {
    console.error("Email handler error:", err);
  }
}

async function appendToIndex(env, key, id) {
  const raw = await env.EMAIL_STORE.get(key);
  const index = raw ? JSON.parse(raw) : [];
  index.unshift(id);
  if (index.length > 500) index.splice(500);
  await env.EMAIL_STORE.put(key, JSON.stringify(index));
}

// ─── HTTP API Handler ─────────────────────────────────────────────────────────

export default {
  email,

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Auth: API_SECRET is admin-only; coding keys can call mailbox/email APIs.
    const auth = await authorize(request, env);
    if (!auth) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    if (url.pathname === "/api-keys" && request.method === "GET") {
      if (auth.role !== "admin") return jsonResponse({ error: "Admin access required" }, 403);
      return jsonResponse({ apiKeys: await listApiKeys(env) });
    }

    if (url.pathname === "/api-keys" && request.method === "POST") {
      if (auth.role !== "admin") return jsonResponse({ error: "Admin access required" }, 403);
      let payload = {};
      try { payload = await request.json(); } catch {}
      const apiKey = await createApiKey(env, sanitizeLabel(payload.name));
      return jsonResponse({ apiKey }, 201);
    }

    const apiKeyDelete = url.pathname.match(/^\/api-keys\/([a-f0-9-]+)$/);
    if (apiKeyDelete && request.method === "DELETE") {
      if (auth.role !== "admin") return jsonResponse({ error: "Admin access required" }, 403);
      await deleteApiKey(env, apiKeyDelete[1]);
      return jsonResponse({ success: true });
    }

    // GET /domains — danh sách domain đã nhận email
    if (url.pathname === "/domains" && request.method === "GET") {
      return jsonResponse({ domains: await getDomains(env) });
    }

    // GET /mailboxes — danh sách temp mailbox đã tạo
    if (url.pathname === "/mailboxes" && request.method === "GET") {
      const raw = await env.EMAIL_STORE.get("mailboxes");
      const mailboxes = raw ? JSON.parse(raw) : [];
      const withCounts = await Promise.all(mailboxes.map(async (mailbox) => {
        const indexRaw = await env.EMAIL_STORE.get(`index:addr:${mailbox.address}`);
        return { ...mailbox, messageCount: indexRaw ? JSON.parse(indexRaw).length : 0 };
      }));
      return jsonResponse({ mailboxes: withCounts });
    }

    // POST /mailboxes — tạo temp mailbox dạng name + số ngẫu nhiên
    if (url.pathname === "/mailboxes" && request.method === "POST") {
      let payload = {};
      try { payload = await request.json(); } catch {}

      const requestedLocal = sanitizeLocalPart(payload.local || "");
      const prefix = sanitizeLocalPart(payload.prefix || "");
      const allowedDomains = await getAllowedDomains(env);
      const domain = String(payload.domain || allowedDomains[0] || "hntdev.me").toLowerCase().trim();

      if (!domain) return jsonResponse({ error: "Domain is required" }, 400);
      if (allowedDomains.length && !allowedDomains.includes(domain)) {
        return jsonResponse({ error: "Domain is not allowed" }, 400);
      }

      try {
        const mailbox = await createMailbox(env, { domain, local: requestedLocal, prefix });
        return jsonResponse({ mailbox }, 201);
      } catch (error) {
        return jsonResponse({ error: error.message || "Could not create mailbox" }, 409);
      }
    }

    const mailboxDelete = url.pathname.match(/^\/mailboxes\/(.+)$/);
    if (mailboxDelete && request.method === "DELETE") {
      const address = normalizeEmail(decodeURIComponent(mailboxDelete[1]));
      const mailboxRaw = await env.EMAIL_STORE.get(`mailbox:${address}`);
      if (!mailboxRaw) return jsonResponse({ error: "Mailbox not found" }, 404);

      if (url.searchParams.get("deleteEmails") === "true") {
        await deleteEmailsForAddress(env, address);
      }
      await env.EMAIL_STORE.delete(`mailbox:${address}`);
      await removeMailbox(env, address);
      return jsonResponse({ success: true });
    }

    // GET /emails?domain=site2.com&address=hieu1234@site2.com&page=1&limit=20
    if (url.pathname === "/emails" && request.method === "GET") {
      const domainFilter = url.searchParams.get("domain") || "";
      const addressFilter = normalizeEmail(url.searchParams.get("address") || "");
      const page  = parseInt(url.searchParams.get("page")  || "1");
      const limit = parseInt(url.searchParams.get("limit") || "20");

      // Dùng index riêng nếu có filter domain
      const indexKey = addressFilter ? `index:addr:${addressFilter}` : (domainFilter ? `index:${domainFilter}` : "index");
      const indexRaw = await env.EMAIL_STORE.get(indexKey);
      const index    = indexRaw ? JSON.parse(indexRaw) : [];

      const start   = (page - 1) * limit;
      const pageIds = index.slice(start, start + limit);

      const emails = (await Promise.all(
        pageIds.map(async (id) => {
          const raw = await env.EMAIL_STORE.get(`email:${id}`);
          if (!raw) return null;
          const e = JSON.parse(raw);
          return {
            id:      e.id,
            from:    e.from,
            to:      e.to,
            domain:  e.domain,
            subject: e.subject,
            date:    e.date,
            read:    e.read,
            preview: (e.body || "").slice(0, 100),
          };
        })
      )).filter(Boolean);

      return jsonResponse({ total: index.length, page, limit, domain: domainFilter, address: addressFilter, emails });
    }

    if (url.pathname === "/emails" && request.method === "DELETE") {
      const address = normalizeEmail(url.searchParams.get("address") || "");
      if (!address) return jsonResponse({ error: "Address is required" }, 400);
      const deleted = await deleteEmailsForAddress(env, address);
      return jsonResponse({ success: true, deleted });
    }

    // GET /emails/:id
    const matchGet = url.pathname.match(/^\/emails\/([a-f0-9-]+)$/);
    if (matchGet && request.method === "GET") {
      const id  = matchGet[1];
      const raw = await env.EMAIL_STORE.get(`email:${id}`);
      if (!raw) return jsonResponse({ error: "Not found" }, 404);
      const emailData = JSON.parse(raw);
      await repairLegacyMimeContent(emailData);
      emailData.read = true;
      await env.EMAIL_STORE.put(`email:${id}`, JSON.stringify(emailData));
      return jsonResponse(emailData);
    }

    // DELETE /emails/:id
    const matchDel = url.pathname.match(/^\/emails\/([a-f0-9-]+)$/);
    if (matchDel && request.method === "DELETE") {
      const id = matchDel[1];

      // Lấy domain của email trước khi xoá
      const raw = await env.EMAIL_STORE.get(`email:${id}`);
      const deletedEmail = raw ? JSON.parse(raw) : null;
      const domain = deletedEmail?.domain || null;
      const toAddress = normalizeEmail(deletedEmail?.to || "");

      await env.EMAIL_STORE.delete(`email:${id}`);
      await removeFromIndex(env, "index", id);
      if (domain) await removeFromIndex(env, `index:${domain}`, id);
      if (toAddress) await removeFromIndex(env, `index:addr:${toAddress}`, id);

      return jsonResponse({ success: true });
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};

async function removeFromIndex(env, key, id) {
  const raw = await env.EMAIL_STORE.get(key);
  if (!raw) return;
  const updated = JSON.parse(raw).filter((i) => i !== id);
  await env.EMAIL_STORE.put(key, JSON.stringify(updated));
}

async function deleteEmailsForAddress(env, address) {
  const indexKey = `index:addr:${address}`;
  const indexRaw = await env.EMAIL_STORE.get(indexKey);
  const ids = indexRaw ? JSON.parse(indexRaw) : [];

  for (const id of ids) {
    const raw = await env.EMAIL_STORE.get(`email:${id}`);
    const emailData = raw ? JSON.parse(raw) : null;
    await env.EMAIL_STORE.delete(`email:${id}`);
    await removeFromIndex(env, "index", id);
    if (emailData?.domain) await removeFromIndex(env, `index:${emailData.domain}`, id);
  }
  await env.EMAIL_STORE.delete(indexKey);
  return ids.length;
}

async function removeMailbox(env, address) {
  const raw = await env.EMAIL_STORE.get("mailboxes");
  if (!raw) return;
  const mailboxes = JSON.parse(raw).filter((mailbox) => mailbox.address !== address);
  await env.EMAIL_STORE.put("mailboxes", JSON.stringify(mailboxes));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getDomains(env) {
  const raw = await env.EMAIL_STORE.get("domains");
  const seenDomains = raw ? JSON.parse(raw) : [];
  const allowedDomains = await getAllowedDomains(env);
  return Array.from(new Set([...allowedDomains, ...seenDomains])).sort();
}

async function getAllowedDomains(env) {
  return String(env.ALLOWED_DOMAINS || "")
    .split(",")
    .map((domain) => domain.toLowerCase().trim())
    .filter(Boolean);
}

async function authorize(request, env) {
  const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const headerKey = (request.headers.get("X-API-Key") || "").trim();
  const candidates = Array.from(new Set([bearer, headerKey].filter(Boolean)));

  for (const candidate of candidates) {
    if (env.API_SECRET && candidate === env.API_SECRET) return { role: "admin", type: "secret" };
    if (env.CODING_API_KEY && candidate === env.CODING_API_KEY) return { role: "api", type: "static" };
    const hash = await sha256(candidate);
    const stored = await env.EMAIL_STORE.get(`api-key:${hash}`);
    if (stored) return { role: "api", type: "managed", apiKey: JSON.parse(stored) };
  }
  return null;
}

async function createApiKey(env, name) {
  const id = crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const secret = `tm_live_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const record = { id, name: name || "Coding key", createdAt: new Date().toISOString() };
  await env.EMAIL_STORE.put(`api-key:${await sha256(secret)}`, JSON.stringify(record));

  const raw = await env.EMAIL_STORE.get("api-keys");
  const apiKeys = raw ? JSON.parse(raw) : [];
  apiKeys.unshift({ ...record, hash: await sha256(secret) });
  await env.EMAIL_STORE.put("api-keys", JSON.stringify(apiKeys.slice(0, 100)));
  return { ...record, key: secret };
}

async function listApiKeys(env) {
  const raw = await env.EMAIL_STORE.get("api-keys");
  return (raw ? JSON.parse(raw) : []).map(({ hash, ...record }) => record);
}

async function deleteApiKey(env, id) {
  const raw = await env.EMAIL_STORE.get("api-keys");
  const apiKeys = raw ? JSON.parse(raw) : [];
  const target = apiKeys.find((item) => item.id === id);
  if (target?.hash) await env.EMAIL_STORE.delete(`api-key:${target.hash}`);
  await env.EMAIL_STORE.put("api-keys", JSON.stringify(apiKeys.filter((item) => item.id !== id)));
}

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sanitizeLabel(value) {
  return String(value || "").trim().replace(/[<>]/g, "").slice(0, 60);
}

async function createMailbox(env, options) {
  const domain = options.domain;
  const exactLocal = sanitizeLocalPart(options.local || "");
  for (let attempt = 0; attempt < 12; attempt++) {
    const local = exactLocal || buildRandomLocalPart(options.prefix);
    const address = `${local}@${domain}`;
    const key = `mailbox:${address}`;
    const exists = await env.EMAIL_STORE.get(key);
    if (exists) continue;

    const mailbox = {
      address,
      local: address.split("@")[0],
      domain,
      createdAt: new Date().toISOString(),
    };

    await env.EMAIL_STORE.put(key, JSON.stringify(mailbox));
    await appendMailbox(env, mailbox);
    return mailbox;
  }
  throw new Error("Could not create a unique mailbox");
}

function buildRandomLocalPart(prefix) {
  const firstName = FIRST_NAMES[randomInt(FIRST_NAMES.length)];
  const lastName = LAST_NAMES[randomInt(LAST_NAMES.length)];
  const fullName = `${firstName}${lastName}`;
  const base = sanitizeLocalPart(prefix || fullName) || fullName;
  return `${base}${String(randomInt(10000)).padStart(4, "0")}`;
}

function randomInt(max) {
  return crypto.getRandomValues(new Uint32Array(1))[0] % max;
}

async function appendMailbox(env, mailbox) {
  const raw = await env.EMAIL_STORE.get("mailboxes");
  const mailboxes = raw ? JSON.parse(raw) : [];
  if (!mailboxes.some((item) => item.address === mailbox.address)) {
    mailboxes.unshift(mailbox);
    if (mailboxes.length > 500) mailboxes.splice(500);
    await env.EMAIL_STORE.put("mailboxes", JSON.stringify(mailboxes));
  }
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function sanitizeLocalPart(value) {
  const local = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 24);
  return local;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function normalizeParsedContent(parsedEmail) {
  const html = embedInlineImages(
    String(parsedEmail?.html || ""),
    parsedEmail?.attachments || []
  ).trim().slice(0, 200000);
  const text = String(parsedEmail?.text || stripHtml(html) || "").trim().slice(0, 20000);
  return { text, html };
}

function embedInlineImages(html, attachments) {
  let result = html;
  for (const attachment of attachments) {
    const contentId = String(attachment.contentId || "").replace(/^<|>$/g, "");
    if (!contentId || !String(attachment.mimeType || "").startsWith("image/")) continue;

    try {
      const bytes = attachment.content instanceof Uint8Array
        ? attachment.content
        : new Uint8Array(attachment.content);
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      const escapedId = contentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(
        new RegExp(`cid:${escapedId}`, "gi"),
        `data:${attachment.mimeType};base64,${btoa(binary)}`
      );
    } catch (error) {
      console.warn("Could not embed inline email image:", error);
    }
  }
  return result;
}

async function repairLegacyMimeContent(emailData) {
  if (emailData.html || !emailData.body) return false;

  const match = String(emailData.body).match(/^--([^\r\n]+)\r?\nContent-Type:/i);
  if (!match) return false;

  try {
    const raw = [
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${match[1]}"`,
      "",
      emailData.body,
    ].join("\r\n");
    const parsedEmail = await PostalMime.parse(raw);
    const content = normalizeParsedContent(parsedEmail);
    if (!content.html) return false;
    emailData.body = content.text;
    emailData.html = content.html;
    return true;
  } catch (error) {
    console.warn("Could not repair legacy MIME content:", error);
    return false;
  }
}

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n").trim();
}
