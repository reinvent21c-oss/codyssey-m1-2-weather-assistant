import test from "node:test";
import assert from "node:assert/strict";
import { weatherAttribution } from "../outing.js";

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

const { outingValidity, OUTING_QUESTION } = await import("../outing.js");
const confirmedWeather = () => ({ status: "available", requested_at: "2026-10-15T11:00:00+09:00", forecast_at: "2026-10-15T11:00:00+09:00", fetched_at: "2026-10-15T10:00:00+09:00", valid_until: "2026-10-15T10:10:00+09:00", weather: { temperature_2m: 18, precipitation_probability: 0, precipitation: 0, wind_speed_10m: 4 } });
test("B-1: 유효한 예보와 고정 추천 질문은 숫자나 위치를 지어내지 않아요", () => {
  assert.equal(outingValidity(confirmedWeather(), Date.parse("2026-10-15T10:01:00+09:00"), "11:00").valid, true);
  assert.equal(OUTING_QUESTION, "오늘 이 시간에 뭘 챙기면 좋을까?");
});
test("B-1: 서버 캐시 만료 및 10분 경계에서 예보를 무효화해요", () => {
  assert.equal(outingValidity(confirmedWeather(), Date.parse("2026-10-15T10:10:00+09:00")).valid, false);
  const result = confirmedWeather(); result.valid_until = "2026-10-15T10:02:00+09:00";
  assert.equal(outingValidity(result, Date.parse("2026-10-15T10:02:00+09:00")).valid, false);
});
test("B-1: 선택 시각 도달과 날짜 변경 및 선택 변경을 거부해요", () => {
  const result = confirmedWeather(); result.requested_at = "2026-10-15T10:01:00+09:00";
  assert.match(outingValidity(result, Date.parse(result.requested_at)).reason, /시각이 지났/);
  assert.equal(outingValidity(confirmedWeather(), Date.parse("2026-10-16T00:00:00+09:00")).valid, false);
  assert.equal(outingValidity(confirmedWeather(), Date.parse("2026-10-15T10:01:00+09:00"), "11:30").valid, false);
});
test("B-1: 실패·결측·유효하지 않은 조회 시각으로 AI 추천을 허용하지 않아요", () => {
  const now = Date.parse("2026-10-15T10:01:00+09:00");
  assert.equal(outingValidity(null, now).valid, false);
  const result = confirmedWeather(); result.weather.precipitation_probability = null;
  assert.equal(outingValidity(result, now).valid, false);
  result.weather.precipitation_probability = 0; result.fetched_at = "invalid";
  assert.equal(outingValidity(result, now).valid, false);
});

const { emphasisTokens } = await import("../emphasis.js");
test("강조: 제목·수치는 볼드, 모델이 추천한 물품만 청록색 대상으로 구분해요", () => {
  const tokens = emphasisTokens("**옷차림**: ***가벼운 겉옷***을 챙겨요. 예보 기온은 **18°C**예요.");
  assert.deepEqual(tokens.filter(token => token.type === "item").map(token => token.text), ["가벼운 겉옷"]);
  assert.deepEqual(tokens.filter(token => token.type === "bold").map(token => token.text), ["옷차림", "18°C"]);
});
test("강조: 일반 물품명·수치·HTML·링크를 자동 강조하거나 해석하지 않아요", () => {
  const plain = '<img src=x onerror="alert(1)"> 우산 목도리 장갑 바람막이 18°C [링크](javascript:alert(1))';
  assert.deepEqual(emphasisTokens(plain), [{ type: "text", text: plain }]);
});
test("강조: 필요하지 않은 물품과 같은 줄의 애매한 추천은 보수적으로 일반 표시해요", () => {
  for (const text of ["***우산***은 필요하지 않아요.", "***장갑***은 필요 없어요.", "***방수 덮개***는 챙기지 마세요.", "***목도리***는 불필요해요."]) {
    assert.equal(emphasisTokens(text).some(token => token.type === "item"), false);
    assert.equal(emphasisTokens(text).some(token => token.type === "bold"), false);
  }
});
test("강조: 닫히지 않은 별표·다른 Markdown·중첩은 일반 문자열로 유지해요", () => {
  for (const text of ["**미완성", "****중첩****", "*기울임*", "# 제목", "`코드`", "**여러\n줄**"]) assert.equal(emphasisTokens(text).map(token => token.text).join(""), text);
});
test("강조: 물품 색상은 최대 네 개이고 줄바꿈과 강조 밖 내용은 보존해요", () => {
  const tokens = emphasisTokens("***첫 물품***\n***둘째 물품***\n***셋째 물품***\n***넷째 물품***\n***다섯째 물품***");
  assert.equal(tokens.filter(token => token.type === "item").length, 4);
  assert.equal(tokens.map(token => token.text).join(""), "첫 물품\n둘째 물품\n셋째 물품\n넷째 물품\n다섯째 물품");
});

test("weather source and licence match only the recognized provider", () => {
  const primary = weatherAttribution({ source: "Open-Meteo", source_url: "https://open-meteo.com/" });
  assert.equal(primary.licence, true);
  assert.match(primary.precipitationNote, /전 1시간/);
  const backup = weatherAttribution({ source: "WeatherAPI.com", source_url: "https://www.weatherapi.com/" });
  assert.equal(backup.licence, false);
  assert.equal(backup.name, "WeatherAPI.com");
  assert(!backup.precipitationNote.includes("전 1시간"));
  for (const result of [
    { source: "WeatherAPI.com", source_url: "javascript:alert(1)" },
    { source: '<img src=x onerror="alert(1)">', source_url: "https://www.weatherapi.com/" },
    { source: "WeatherAPI.com", source_url: "https://open-meteo.com/" }, {},
  ]) assert.throws(() => weatherAttribution(result));
});
