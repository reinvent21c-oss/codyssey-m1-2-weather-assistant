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
const TEST_CODE = "TEST_ONLY_EVALUATION_CODE";

before(async () => {
  await mkdir(`${root}test-results`, { recursive: true });
  server = createServer(async (request, response) => {
    const name = new URL(request.url, "http://localhost").pathname.slice(1) || "index.html";
    if (!["index.html", "config.js", "app.js", "api.js", "chart.js", "outing.js", "styles.css", "theme.css", "assets/bree-welcome.png"].includes(name)) { response.writeHead(404); response.end(); return; }
    const data = await readFile(`${root}${name}`);
    response.setHeader("Content-Type", name.endsWith("png") ? "image/png" : name.endsWith("js") ? "application/javascript" : name.endsWith("css") ? "text/css" : "text/html; charset=utf-8"); response.end(data);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

async function fixture({ weatherDelay = 0, initialView = "chat", weatherUnavailable = false, mobile = false, empty = false, chatError = 0, dataError = 0, observations, dataReadError = 0, authenticate = true, role = "admin", hosted = false } = {}) {
  const pageOrigin = hosted ? "https://bree-test.vercel.app" : origin;
  const apiOrigin = hosted ? "https://codyssey-m1-2-weather-assistant.onrender.com" : "http://127.0.0.1:8000";
  const context = await browser.newContext({ locale: "ko-KR", viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.clock.install({ time: new Date("2026-10-15T10:01:00+09:00") });
  const errors = []; const calls = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  const data = observations ?? (empty ? [] : [{ date: "2025-10-02", value: 0, memo: "Mock 관측치" }, { date: "2025-10-01", value: -1, memo: malicious }]);
  const conversations = new Map(empty ? [] : [[firstId, { id: firstId, created_at: "2025-10-01T00:00:00Z", updated_at: "2025-10-02T00:00:00Z", messages: [{ role: "user", content: "이전 테스트 질문" }, { role: "assistant", content: malicious }] }]]);
  await page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => {
    const banner = document.createElement("p"); banner.textContent = "테스트용 Mock 응답 · 실제 데이터 및 AI 답변 아님"; banner.style.cssText = "background:#ffedb8;padding:8px;text-align:center;margin:0"; document.body.prepend(banner);
  }));
  await context.route("**/*", async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin === pageOrigin) {
      if (!hosted) return route.continue();
      // Serve local assets under a synthetic HTTPS host without contacting Vercel.
      const response = await route.fetch({ url: `${origin}${url.pathname}` });
      return route.fulfill({ response });
    }
    if (url.origin !== apiOrigin) { errors.push(`Unexpected external request: ${url.origin}`); return route.abort(); }
    const method = request.method(); const path = url.pathname; const body = request.postDataJSON(); calls.push({ method, path, body });
    assert(!request.url().includes(TEST_CODE));
    const suppliedCode = request.headers()["x-evaluation-code"];
    if (suppliedCode !== TEST_CODE) {
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ detail: "Evaluation access denied." }), headers: { "Access-Control-Allow-Origin": pageOrigin } });
      return;
    }
    let result; let status = 200;
    if (path === "/api/access") result = { authenticated: true, role };
    else if (path === "/api/outing-recommendation") {
      if (weatherDelay) await new Promise(resolve => setTimeout(resolve, weatherDelay));
      const selected = url.searchParams.get("time");
      const requested = `2026-10-15T${selected}:00+09:00`;
      const forecast = new Date(Date.parse(requested));
      forecast.setUTCMinutes(0); if (!selected.endsWith(":00")) forecast.setTime(forecast.getTime() + 3600000);
      const forecastAt = new Date(forecast.getTime() + 9 * 3600000).toISOString().slice(0, 19) + "+09:00";
      result = weatherUnavailable ? { status: "unavailable", message: "현재 날씨 정보 확인 불가" } : {
        status: "available", location: "서울", timezone: "Asia/Seoul", requested_at: requested,
        forecast_at: forecastAt, offset_minutes: (forecast.getTime() - Date.parse(requested)) / 60000,
        fetched_at: "2026-10-15T10:00:00+09:00", valid_until: "2026-10-15T10:10:00+09:00",
        weather: { temperature_2m: 18, precipitation_probability: 70, precipitation: 1.2, wind_speed_10m: 4 },
        clothing: "가벼운 겉옷", umbrella: "우산을 챙겨요", items: ["방수 가방"], reasons: ["강수확률 70%와 예보 강수량 1.2 mm를 참고했어요."]
      };
    }
    else if (path === "/api/data/summary") {
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
        result = { conversation_id: id, response: body.outing_at ? "Mock 브리 추천: 서울의 선택 시각 예보 기온 18°C와 강수확률 70%를 참고해 가벼운 겉옷과 우산, 방수 가방을 챙겨요. 과거 기온 통계와는 별도 예보예요." : "Mock 테스트 답변: 과거 관측 자료이며 실시간 날씨가 아닙니다." };
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
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(result), headers: { "Access-Control-Allow-Origin": pageOrigin } });
  });
  await page.goto(pageOrigin);
  if (authenticate) {
    await page.locator("#access-code").fill(TEST_CODE); await page.locator("#access-submit").click();
    await page.waitForSelector("#main:not([hidden])");
    if (initialView === "outing") await page.locator(mobile ? "#mobile-outing" : "#outing-tab").click();
    await page.waitForFunction(() => !document.getElementById("history-status").textContent.includes("불러오는"));
  }
  return { page, context, errors, calls };
}

