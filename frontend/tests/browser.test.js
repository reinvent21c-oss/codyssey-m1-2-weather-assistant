// Mock HTTP responses exist only in tests; the shipped UI has no demo-data mode.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

let browser, server, origin;
const root = fileURLToPath(new URL("../", import.meta.url));
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const malicious = '<img src=x onerror="window.XSS_EXECUTED=true">';

before(async () => {
  await mkdir(`${root}test-results`, { recursive: true });
  server = createServer(async (request, response) => {
    const name = new URL(request.url, "http://localhost").pathname.slice(1) || "index.html";
    if (!["index.html", "config.js", "app.js", "api.js", "chart.js", "styles.css"].includes(name)) { response.writeHead(404); response.end(); return; }
    const data = await readFile(`${root}${name}`);
    response.setHeader("Content-Type", name.endsWith("js") ? "application/javascript" : name.endsWith("css") ? "text/css" : "text/html; charset=utf-8"); response.end(data);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

async function fixture({ mobile = false, empty = false, chatError = 0, dataError = 0, observations, dataReadError = 0 } = {}) {
  const context = await browser.newContext({ locale: "ko-KR", viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
  const page = await context.newPage(); const errors = []; const calls = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  const data = observations ?? (empty ? [] : [{ date: "2025-10-02", value: 0, memo: "Mock 관측치" }, { date: "2025-10-01", value: -1, memo: malicious }]);
  const conversations = new Map(empty ? [] : [[firstId, { id: firstId, created_at: "2025-10-01T00:00:00Z", updated_at: "2025-10-02T00:00:00Z", messages: [{ role: "user", content: "이전 테스트 질문" }, { role: "assistant", content: malicious }] }]]);
  await page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => {
    const banner = document.createElement("p"); banner.textContent = "테스트용 Mock 응답 · 실제 데이터 및 AI 답변 아님"; banner.style.cssText = "background:#ffedb8;padding:8px;text-align:center;margin:0"; document.body.prepend(banner);
  }));
  await context.route("**/*", async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    if (url.origin !== "http://127.0.0.1:8000") { errors.push(`Unexpected external request: ${url.origin}`); return route.abort(); }
    const method = request.method(); const path = url.pathname; const body = request.postDataJSON(); calls.push({ method, path, body });
    let result; let status = 200;
    if (path === "/api/data/summary") {
      const ordered = [...data].sort((a, b) => a.date.localeCompare(b.date)); const values = data.map(record => record.value);
      result = { start_date: ordered[0]?.date ?? null, end_date: ordered.at(-1)?.date ?? null, count: data.length, mean_value: data.length ? values.reduce((sum, value) => sum + value, 0) / data.length : null, min_value: data.length ? Math.min(...values) : null, max_value: data.length ? Math.max(...values) : null, trend: { status: "insufficient_data", threshold_celsius: 0.5, latest_week_mean: null, previous_week_mean: null } };
    } else if (path === "/api/conversations" && method === "GET") result = [...conversations.values()].map(record => ({ ...record, messages: undefined, message_count: record.messages.length })).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    else if (path === "/api/conversations" && method === "POST") {
      result = { id: secondId, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", message_count: 0 };
      conversations.set(secondId, { ...result, message_count: undefined, messages: [] }); status = 201;
    } else if (path.startsWith("/api/conversations/")) {
      const id = path.split("/").at(-1); result = conversations.get(id);
      if (method === "DELETE") { conversations.delete(id); result = { id, deleted: true }; }
      if (!result) { status = 404; result = { detail: "INTERNAL_DETAIL" }; }
    } else if (path === "/api/chat") {
      await new Promise(resolve => setTimeout(resolve, 180));
      if (chatError) { status = chatError; result = { detail: "PRIVATE_MODEL_DETAIL" }; }
      else {
        const id = body.conversation_id || secondId;
        if (!conversations.has(id)) conversations.set(id, { id, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", messages: [] });
        result = { conversation_id: id, response: "Mock 테스트 답변: 과거 관측 자료이며 실시간 날씨가 아닙니다." };
        conversations.get(id).messages.push({ role: "user", content: body.question }, { role: "assistant", content: result.response });
      }
    } else if (path === "/api/data" && method === "GET") { status = dataReadError || 200; result = dataReadError ? { detail: "PRIVATE_DETAIL" } : data; }
    else if (path.startsWith("/api/data")) {
      if (dataError) { status = dataError; result = { detail: "PRIVATE_STORAGE_DETAIL" }; }
      else if (method === "POST") { data.push(body); result = body; status = 201; }
      else if (method === "PUT") { const index = data.findIndex(record => record.date === path.split("/").at(-1)); data[index] = body; result = body; }
      else if (method === "DELETE") { const id = path.split("/").at(-1); data.splice(data.findIndex(record => record.date === id), 1); result = { id, deleted: true }; }
    }
    if (result === undefined) throw new Error(`Unhandled mock request: ${method} ${path}`);
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(result), headers: { "Access-Control-Allow-Origin": origin } });
  });
  await page.goto(origin); await page.waitForFunction(() => !document.getElementById("history-status").textContent.includes("불러오는"));
  return { page, context, errors, calls };
}

test("desktop: summary, chat loading and duplicate prevention, history and XSS safety", async () => {
  const { page, context, errors, calls } = await fixture();
  try {
    assert.match(await page.locator("#summary-content").innerText(), /2건/);
    assert.match(await page.locator("#summary-content").innerText(), /-0.5°C/);
    assert.match(await page.locator("#summary-content").innerText(), /판단 불가/);
    await page.locator(".conversation-open").click(); await page.waitForFunction(() => document.querySelectorAll(".message").length === 2);
    assert((await page.locator("#messages").innerText()).includes(malicious));
    assert.equal(await page.locator("#messages img").count(), 0);
    await page.locator("#question").fill("테스트 질문"); await page.locator("#send").click();
    assert.equal(await page.locator("#send").isDisabled(), true);
    assert.equal(await page.locator("#new-conversation").isDisabled(), true);
    await page.evaluate(() => document.getElementById("chat-form").dispatchEvent(new Event("submit", { cancelable: true })));
    await page.waitForFunction(() => document.getElementById("chat-status").textContent.includes("저장되었"));
    assert.equal(calls.filter(call => call.path === "/api/chat").length, 1);
    assert.equal(calls.find(call => call.path === "/api/chat").body.conversation_id, firstId);
    assert.equal(await page.locator(".message").count(), 4);
    assert.equal(await page.evaluate(() => window.XSS_EXECUTED), undefined);
    await mkdir(`${root}test-results`, { recursive: true }); await page.screenshot({ path: `${root}test-results/desktop.png`, fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("mobile: empty states, new conversation, deletion confirmation and layout", async () => {
  const { page, context, errors, calls } = await fixture({ mobile: true, empty: true });
  try {
    assert.match(await page.locator("#summary-content").innerText(), /자료가 없어요/);
    assert.match(await page.locator("#conversation-list").innerText(), /저장된 대화가 없어요/);
    await page.screenshot({ path: `${root}test-results/mobile-chat.png`, fullPage: true });
    await page.locator("#new-conversation").click(); await page.waitForSelector(".conversation-open");
    assert.equal(calls.filter(call => call.method === "POST" && call.path === "/api/conversations").length, 1);
    page.once("dialog", dialog => dialog.dismiss()); await page.locator("#conversation-list .danger").click();
    assert.equal(calls.filter(call => call.method === "DELETE").length, 0);
    page.once("dialog", dialog => dialog.accept()); await page.locator("#conversation-list .danger").click();
    await page.waitForFunction(() => document.getElementById("conversation-list").textContent.includes("저장된 대화가 없어요"));
    await page.locator("#data-tab").click(); await page.waitForFunction(() => document.getElementById("data-list").textContent.includes("데이터가 없어요"));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: `${root}test-results/mobile.png`, fullPage: true }); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("data CRUD uses date IDs and safe memo rendering, refreshes summary", async () => {
  const { page, context, errors, calls } = await fixture();
  try {
    await page.locator("#data-tab").click(); await page.waitForSelector(".data-row");
    assert.equal(await page.locator(".record-top").first().innerText(), "2025-10-01\n-1°C");
    assert.equal(await page.locator("#data-list img").count(), 0);
    assert.deepEqual(await page.locator(".chart-point").evaluateAll(nodes => nodes.map(node => [node.dataset.date, node.dataset.value])), [["2025-10-01", "-1"], ["2025-10-02", "0"]]);
    await page.locator("#record-date").fill("2025-10-03"); await page.locator("#record-value").fill("-2"); await page.locator("#record-memo").fill("Mock 새 자료"); await page.locator("#save-data").click();
    await page.waitForFunction(() => document.querySelectorAll(".data-row").length === 3);
    assert.equal(await page.locator(".chart-point").count(), 3);
    assert.deepEqual(calls.find(call => call.path === "/api/data" && call.method === "POST").body, { date: "2025-10-03", value: -2, memo: "Mock 새 자료" });
    await page.getByRole("button", { name: "2025-10-03 데이터 수정", exact: true }).click(); assert(await page.locator("#record-date").isDisabled());
    await page.locator("#record-value").fill("0"); await page.locator("#save-data").click();
    await page.waitForFunction(() => document.getElementById("data-form-heading").textContent === "새 데이터 추가");
    assert.equal(calls.find(call => call.method === "PUT").path, "/api/data/2025-10-03");
    assert.equal(calls.find(call => call.method === "PUT").body.value, 0);
    await page.waitForSelector('.chart-point[data-date="2025-10-03"][data-value="0"]');
    page.once("dialog", dialog => dialog.dismiss()); await page.getByRole("button", { name: "2025-10-03 데이터 삭제", exact: true }).click();
    assert.equal(calls.filter(call => call.method === "DELETE").length, 0);
    page.once("dialog", dialog => dialog.accept()); await page.getByRole("button", { name: "2025-10-03 데이터 삭제", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".data-row").length === 2);
    assert.equal(await page.locator(".chart-point").count(), 2);
    assert(calls.filter(call => call.path === "/api/data/summary").length >= 4); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("chart shows gaps, safe SVG, single/zero values and readable mobile labels", async () => {
  const { page, context, errors } = await fixture({ mobile: true, observations: [{ date: "2025-10-03", value: 0, memo: malicious }, { date: "2025-10-01", value: -5, memo: malicious }] });
  try {
    await page.locator("#data-tab").click(); await page.waitForSelector(".chart-point");
    assert.equal(await page.locator(".chart-point").count(), 2);
    assert.equal(await page.locator(".chart-line").count(), 0);
    assert.match(await page.locator("#temperature-chart svg desc").textContent(), /누락 날짜/);
    assert.equal(await page.locator("#temperature-chart img, #temperature-chart script").count(), 0);
    assert.equal(await page.evaluate(() => window.XSS_EXECUTED), undefined);
    const dots = await page.locator(".chart-point").evaluateAll(nodes => nodes.map(node => ({ x: +node.getAttribute("cx"), y: +node.getAttribute("cy"), date: node.dataset.date, value: node.dataset.value })));
    assert(dots[0].x < dots[1].x && dots[0].y > dots[1].y);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await page.locator(".chart-label").first().evaluate(node => getComputedStyle(node).fontSize), "14px");
    await page.screenshot({ path: `${root}test-results/chart-mobile.png`, fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForFunction(() => +document.querySelector("#temperature-chart svg").viewBox.baseVal.width > 480);
    await page.screenshot({ path: `${root}test-results/chart-desktop.png`, fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("chart empty and API-error states do not leave stale observation points", async () => {
  for (const options of [{ empty: true }, { dataReadError: 503 }]) {
    const { page, context } = await fixture(options);
    try {
      await page.locator("#data-tab").click();
      await page.waitForFunction(() => !document.getElementById("data-status").textContent.includes("불러오는"));
      assert.equal(await page.locator(".chart-point").count(), 0);
      assert.match(await page.locator("#temperature-chart").innerText(), options.empty ? /데이터가 없어/ : /불러오지 못해/);
      assert(!(await page.locator("body").innerText()).includes("PRIVATE_DETAIL"));
    } finally { await context.close(); }
  }
});

test("chart renders 400 observations and a single zero without fabricated values", async () => {
  for (const observations of [[{ date: "2025-01-01", value: 0, memo: "Mock" }], Array.from({ length: 400 }, (_, index) => ({ date: new Date(Date.UTC(2025, 0, 1) + index * 86400000).toISOString().slice(0, 10), value: index % 30 - 10, memo: "Mock" })).reverse()]) {
    const { page, context, errors } = await fixture({ observations });
    try {
      await page.locator("#data-tab").click(); await page.waitForSelector(".chart-point");
      assert.equal(await page.locator(".chart-point").count(), observations.length);
      assert(!(await page.locator("#temperature-chart svg").getAttribute("viewBox")).includes("NaN"));
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});

test("chat failure preserves input, shows retry guidance and never invents a reply", async () => {
  const { page, context, calls, errors } = await fixture({ chatError: 503, empty: true });
  try {
    await page.locator("#question").fill("보존할 테스트 질문"); await page.locator("#send").click();
    await page.waitForFunction(() => document.getElementById("chat-status").classList.contains("error"));
    assert.equal(await page.locator("#question").inputValue(), "보존할 테스트 질문");
    assert.match(await page.locator("#chat-status").innerText(), /저장소/);
    assert.match(await page.locator("#chat-status").innerText(), /저장 여부/);
    assert.equal(await page.locator(".message").count(), 0);
    assert(!(await page.locator("body").innerText()).includes("PRIVATE_MODEL_DETAIL"));
    assert.equal(calls.filter(call => call.path === "/api/chat").length, 1);
    assert(errors.every(error => error.includes("Failed to load resource") && error.includes("503")));
  } finally { await context.close(); }
});

test("data duplicate shows friendly 409 and retains values", async () => {
  const { page, context, errors } = await fixture({ dataError: 409 });
  try {
    await page.locator("#data-tab").click(); await page.waitForSelector(".data-row");
    await page.locator("#record-date").fill("2025-10-01"); await page.locator("#record-value").fill("0"); await page.locator("#save-data").click();
    await page.waitForFunction(() => document.getElementById("data-status").classList.contains("error"));
    assert.match(await page.locator("#data-status").innerText(), /이미/);
    assert.equal(await page.locator("#record-value").inputValue(), "0");
    assert(!(await page.locator("body").innerText()).includes("PRIVATE_STORAGE_DETAIL"));
    assert(errors.every(error => error.includes("Failed to load resource") && error.includes("409")));
  } finally { await context.close(); }
});

test("new chat uses keyboard submission, receives ID and refreshes conversation state", async () => {
  const { page, context, errors, calls } = await fixture({ empty: true });
  try {
    await page.locator("#question").fill("새 대화 테스트"); await page.locator("#question").press("Control+Enter");
    await page.waitForFunction(() => document.getElementById("chat-status").textContent.includes("저장되었"));
    const request = calls.find(call => call.path === "/api/chat");
    assert.deepEqual(request.body, { question: "새 대화 테스트" });
    assert.match(await page.locator("#conversation-state").innerText(), /이어가고/);
    await page.waitForSelector(".conversation-open"); assert.equal(await page.locator(".message").count(), 2);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
