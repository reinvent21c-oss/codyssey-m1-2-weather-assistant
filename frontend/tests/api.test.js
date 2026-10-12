import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, createApi, errorMessage, validRecord } from "../api.js";

test("all ten endpoint methods and payloads match the backend", async () => {
  const requests = [];
  const api = createApi("http://localhost:8000/", async (url, options) => {
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
});

test("existing conversation ID is included and IDs are URL encoded", async () => {
  const requests = [];
  const api = createApi("https://example.invalid", async (url, options) => { requests.push({ url, ...options }); return { ok: true, json: async () => ({}) }; });
  await api.chat("q", "existing"); await api.conversation("a/b?");
  assert.deepEqual(JSON.parse(requests[0].body), { question: "q", conversation_id: "existing" });
  assert.equal(requests[1].url, "https://example.invalid/api/conversations/a%2Fb%3F");
});

test("HTTP errors hide backend detail and give friendly guidance", async () => {
  for (const status of [404, 409, 422, 502, 503, 504]) {
    const api = createApi("http://localhost:8000", async () => ({ ok: false, status, json: () => { throw new Error("PRIVATE_DETAIL"); } }));
    await assert.rejects(api.data(), error => error instanceof ApiError && !errorMessage(error).includes("PRIVATE_DETAIL"));
  }
  assert.match(errorMessage(new ApiError(409, "")), /이미/);
  assert.match(errorMessage(new ApiError(404, ""), "chat"), /대화/);
});

test("network and malformed responses are safe errors", async () => {
  const offline = createApi("http://localhost:8000", async () => { throw new Error("PRIVATE_DETAIL"); });
  await assert.rejects(offline.summary(), error => error.status === 0 && !error.message.includes("PRIVATE_DETAIL"));
  const malformed = createApi("http://localhost:8000", async () => ({ ok: true, json: async () => { throw new Error(); } }));
  await assert.rejects(malformed.summary(), error => /응답 형식/.test(error.message));
});

test("date and finite temperature validation allows zero and negatives", () => {
  assert(validRecord("2024-02-29", "0", "")); assert(validRecord("2025-10-01", "-9.7", "메모"));
  for (const [date, value] of [["2025-02-29", "1"], ["2025-02-30", "1"], ["0000-01-01", "1"], ["2025-1-01", "1"], ["2025-10-01", ""], ["2025-10-01", "Infinity"], ["2025-10-01", "NaN"]]) assert.equal(validRecord(date, value, ""), false);
});

test("public API configuration rejects credentials and unsafe schemes", () => {
  for (const url of ["javascript:alert(1)", "https://user:secret@example.com", "https://example.com?key=secret"]) assert.throws(() => createApi(url));
});