async function openView(page, view) {
  const mobile = page.viewportSize().width <= 760;
  await page.locator(mobile ? `#mobile-${view}` : view === "data" ? "#data-tab" : "#chat-tab").click();
}

test("Vercel hostname uses Render for authentication and data with Mock responses", async () => {
  const { page, context, errors, calls } = await fixture({ hosted: true });
  try {
    assert.equal(await page.evaluate(() => window.APP_CONFIG.API_BASE_URL), "https://codyssey-m1-2-weather-assistant.onrender.com");
    await openView(page, "data");
    await page.waitForFunction(() => document.getElementById("summary-content").textContent.includes("2건"));
    assert(calls.some(call => call.path === "/api/access"));
    assert(calls.some(call => call.path === "/api/data"));
    assert(calls.every(call => !call.path.startsWith("/api/api/")));
    assert.match(await page.locator("#summary-content").innerText(), /2건/);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("desktop: summary, chat loading and duplicate prevention, history and XSS safety", async () => {
  const { page, context, errors, calls } = await fixture();
  try {
    assert.match(await page.locator("#conversation-state").innerText(), /새 질문/);
    assert.match(await page.locator("#reenter-code").innerText(), /관리자/);
    assert.match(await page.locator("#summary-content").innerText(), /2건/);
    assert.match(await page.locator("#summary-content").innerText(), /-0.5°C/);
    assert.match(await page.locator("#summary-content").innerText(), /판단 불가/);
    await page.locator(".conversation-open").click(); await page.waitForFunction(() => document.querySelectorAll(".message").length === 2);
    assert((await page.locator("#messages").innerText()).includes(malicious));
    // Approved local avatars are allowed; injected response markup must stay text.
    assert.equal(await page.locator("#messages img:not(.bree-avatar)").count(), 0);
    assert.deepEqual(await page.locator("#messages img").evaluateAll(images => images.map(image => image.getAttribute("src"))), ["./assets/bree-welcome.png"]);
    await page.locator("#question").fill("테스트 질문"); await page.locator("#send").click();
    assert.equal(await page.locator("#send").isDisabled(), true);
    assert.equal(await page.locator("#new-conversation").isDisabled(), true);
    await page.evaluate(() => document.getElementById("chat-form").dispatchEvent(new Event("submit", { cancelable: true })));
    await page.waitForFunction(() => document.getElementById("chat-status").textContent.includes("저장되었"));
    assert.equal(calls.filter(call => call.path === "/api/chat").length, 1);
    assert.equal(calls.find(call => call.path === "/api/chat").body.conversation_id, firstId);
    assert.equal(await page.locator(".message").count(), 4);
    assert.equal(await page.evaluate(() => window.XSS_EXECUTED), undefined);
    assert(await page.locator(".message").evaluateAll(messages => messages.every(message => message.scrollHeight <= message.clientHeight + 1)));
    await mkdir(`${root}test-results`, { recursive: true }); await page.screenshot({ path: `${root}test-results/desktop.png`, fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("evaluator desktop/mobile: read-only data, no history calls, every question is new", async () => {
  for (const mobile of [false, true]) {
    const { page, context, calls, errors } = await fixture({ role: "evaluator", mobile });
    try {
      assert.equal(await page.locator("#history-panel").isVisible(), false);
      assert.equal(await page.locator("#mobile-history").isVisible(), false);
      assert.equal(await page.locator("#new-conversation").isVisible(), false);
      assert.match(await page.locator("#evaluation-notice").innerText(), /관리자.*개인정보/);
      assert.match(await page.locator("#reenter-code").innerText(), /평가자/);
      for (const question of ["첫 번째 Mock 질문", "두 번째 독립 Mock 질문"]) {
        await page.locator("#question").fill(question); await page.locator("#send").click();
        await page.waitForFunction(() => !document.getElementById("send").disabled);
        assert.equal(await page.locator(".message").count(), 2);
      }
      assert(calls.filter(call => call.path === "/api/chat").every(call => !Object.hasOwn(call.body, "conversation_id")));
      assert.equal(calls.filter(call => call.path === "/api/chat").length, 2);
      assert.equal(calls.filter(call => call.path.startsWith("/api/conversations")).length, 0);
      await openView(page, "data"); await page.waitForSelector(".data-row");
      assert.equal(await page.locator(".data-editor").isVisible(), false);
      assert.equal(await page.locator("#data-list button").count(), 0);
      assert.equal(await page.locator(".chart-point").count(), 2);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.equal(calls.filter(call => call.path.startsWith("/api/data") && call.method !== "GET").length, 0);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});

test("evaluator 403/429: safe guidance, preserves question and never auto-retries", async () => {
  for (const chatError of [403, 429]) {
    const { page, context, calls } = await fixture({ role: "evaluator", chatError });
    try {
      await page.locator("#question").fill("Mock 제한 확인"); await page.locator("#send").click();
      await page.waitForFunction(() => document.getElementById("chat-status").classList.contains("error"));
      assert.match(await page.locator("#chat-status").innerText(), chatError === 403 ? /관리자/ : /요청 한도/);
      assert(!(await page.locator("#chat-status").innerText()).includes("이전 대화 목록"));
      assert.equal(await page.locator("#question").inputValue(), "Mock 제한 확인");
      assert.equal(calls.filter(call => call.path === "/api/chat").length, 1);
      assert.equal(calls.filter(call => call.path.startsWith("/api/conversations")).length, 0);
    } finally { await context.close(); }
  }
});

test("access gate hides features until verified and forgets code on reload", async () => {
  const { page, context, calls } = await fixture({ authenticate: false });
  try {
    assert.equal(await page.locator("#access-code").getAttribute("type"), "password");
    assert.equal(await page.locator("#main").isVisible(), false);
    assert.equal(calls.length, 0);
    await page.locator("#access-code").fill("WRONG_TEST_CODE"); await page.locator("#access-submit").click();
    await page.waitForFunction(() => document.getElementById("access-status").classList.contains("error"));
    assert.match(await page.locator("#access-status").innerText(), /올바르지/);
    assert.equal(await page.locator("#main").isVisible(), false);
    assert.equal(await page.locator("#access-code").inputValue(), "");
    await page.locator("#access-code").fill(TEST_CODE); await page.locator("#access-submit").click();
    await page.waitForSelector("#main:not([hidden])");
    await page.locator(page.viewportSize().width <= 760 ? "#mobile-chat" : "#chat-tab").click();
    assert(!(await page.content()).includes(TEST_CODE));
    assert(!page.url().includes(TEST_CODE));
    assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie })), { local: 0, session: 0, cookies: "" });
    await page.reload(); await page.waitForSelector("#access-panel:not([hidden])");
    assert.equal(await page.locator("#main").isVisible(), false);
    assert.equal(await page.locator("#access-code").inputValue(), "");
  } finally { await context.close(); }
});

test("mobile: empty states, new conversation, deletion confirmation and layout", async () => {
  const { page, context, errors, calls } = await fixture({ mobile: true, empty: true });
  try {
    assert.match(await page.locator("#summary-content").innerText(), /자료가 없어요/);
    assert.match(await page.locator("#conversation-list").innerText(), /저장된 대화가 없어요/);
    await page.screenshot({ path: `${root}test-results/mobile-chat.png`, fullPage: true });
    await page.locator("#new-conversation").click(); await openView(page, "history"); await page.waitForSelector(".conversation-open");
    assert.equal(calls.filter(call => call.method === "POST" && call.path === "/api/conversations").length, 1);
    page.once("dialog", dialog => dialog.dismiss()); await page.locator("#conversation-list .danger").click();
    assert.equal(calls.filter(call => call.method === "DELETE").length, 0);
    page.once("dialog", dialog => dialog.accept()); await page.locator("#conversation-list .danger").click();
    await page.waitForFunction(() => document.getElementById("conversation-list").textContent.includes("저장된 대화가 없어요"));
    await openView(page, "data"); await page.waitForFunction(() => document.getElementById("data-list").textContent.includes("데이터가 없어요"));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: `${root}test-results/mobile.png`, fullPage: true }); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("data CRUD uses date IDs and safe memo rendering, refreshes summary", async () => {
  const { page, context, errors, calls } = await fixture();
  try {
    await openView(page, "data"); await page.waitForSelector(".data-row");
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
    await openView(page, "data"); await page.waitForSelector(".chart-point");
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
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(() => +document.querySelector("#temperature-chart svg").viewBox.baseVal.width > 480);
    await page.screenshot({ path: `${root}test-results/chart-desktop.png`, fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("chart empty and API-error states do not leave stale observation points", async () => {
  for (const options of [{ empty: true }, { dataReadError: 503 }]) {
    const { page, context } = await fixture(options);
    try {
      await openView(page, "data");
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
      await openView(page, "data"); await page.waitForSelector(".chart-point");
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
    await openView(page, "data"); await page.waitForSelector(".data-row");
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
    await page.waitForFunction(() => document.querySelectorAll(".conversation-open").length === 1); assert.equal(await page.locator(".message").count(), 2);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("Bree greeting and suggestions are UI only; history switching keeps server messages", async () => {
  const { page, context, calls, errors } = await fixture();
  try {
    assert.match(await page.locator(".bree-welcome").innerText(), /안녕하세요, 브리예요! 외출 준비, 같이 해볼까요\?/);
    assert(await page.locator(".bree-art-slot").evaluate(image => image.complete && image.naturalWidth > 0));
    assert.equal(await page.locator(".suggestion").count(), 2);
    await page.locator(".past-suggestions summary").click();
    const question = await page.locator(".suggestion").first().innerText();
    await page.locator(".suggestion").first().click();
    assert.equal(await page.locator("#question").inputValue(), question);
    assert.equal(calls.filter(call => call.method === "POST").length, 0);
    await page.locator(".conversation-open").click();
    await page.waitForFunction(() => document.querySelectorAll(".message").length === 2);
    assert.equal(await page.locator(".bree-welcome").count(), 0);
    await page.waitForFunction(() => { const image = document.querySelector(".bree-avatar"); return image?.complete && image.naturalWidth > 0; });
    assert(await page.locator(".bree-avatar").first().evaluate(image => image.complete && image.naturalWidth > 0));
    await page.locator("#new-conversation").click();
    await page.waitForSelector(".bree-welcome");
    assert.equal(await page.locator(".message").count(), 0);
    assert.equal(calls.filter(call => call.path === "/api/chat").length, 0);
    await page.locator("#question").fill("Mock 질문: 과거 자료를 참고할 때 한계는 무엇인가요?");
    await page.locator("#send").click();
    assert(await page.locator("#messages").innerText().then(text => text.includes("브리가 생각하고 있어요")));
    await page.waitForFunction(() => !document.getElementById("send").disabled);
    const body = calls.find(call => call.path === "/api/chat").body;
    assert(!JSON.stringify(body).includes("안녕하세요, 브리예요"));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("360px navigation and short viewport keep controls usable with one chat scroll region", async () => {
  const { page, context, calls, errors } = await fixture({ mobile: true });
  try {
    await page.setViewportSize({ width: 360, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await page.locator("#messages").evaluate(node => getComputedStyle(node).overflowY), "auto");
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).overflowY), "hidden");
    for (const id of ["mobile-chat", "mobile-history", "mobile-data", "reenter-code"]) {
      assert((await page.locator(`#${id}`).boundingBox()).height >= 44);
    }
    await openView(page, "history"); await page.locator(".conversation-open").click();
    await page.waitForFunction(() => document.getElementById("main").dataset.view === "chat");
    await page.setViewportSize({ width: 360, height: 500 });
    await page.locator("#question").focus();
    const composer = await page.locator("#question").boundingBox();
    const nav = await page.locator("#mobile-nav").boundingBox();
    assert(composer.y >= 0 && composer.y + composer.height <= nav.y);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(calls.filter(call => call.path === "/api/chat").length, 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("365 records can be explored by date without modifying graph or data requests", async () => {
  const observations = Array.from({ length: 365 }, (_, index) => ({ date: new Date(Date.UTC(2025, 9, 1) + index * 86400000).toISOString().slice(0, 10), value: index % 30 - 10, memo: "Mock 관측치" })).reverse();
  const { page, context, calls, errors } = await fixture({ observations });
  try {
    await openView(page, "data"); await page.waitForSelector(".chart-point");
    assert.equal(await page.locator(".data-row").count(), 365);
    assert.equal(await page.locator(".chart-point").count(), 365);
    await page.locator("#data-date-filter").fill("2025-10-01");
    assert.equal(await page.locator(".data-row").count(), 1);
    assert.match(await page.locator(".data-row").innerText(), /2025-10-01/);
    assert.equal(await page.locator(".chart-point").count(), 365);
    await page.locator("#clear-date-filter").click();
    assert.equal(await page.locator(".data-row").count(), 365);
    assert.equal(calls.filter(call => call.path === "/api/data" && call.method === "GET").length, 1);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});


test("Bree access, composer and data cards remain usable at desktop and 360px", async () => {
  for (const mobile of [false, true]) {
    const { page, context, calls, errors } = await fixture({ mobile, authenticate: false });
    try {
      if (mobile) await page.setViewportSize({ width: 360, height: 844 });
      await page.waitForFunction(() => {
        const image = document.querySelector(".access-art img");
        return image?.complete && image.naturalWidth > 0;
      });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.equal(calls.length, 0);
      await page.locator("#access-code").fill(TEST_CODE);
      await page.locator("#access-submit").click();
      await page.waitForSelector("#main:not([hidden])");
    await page.locator(page.viewportSize().width <= 760 ? "#mobile-chat" : "#chat-tab").click();
      const field = await page.locator("#question").boundingBox();
      const send = await page.locator("#send").boundingBox();
      assert(field.y >= 0 && field.y + field.height <= page.viewportSize().height);
      assert(send.x >= field.x + field.width - 1 && send.height >= 44);
      if (mobile) assert(send.y + send.height <= (await page.locator("#mobile-nav").boundingBox()).y);
      await openView(page, "data");
      await page.waitForSelector(".chart-point");
      assert.equal(await page.locator(".stat").count(), 4);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const editor = await page.locator(".data-editor").boundingBox();
      const records = await page.locator(".data-records").boundingBox();
      assert(mobile ? records.y >= editor.y + editor.height : records.x >= editor.x + editor.width);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});

for (const mobile of [false, true]) {
  test(`outing: ${mobile ? "mobile" : "desktop"} authenticated Seoul forecast and accessible order`, async () => {
    const { page, context, calls, errors } = await fixture({ mobile, initialView: "outing" });
    try {
      assert.match(await page.locator("#outing-panel").innerText(), /서울/);
      await page.locator("#outing-time").fill("10:30");
      await page.locator("#outing-submit").click();
      await page.waitForFunction(() => document.getElementById("outing-result").textContent.includes("가벼운 겉옷"));
      const text = await page.locator("#outing-result").innerText();
      assert.match(text, /30분/); assert.match(text, /70%/); assert.match(text, /1.2 mm/);
      assert(text.indexOf("예보 시각") < text.indexOf("옷차림"));
      assert(text.indexOf("옷차림") < text.indexOf("우산"));
      assert(text.indexOf("준비물") < text.indexOf("추천 이유"));
      assert.equal(await page.locator('#outing-result a[href="https://open-meteo.com/"]').count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(calls.filter(call => call.path === "/api/outing-recommendation").length, 1);
      await page.screenshot({ path: `${root}test-results/outing-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}
test("outing: unavailable lookup renders no invented recommendation", async () => {
  const { page, context } = await fixture({ mobile: true, weatherUnavailable: true, initialView: "outing" });
  try {
    await page.locator("#outing-time").fill("10:30"); await page.locator("#outing-submit").click();
    await page.waitForFunction(() => document.getElementById("outing-status").textContent.includes("확인 불가"));
    assert.equal(await page.locator("#outing-result").innerText(), "");
    await page.locator("#outing-time").fill("11:30");
    assert.equal(await page.locator("#outing-result").innerText(), "");
  } finally { await context.close(); }
});

test("외출 준비: 확인된 시각만 채팅에 전달하고 시각 변경 시 오래된 결과를 지워요", async () => {
  const { page, context, calls, errors } = await fixture({ mobile: true, initialView: "outing" });
  try {
    await page.locator("#outing-time").fill("10:30"); await page.locator("#outing-submit").click();
    await page.waitForFunction(() => document.getElementById("outing-result").textContent.includes("옷차림"));
    await openView(page, "chat");
    await page.locator("#question").fill("이 외출 시각에 우산이 필요할까요?"); await page.locator("#send").click();
    await page.waitForFunction(() => !document.getElementById("send").disabled);
    assert.equal(calls.find(call => call.path === "/api/chat").body.outing_at, "2026-10-15T10:30:00+09:00");
    await page.locator("#mobile-outing").click();
    await page.locator("#outing-time").fill("11:30");
    assert.equal(await page.locator("#outing-result").innerText(), "");
    await context.route("**/api/outing-recommendation?**", route => route.fulfill({
      status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": new URL(page.url()).origin },
      body: JSON.stringify({ status: "unavailable", message: "현재 날씨 정보 확인 불가" })
    }));
    await page.locator("#outing-submit").click();
    await page.waitForFunction(() => document.getElementById("outing-status").textContent.includes("확인 불가"));
    assert.equal(await page.locator("#outing-result").innerText(), "");
    await openView(page, "chat"); await page.locator("#question").fill("지금 날씨는요?"); await page.locator("#send").click();
    await page.waitForFunction(() => !document.getElementById("send").disabled);
    assert.equal(calls.filter(call => call.path === "/api/chat").at(-1).body.outing_at, undefined);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
for (const responseStatus of [401, 504]) {
  test(`외출 준비: HTTP ${responseStatus}에서 추천을 추측하지 않고 한국어로 안내해요`, async () => {
    const { page, context } = await fixture({ mobile: true, initialView: "outing", role: "evaluator" });
    try {
      await context.route("**/api/outing-recommendation?**", route => route.fulfill({
        status: responseStatus, contentType: "application/json", headers: { "Access-Control-Allow-Origin": new URL(page.url()).origin },
        body: JSON.stringify({ detail: "PRIVATE_SENTINEL" })
      }));
      await page.locator("#outing-time").fill("10:30"); await page.locator("#outing-submit").click();
      await page.waitForFunction(() => !document.getElementById("outing-submit").disabled);
      assert.match(await page.locator("#outing-status").innerText(), responseStatus === 401 ? /접근 코드/ : /확인 불가/);
      assert.equal(await page.locator("#outing-result").innerText(), "");
      assert(!(await page.locator("#outing-status").innerText()).includes("PRIVATE_SENTINEL"));
    } finally { await context.close(); }
  });
}
test("외출 준비: 강수 예측이 0이어도 맑음을 단정하지 않아요", async () => {
  const { page, context } = await fixture({ initialView: "outing", role: "evaluator", mobile: true });
  try {
    await context.route("**/api/outing-recommendation?**", route => route.fulfill({
      status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": new URL(page.url()).origin },
      body: JSON.stringify({ status: "available", requested_at: "2026-10-15T10:30:00+09:00", forecast_at: "2026-10-15T11:00:00+09:00", offset_minutes: 30,
        fetched_at: "2026-10-15T10:00:00+09:00", weather: { temperature_2m: 0, precipitation_probability: 0, precipitation: 0, wind_speed_10m: 0 },
        clothing: "두꺼운 외투", umbrella: "강수 가능성은 낮아요. 이후 변화를 다시 확인해요.", items: ["목도리"], reasons: ["예보 기온을 참고했어요."] })
    }));
    await page.locator("#outing-time").fill("10:30"); await page.locator("#outing-submit").click();
    await page.waitForFunction(() => document.getElementById("outing-result").textContent.includes("두꺼운 외투"));
    const text = await page.locator("#outing-result").innerText();
    assert.match(text, /0°C/); assert.match(text, /0%/); assert.match(text, /0 mm/); assert(!text.includes("맑"));
    await page.locator("#outing-result h2").last().scrollIntoViewIfNeeded();
    assert(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight));
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).overflowY === "hidden"), false);
  } finally { await context.close(); }
});

test("외출 준비: 잘못된 성공 응답의 결측 필드도 추천으로 표시하지 않아요", async () => {
  const { page, context } = await fixture({ initialView: "outing", mobile: true });
  try {
    await context.route("**/api/outing-recommendation?**", route => route.fulfill({
      status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": new URL(page.url()).origin },
      body: JSON.stringify({ status: "available", weather: { temperature_2m: 18, precipitation_probability: null, precipitation: 0, wind_speed_10m: 4 },
        clothing: "보이면 안 되는 추천", umbrella: "보이면 안 되는 추천", items: [], reasons: [] })
    }));
    await page.locator("#outing-time").fill("10:30"); await page.locator("#outing-submit").click();
    await page.waitForFunction(() => document.getElementById("outing-status").textContent.includes("필수 값을 확인"));
    assert.equal(await page.locator("#outing-result").innerText(), "");
  } finally { await context.close(); }
});

for (const width of [1440, 390, 360]) {
  for (const role of ["admin", "evaluator"]) {
    test(`B-1 대화 흐름: ${width}px ${role}, 날씨와 AI 요청 분리 및 후속 질문`, async () => {
      const { page, context, calls, errors } = await fixture({ mobile: width < 760, role });
      try {
        await page.setViewportSize({ width, height: width < 760 ? 844 : 1000 });
        assert.equal(await page.locator("#main").getAttribute("data-view"), "chat");
        assert.match(await page.locator(".bree-welcome").innerText(), /오늘 몇 시에 외출/);
        assert.equal(calls.filter(call => call.path === "/api/chat").length, 0);
        assert.equal(calls.filter(call => call.method !== "GET").length, 0);
        assert(await page.locator("#recommend-outing").isDisabled());
        if (role === "evaluator") await page.screenshot({ path: `${root}test-results/b1-${width}-initial.png`, fullPage: true });
        await page.locator("#chat-outing-time").fill("10:30");
        await page.locator("#chat-outing-submit").click();
        await page.waitForFunction(() => !document.getElementById("recommend-outing").disabled);
        assert.equal(calls.filter(call => call.path === "/api/outing-recommendation").length, 1);
        assert.equal(calls.filter(call => call.method !== "GET").length, 0);
        const summary = await page.locator("#chat-outing-result").innerText();
        assert.match(summary, /18°C/); assert.match(summary, /70%/); assert.match(summary, /4 m\/s/); assert.match(summary, /30분/);
        await page.locator("#recommend-outing").scrollIntoViewIfNeeded();
        if (role === "evaluator") await page.screenshot({ path: `${root}test-results/b1-${width}-weather.png`, fullPage: true });
        await page.locator("#recommend-outing").click();
        await page.evaluate(() => document.getElementById("recommend-outing").dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
        await page.waitForFunction(() => !document.getElementById("send").disabled);
        const aiCalls = calls.filter(call => call.path === "/api/chat");
        assert.equal(aiCalls.length, 1);
        assert.equal(aiCalls[0].body.outing_at, "2026-10-15T10:30:00+09:00");
        assert.match(aiCalls[0].body.question, /과거/);
        assert.equal(aiCalls[0].body.weather, undefined);
        assert.equal(await page.locator(".message.assistant").count(), 1);
        if (role === "evaluator") await page.screenshot({ path: `${root}test-results/b1-${width}-reply.png`, fullPage: true });
        await page.locator("#question").fill("추가로 챙길 것이 있나요?"); await page.locator("#send").click();
        await page.waitForFunction(() => !document.getElementById("send").disabled);
        const followup = calls.filter(call => call.path === "/api/chat").at(-1);
        assert.equal(followup.body.conversation_id, role === "admin" ? secondId : undefined);
        assert.equal(await page.locator(".message").count(), role === "admin" ? 4 : 2);
        if (role === "evaluator") assert.equal(calls.filter(call => call.path.startsWith("/api/conversations")).length, 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  }
}
test("B-1: 조회 실패·선택 변경·10분 만료는 요약과 추천 자격을 제거해요", async () => {
  const { page, context, calls } = await fixture({ mobile: true, role: "evaluator" });
  try {
    await page.locator("#chat-outing-time").fill("10:30"); await page.locator("#chat-outing-submit").click();
    await page.waitForFunction(() => !document.getElementById("recommend-outing").disabled);
    await page.clock.fastForward(9 * 60000 + 1);
    assert(await page.locator("#recommend-outing").isDisabled());
    assert.equal(await page.locator("#chat-outing-result").innerText(), "");
    assert.match(await page.locator("#recommend-hint").innerText(), /유효기간/);
    assert.equal(calls.filter(call => call.path === "/api/outing-recommendation").length, 1);
    assert.equal(calls.filter(call => call.method !== "GET").length, 0);
  } finally { await context.close(); }
});
test("B-1: 조회 도중 시각 변경 시 늦게 온 응답을 재사용하지 않아요", async () => {
  const { page, context, calls } = await fixture({ mobile: true, weatherDelay: 250 });
  try {
    await page.locator("#chat-outing-time").fill("10:30"); await page.locator("#chat-outing-submit").click();
    await page.locator("#chat-outing-time").fill("11:30");
    await page.waitForFunction(() => !document.getElementById("chat-outing-submit").disabled);
    assert.equal(await page.locator("#chat-outing-result").innerText(), "");
    assert(await page.locator("#recommend-outing").isDisabled());
    assert.equal(calls.filter(call => call.path === "/api/chat").length, 0);
  } finally { await context.close(); }
});
test("B-1: 조회 후 외출 시각이 지난 순간 AI 추천을 무효화해요", async () => {
  const { page, context, calls } = await fixture({ mobile: true });
  try {
    await page.locator("#chat-outing-time").fill("10:02"); await page.locator("#chat-outing-submit").click();
    await page.waitForFunction(() => !document.getElementById("recommend-outing").disabled);
    await page.clock.fastForward(60001);
    assert(await page.locator("#recommend-outing").isDisabled());
    assert.equal(await page.locator("#chat-outing-result").innerText(), "");
    assert.match(await page.locator("#recommend-hint").innerText(), /시각이 지났/);
    assert.equal(calls.filter(call => call.path === "/api/chat").length, 0);
  } finally { await context.close(); }
});
for (const chatError of [429, 502, 503, 412]) {
  test(`B-1: AI 추천 HTTP ${chatError}에서 질문 보존·자동 재요청 금지`, async () => {
    const { page, context, calls } = await fixture({ mobile: true, role: "evaluator", chatError });
    try {
      await page.locator("#chat-outing-time").fill("10:30"); await page.locator("#chat-outing-submit").click();
      await page.waitForFunction(() => !document.getElementById("recommend-outing").disabled);
      await page.locator("#recommend-outing").click();
      await page.waitForFunction(() => !document.getElementById("send").disabled);
      assert.equal(calls.filter(call => call.path === "/api/chat").length, 1);
      assert.match(await page.locator("#question").inputValue(), /선택한 서울/);
      assert.equal(await page.locator(".message.assistant").count(), 0);
      assert.match(await page.locator("#chat-status").innerText(), chatError === 429 ? /한도/ : chatError === 503 ? /저장소/ : chatError === 412 ? /날씨/ : /AI 답변/);
      if (chatError === 412) {
        assert(await page.locator("#recommend-outing").isDisabled());
        assert.equal(await page.locator("#chat-outing-result").innerText(), "");
      }
    } finally { await context.close(); }
  });
}

test("B-1: 날씨 조회 실패 후에는 AI 추천이 비활성화돼요", async () => {
  const { page, context, calls } = await fixture({ mobile: true, role: "evaluator", weatherUnavailable: true });
  try {
    await page.locator("#chat-outing-time").fill("10:30"); await page.locator("#chat-outing-submit").click();
    await page.waitForFunction(() => !document.getElementById("chat-outing-submit").disabled);
    assert.match(await page.locator("#chat-outing-status").innerText(), /확인 불가/);
    assert(await page.locator("#recommend-outing").isDisabled());
    assert.equal(await page.locator("#chat-outing-result").innerText(), "");
    assert.equal(calls.filter(call => call.method !== "GET").length, 0);
  } finally { await context.close(); }
});
