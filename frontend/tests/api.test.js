import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ApiError, createApi, errorMessage, validRecord } from "../api.js";

const TEST_CODE = "TEST_ONLY_EVALUATION_CODE";
const authenticatedApi = (url, fetcher) => createApi(url, fetcher, () => TEST_CODE);

test("public config selects the API origin by exact page hostname", async () => {
  const source = readFileSync(new URL("../config.js", import.meta.url), "utf8");
  for (const [pageUrl, expected] of [
    ["http://localhost:5173", "http://127.0.0.1:8000"],
    ["http://127.0.0.1:5173", "http://127.0.0.1:8000"],
    ["https://bree.vercel.app", "https://codyssey-m1-2-weather-assistant.onrender.com"],
    ["https://bree-preview.vercel.app", "https://codyssey-m1-2-weather-assistant.onrender.com"],
    ["https://localhost.example.com", "https://codyssey-m1-2-weather-assistant.onrender.com"],
  ]) {
    const window = { location: new URL(pageUrl) };
    runInNewContext(source, { window });
    assert.equal(window.APP_CONFIG.API_BASE_URL, expected);
    assert(Object.isFrozen(window.APP_CONFIG));
    const api = authenticatedApi(window.APP_CONFIG.API_BASE_URL, async url => {
      assert.equal(url, `${expected}/api/access`);
      return { ok: true, json: async () => ({ authenticated: true }) };
    });
    await api.access();
  }
});

test("all ten endpoint methods and payloads match the backend", async () => {
  const requests = [];
  const api = authenticatedApi("http://localhost:8000/", async (url, options) => {
    requests.push({ path: new URL(url).pathname, ...options });
    return { ok: true, json: async () => ({}) };
  });
  const record = { date: "2025-10-01", value: -1, memo: "" };
  await api.chat("질문"); await api.createConversation(); await api.conversations();
  await api.conversation("id"); await api.deleteConversation("id");
  await api.addData(record); await api.data(); await api.updateData(record.date, record);
  await api.deleteData(record.date); await api.summary();
  assert.deepEqual(requests.map(request => [request.method, request.path]), [
    ["POST", "/api/chat"], ["POST", "/api/conversations"], ["GET", "/api/conversations"],
    ["GET", "/api/conversations/id"], ["DELETE", "/api/conversations/id"],
    ["POST", "/api/data"], ["GET", "/api/data"], ["PUT", "/api/data/2025-10-01"],
    ["DELETE", "/api/data/2025-10-01"], ["GET", "/api/data/summary"],
  ]);
  assert.deepEqual(JSON.parse(requests[0].body), { question: "질문" });
  assert.deepEqual(JSON.parse(requests[5].body), record);
  assert(requests.every(request => request.credentials === "omit"));
  assert(requests.every(request => request.headers["X-Evaluation-Code"] === TEST_CODE && request.redirect === "error"));
  assert(requests.every(request => !request.path.includes(TEST_CODE) && !request.body?.includes(TEST_CODE)));
});

test("existing conversation ID is included and IDs are URL encoded", async () => {
  const requests = [];
  const api = authenticatedApi("https://example.invalid", async (url, options) => { requests.push({ url, ...options }); return { ok: true, json: async () => ({}) }; });
  await api.chat("q", "existing"); await api.conversation("a/b?");
  assert.deepEqual(JSON.parse(requests[0].body), { question: "q", conversation_id: "existing" });
  assert.equal(requests[1].url, "https://example.invalid/api/conversations/a%2Fb%3F");
});

test("HTTP errors hide backend detail and give friendly guidance", async () => {
  for (const status of [403, 404, 409, 422, 429, 502, 503, 504]) {
    const api = authenticatedApi("http://localhost:8000", async () => ({ ok: false, status, json: () => { throw new Error("PRIVATE_DETAIL"); } }));
    await assert.rejects(api.data(), error => error instanceof ApiError && !errorMessage(error).includes("PRIVATE_DETAIL"));
  }
  assert.match(errorMessage(new ApiError(409, "")), /이미/);
  assert.match(errorMessage(new ApiError(404, ""), "chat"), /대화/);
  assert.match(errorMessage(new ApiError(403, "")), /관리자/);
  assert.match(errorMessage(new ApiError(429, "")), /요청 한도/);
});

test("network and malformed responses are safe errors", async () => {
  const offline = authenticatedApi("http://localhost:8000", async () => { throw new Error("PRIVATE_DETAIL"); });
  await assert.rejects(offline.summary(), error => error.status === 0 && !error.message.includes("PRIVATE_DETAIL"));
  const malformed = authenticatedApi("http://localhost:8000", async () => ({ ok: true, json: async () => { throw new Error(); } }));
  await assert.rejects(malformed.summary(), error => /응답 형식/.test(error.message));
});

test("no code blocks fetch; authentication check only passes code as a header", async () => {
  let fetched = false;
  const noCode = createApi("http://localhost:8000", async () => { fetched = true; });
  await assert.rejects(noCode.access(), error => error.status === 401);
  assert.equal(fetched, false);
  const api = authenticatedApi("http://localhost:8000", async (url, options) => {
    assert.equal(url, "http://localhost:8000/api/access");
    assert.equal(options.headers["X-Evaluation-Code"], TEST_CODE);
    return { ok: true, json: async () => ({ authenticated: true }) };
  });
  assert.deepEqual(await api.access(), { authenticated: true });
});

test("date and finite temperature validation allows zero and negatives", () => {
  assert(validRecord("2024-02-29", "0", "")); assert(validRecord("2025-10-01", "-9.7", "메모"));
  for (const [date, value] of [["2025-02-29", "1"], ["2025-02-30", "1"], ["0000-01-01", "1"], ["2025-1-01", "1"], ["2025-10-01", ""], ["2025-10-01", "Infinity"], ["2025-10-01", "NaN"]]) assert.equal(validRecord(date, value, ""), false);
});

test("public API configuration rejects credentials and unsafe schemes", () => {
  for (const url of ["javascript:alert(1)", "https://user:secret@example.com", "https://example.com?key=secret"]) assert.throws(() => createApi(url));
});

 test("outing recommendation uses authenticated encoded time and never client weather values", async () => {
  let called;
  const api = authenticatedApi("https://example.invalid", async (url, options) => {
    called = { url, options }; return { ok: true, json: async () => ({ status: "unavailable" }) };
  });
  await api.outing("10:30");
  assert.equal(called.url, "https://example.invalid/api/outing-recommendation?time=10%3A30");
  assert.equal(called.options.headers["X-Evaluation-Code"], TEST_CODE);
  assert.equal(called.options.method, "GET");
  assert.equal(called.options.body, undefined);
});

test("chat forwards only the selected aware timestamp, not weather measurements", async () => {
  let sent;
  const api = authenticatedApi("https://example.invalid", async (url, options) => {
    sent = JSON.parse(options.body); return { ok: true, json: async () => ({}) };
  });
  await api.chat("외출 준비", null, "2026-10-15T11:00:00+09:00");
  assert.deepEqual(sent, { question: "외출 준비", outing_at: "2026-10-15T11:00:00+09:00" });
});
