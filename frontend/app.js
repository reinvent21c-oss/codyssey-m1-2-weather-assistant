import { createApi, errorMessage, validRecord } from "./api.js";
import { chartMessage, renderTemperatureChart } from "./chart.js";
import { outingValidity, OUTING_QUESTION } from "./outing.js";

const $ = id => document.getElementById(id);
const state = { conversationId: null, messages: [], records: [], chatBusy: false, historyBusy: false, dataBusy: false, dataLoading: false, editDate: null };
let api;
let evaluationCode = ""; // Memory only; never persist, log, or place in a URL.
let isAdmin = false;
function applyRole(role) {
  isAdmin = role === "admin";
  document.body.dataset.role = isAdmin ? "admin" : "evaluator";
  for (const id of ["history-panel", "mobile-history", "new-conversation", "history-new-conversation"]) $(id).hidden = !isAdmin;
  document.querySelector(".data-editor").hidden = !isAdmin;
  $("evaluation-notice").hidden = isAdmin;
  $("reenter-code").textContent = `${isAdmin ? "관리자" : "평가자"} · 코드 재입력`;
  renderMessages();
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function status(id, text = "", error = false) { $(id).textContent = text; $(id).classList.toggle("error", error); }
function empty(target, title, text) { target.replaceChildren(element("li", undefined, "empty")); target.firstChild.append(element("strong", title), element("span", text)); }
function historyControls() {
  const busy = state.chatBusy || state.historyBusy;
  $("new-conversation").disabled = busy;
  $("history-new-conversation").disabled = busy;
  $("refresh-conversations").disabled = busy;
  $("send").disabled = busy;
  $("question").disabled = busy;
  document.querySelectorAll("#conversation-list button").forEach(button => button.disabled = busy);
  outingControls();
}
function breeImage(className, alt) {
  const image = element("img", undefined, className);
  image.src = "./assets/bree-welcome.png";
  image.alt = alt;
  image.width = 1536; image.height = 1024;
  return image;
}
function renderMessages(pending) {
  const target = $("messages");
  const weatherPanel = $("chat-weather");
  target.replaceChildren();
  const messages = [...state.messages, ...(pending ? [{ role: "user", content: pending }, { role: "assistant", content: "브리가 생각하고 있어요…" }] : [])];
  let pastQuestions;
  if (!messages.length) {
    const intro = element("div", undefined, "bree-welcome");
    intro.append(breeImage("bree-art-slot", "체크리스트를 들고 윙크하는 바람 요정 브리"), element("h2", "안녕하세요, 브리예요!"), element("p", "오늘 몇 시에 외출하나요?"));
    const suggestions = element("div", undefined, "suggestions");
    for (const question of ["자료의 평균·최저·최고 일평균기온이 궁금해요.", "최근 관측 기온의 추세를 알려주세요."]) {
      const button = element("button", question, "suggestion"); button.type = "button";
      button.addEventListener("click", () => { if (!state.chatBusy && !state.historyBusy) { $("question").value = question; $("question").focus(); } });
      suggestions.append(button);
    }
    pastQuestions = element("details", undefined, "past-suggestions");
    pastQuestions.append(element("summary", "과거 기온 질문 살펴보기"), suggestions);
    target.append(intro);
  }
  target.append(weatherPanel);
  if (pastQuestions) target.append(pastQuestions);
  for (const message of messages) {
    const bubble = element("div", undefined, `message ${message.role === "user" ? "user" : "assistant"}`);
    if (message.role === "assistant") {
      const avatar = element("span", undefined, "bree-avatar-frame");
      avatar.setAttribute("aria-hidden", "true");
      avatar.append(breeImage("bree-avatar", ""));
      bubble.append(avatar);
    }
    bubble.append(element("span", message.role === "user" ? "나" : "브리", "message-label"), element("span", message.content)); target.append(bubble);
  }
  $("conversation-state").textContent = !isAdmin ? "매 질문은 별도 저장돼요. 개인정보를 입력하지 마세요." : state.conversationId ? "저장된 대화를 이어가고 있어요." : "새 질문을 보내면 대화가 저장됩니다.";
  target.scrollTop = messages.length ? target.scrollHeight : 0;
}
async function loadHistory() {
  if (!isAdmin) return;
  status("history-status", "대화 목록을 불러오는 중…");
  try {
    const conversations = await api.conversations();
    if (!Array.isArray(conversations)) throw new Error();
    const target = $("conversation-list"); target.replaceChildren();
    if (!conversations.length) empty(target, "저장된 대화가 없어요", "질문을 보내거나 새 대화를 시작해 보세요.");
    for (const conversation of conversations) {
      const row = element("li", undefined, "conversation-item");
      const open = element("button", undefined, "conversation-open"); open.type = "button";
      open.classList.toggle("active", conversation.id === state.conversationId);
      open.append(element("span", `대화 · 메시지 ${conversation.message_count}개`), element("small", formatTime(conversation.updated_at)));
      open.addEventListener("click", () => openConversation(conversation.id));
      const remove = element("button", "삭제", "button danger"); remove.type = "button"; remove.setAttribute("aria-label", `${formatTime(conversation.updated_at)} 대화 삭제`); remove.addEventListener("click", () => deleteConversation(conversation.id));
      row.append(open, remove); target.append(row);
    }
    status("history-status"); historyControls();
  } catch (error) { $("conversation-list").replaceChildren(); status("history-status", errorMessage(error, "chat") + " 새로고침으로 다시 확인해 주세요.", true); }
}
function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "날짜 정보 없음" : new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Seoul" }).format(date);
}
async function openConversation(id) {
  if (!isAdmin) return;
  if (state.chatBusy || state.historyBusy) return;
  state.historyBusy = true; historyControls(); status("chat-status", "대화 내용을 불러오는 중…");
  try {
    const result = await api.conversation(id);
    if (!Array.isArray(result.messages) || result.messages.some(message => !["user", "assistant"].includes(message.role) || typeof message.content !== "string")) throw new Error();
    state.conversationId = result.id; state.messages = result.messages; renderMessages(); status("chat-status");
    showPanel("chat"); await loadHistory();
  } catch (error) { status("chat-status", errorMessage(error, "chat"), true); }
  finally { state.historyBusy = false; historyControls(); }
}
async function deleteConversation(id) {
  if (!isAdmin) return;
  if (state.chatBusy || state.historyBusy || !window.confirm("이 대화를 삭제할까요? 삭제한 메시지는 되돌릴 수 없습니다.")) return;
  state.historyBusy = true; historyControls(); status("history-status", "대화를 삭제하는 중…");
  try {
    await api.deleteConversation(id);
    if (state.conversationId === id) { state.conversationId = null; state.messages = []; renderMessages(); status("chat-status", "대화를 삭제했어요."); }
    await loadHistory();
  } catch (error) { status("history-status", errorMessage(error, "chat"), true); }
  finally { state.historyBusy = false; historyControls(); }
}
async function newConversation() {
  if (!isAdmin) return;
  if (state.chatBusy || state.historyBusy) return;
  state.historyBusy = true; historyControls(); status("chat-status", "새 대화를 만드는 중…");
  try { const result = await api.createConversation(); state.conversationId = result.id; state.messages = []; $("question").value = ""; showPanel("chat"); renderMessages(); status("chat-status", "새 대화를 시작했어요."); await loadHistory(); }
  catch (error) { status("chat-status", errorMessage(error, "chat"), true); }
  finally { state.historyBusy = false; historyControls(); $("question").focus(); }
}
async function sendQuestion(event) {
  event.preventDefault();
  if (state.chatBusy || state.historyBusy) return;
  const question = $("question").value.trim();
  if (!question || [...question].length > 2000) { status("chat-status", "질문을 1~2,000자로 입력해 주세요.", true); return; }
  const outingAt = currentOutingAt();
  state.chatBusy = true; historyControls(); $("send").textContent = "전송 중…"; renderMessages(question); status("chat-status", "AI 답변을 기다리는 중…");
  try {
    const result = await api.chat(question, isAdmin ? state.conversationId : null, outingAt);
    if (typeof result.conversation_id !== "string" || typeof result.response !== "string" || !result.response.trim()) throw new Error();
    state.conversationId = isAdmin ? result.conversation_id : null;
    const pair = [{ role: "user", content: question }, { role: "assistant", content: result.response }];
    state.messages = isAdmin ? [...state.messages, ...pair] : pair;
    $("question").value = ""; renderMessages(); status("chat-status", "답변과 질문이 저장되었어요."); await loadHistory();
  } catch (error) { if (error.status === 412) clearOuting(errorMessage(error, "chat")); renderMessages(); status("chat-status", errorMessage(error, "chat") + (isAdmin ? " 저장 여부가 확실하지 않으면 이전 대화 목록을 새로고침해 확인한 뒤 다시 보내세요." : " 저장 여부가 불확실하면 관리자에게 확인하고 다시 보내세요.") + " 질문은 입력창에 남겨 두었습니다.", true); }
  finally { state.chatBusy = false; historyControls(); $("send").textContent = "전송"; $("question").focus(); }
}
function temperature(value) { return typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}°C` : "—"; }
async function loadSummary() {
  $("refresh-summary").disabled = true; status("summary-status", "요약을 불러오는 중…"); $("summary-content").replaceChildren();
  try {
    const summary = await api.summary(); const target = $("summary-content");
    if (!summary.count) { target.append(element("p", "기온 자료가 없어요. 데이터가 추가되면 통계가 표시됩니다.", "empty")); status("summary-status"); return; }
    target.append(element("p", `${summary.start_date} ~ ${summary.end_date}`, "summary-period"));
    const stats = element("div", undefined, "stats");
    for (const [label, value] of [["관측 데이터", `${summary.count}건`], ["평균기온", temperature(summary.mean_value)], ["최저 일평균", temperature(summary.min_value)], ["최고 일평균", temperature(summary.max_value)]]) { const item = element("dl", undefined, "stat"); item.append(element("dt", label), element("dd", value)); stats.append(item); }
    target.append(stats);
    const labels = { rising: "상승", falling: "하락", stable: "유지", insufficient_data: "판단 불가" };
    const trend = element("div", undefined, "trend"); trend.append(element("strong", `과거 관측 추세 · ${labels[summary.trend.status] || "판단 불가"}`), element("p", summary.trend.status === "insufficient_data" ? "연속된 14일 자료가 부족해 추세를 판단할 수 없어요." : `마지막 7일 ${temperature(summary.trend.latest_week_mean)} / 직전 7일 ${temperature(summary.trend.previous_week_mean)}`, "muted small"), element("p", "마지막 관측일 기준 · 현재 날씨나 예보 아님", "muted small")); target.append(trend); status("summary-status");
  } catch (error) { status("summary-status", errorMessage(error), true); }
  finally { $("refresh-summary").disabled = false; }
}
function dataControls() { const busy = state.dataBusy || state.dataLoading; $("save-data").disabled = busy; $("refresh-data").disabled = busy; $("cancel-edit").disabled = busy; document.querySelectorAll("#data-list button").forEach(button => button.disabled = busy); }
async function loadData() {
  if (state.dataLoading) return false;
  state.dataLoading = true; dataControls();
  status("data-status", "데이터를 불러오는 중…");
  chartMessage($("temperature-chart"), "기온 그래프를 불러오는 중…");
  try {
    const records = await api.data(); if (!Array.isArray(records)) throw new Error();
    state.records = [...records].sort((a, b) => a.date.localeCompare(b.date)); renderData(); status("data-status"); return true;
  } catch (error) { state.records = []; $("data-list").replaceChildren(); chartMessage($("temperature-chart"), "데이터를 불러오지 못해 그래프를 표시할 수 없어요. 새로고침해 주세요."); status("data-status", errorMessage(error) + " 새로고침으로 목록을 다시 확인해 주세요.", true); return false; }
  finally { state.dataLoading = false; dataControls(); }
}
function renderData() {
  renderTemperatureChart($("temperature-chart"), state.records);
  const target = $("data-list"); target.replaceChildren();
  if (!state.records.length) empty(target, "기온 데이터가 없어요", isAdmin ? "관측 날짜와 기온을 입력해 새 데이터를 추가할 수 있어요." : "관리자에게 자료 등록을 요청해 주세요.");
  const dateFilter = $("data-date-filter").value;
  const visible = state.records.filter(record => !dateFilter || record.date === dateFilter);
  if (state.records.length && !visible.length) empty(target, "이 날짜의 기록이 없어요", "전체 날짜 보기를 누르면 다른 관측 기록을 확인할 수 있어요.");
  for (const record of visible) {
    const row = element("li", undefined, "data-row"); const top = element("div", undefined, "record-top"); top.append(element("span", record.date), element("span", temperature(record.value))); const actions = element("div", undefined, "record-actions");
    const edit = element("button", "수정", "button secondary"); edit.type = "button"; edit.setAttribute("aria-label", `${record.date} 데이터 수정`); edit.addEventListener("click", () => editData(record));
    const remove = element("button", "삭제", "button danger"); remove.type = "button"; remove.setAttribute("aria-label", `${record.date} 데이터 삭제`); remove.addEventListener("click", () => deleteData(record.date));
    actions.append(edit, remove); row.append(top, element("p", record.memo, "record-memo")); if (isAdmin) row.append(actions); target.append(row);
  }
  dataControls();
}
function editData(record) { if (state.dataBusy) return; state.editDate = record.date; $("record-date").value = record.date; $("record-date").disabled = true; $("record-value").value = record.value; $("record-memo").value = record.memo; $("data-form-heading").textContent = "데이터 수정 · 날짜는 변경할 수 없어요"; $("save-data").textContent = "수정 저장"; $("cancel-edit").hidden = false; $("record-value").focus(); }
function resetDataForm() { state.editDate = null; $("data-form").reset(); $("record-date").disabled = false; $("data-form-heading").textContent = "새 데이터 추가"; $("save-data").textContent = "추가하기"; $("cancel-edit").hidden = true; }
async function saveData(event) {
  if (!isAdmin) { event.preventDefault(); return; }
  event.preventDefault(); if (state.dataBusy || state.dataLoading) return;
  const date = $("record-date").value; const value = $("record-value").value; const memo = $("record-memo").value;
  if (!validRecord(date, value, memo)) { status("data-status", "유효한 날짜와 유한한 숫자 기온을 입력해 주세요.", true); return; }
  state.dataBusy = true; dataControls(); status("data-status", "저장하는 중…");
  try {
    const record = { date, value: Number(value), memo };
    if (state.editDate) await api.updateData(state.editDate, record); else await api.addData(record);
    resetDataForm(); const [loaded] = await Promise.all([loadData(), loadSummary()]); if (loaded) status("data-status", "데이터를 저장했어요.");
  } catch (error) { status("data-status", errorMessage(error) + " 저장 여부가 불확실하면 목록을 새로고침해 확인하세요.", true); }
  finally { state.dataBusy = false; dataControls(); }
}
async function deleteData(date) {
  if (!isAdmin) return;
  if (state.dataBusy || state.dataLoading || !window.confirm(`${date} 기온 데이터를 삭제할까요? 되돌릴 수 없습니다.`)) return;
  state.dataBusy = true; dataControls(); status("data-status", "삭제하는 중…");
  try { await api.deleteData(date); if (state.editDate === date) resetDataForm(); const [loaded] = await Promise.all([loadData(), loadSummary()]); if (loaded) status("data-status", "데이터를 삭제했어요."); }
  catch (error) { status("data-status", errorMessage(error), true); }
  finally { state.dataBusy = false; dataControls(); }
}
function showPanel(name) {
  if (name === "history" && !isAdmin) return;
  $("main").dataset.view = name;
  document.body.dataset.view = name;
  for (const panel of ["outing", "chat", "data"]) { $(`${panel}-panel`).hidden = panel !== name; $(`${panel}-tab`).classList.toggle("active", panel === name); if (panel === name) $(`${panel}-tab`).setAttribute("aria-current", "page"); else $(`${panel}-tab`).removeAttribute("aria-current"); }
  for (const view of ["outing", "chat", "history", "data"]) { if (view === name) $(`mobile-${view}`).setAttribute("aria-current", "page"); else $(`mobile-${view}`).removeAttribute("aria-current"); }
  updateChatViewport();
}
function updateChatViewport() {
  if ($("main").hidden || $("main").dataset.view !== "chat") return;
  const mobile = matchMedia("(max-width: 760px)").matches;
  const navigationHeight = mobile ? $("mobile-nav").getBoundingClientRect().height : 0;
  const height = (window.visualViewport?.height || innerHeight) - $("chat-panel").getBoundingClientRect().top - navigationHeight - 12;
  $("chat-panel").style.setProperty("--chat-height", `${Math.max(160, height)}px`);
}
let verifiedOuting = null;
let outingTimer;
let outingBusy = false;
let outingGeneration = 0;
function outingStatus(message = "", error = false) {
  status("outing-status", message, error);
  status("chat-outing-status", message, error);
}
function outingControls() {
  const busy = state.chatBusy || state.historyBusy;
  for (const prefix of ["outing", "chat-outing"]) {
    $(`${prefix}-submit`).disabled = outingBusy || busy;
    $(`${prefix}-time`).disabled = busy;
  }
  $("recommend-outing").disabled = busy || outingBusy || !outingValidity(verifiedOuting).valid;
}
function clearOuting(reason = "외출 시각을 선택하고 날씨를 먼저 확인해 주세요.") {
  verifiedOuting = null;
  clearTimeout(outingTimer);
  outingGeneration += 1;
  $("outing-result").replaceChildren();
  $("chat-outing-result").replaceChildren();
  outingStatus(reason);
  $("recommend-hint").textContent = "";
  outingControls();
}
function currentOutingAt() {
  const validity = outingValidity(verifiedOuting);
  if (!validity.valid) {
    if (verifiedOuting) clearOuting(validity.reason);
    return null;
  }
  return verifiedOuting.requested_at;
}
function checkOutingFreshness() {
  currentOutingAt(); outingControls();
}
function changeOutingTime(event) {
  const value = event.currentTarget.value;
  $("outing-time").value = value; $("chat-outing-time").value = value;
  clearOuting("외출 시각이 변경됐어요. 날씨를 다시 확인해 주세요.");
}
function renderChatOuting(result) {
  const target = $("chat-outing-result"); target.replaceChildren();
  const forecastDay = result.forecast_at.slice(0, 10) === result.requested_at.slice(0, 10) ? "오늘" : "내일";
  const metrics = element("dl", undefined, "weather-metrics");
  for (const [label, value, unit] of [["기온", result.weather.temperature_2m, "°C"], ["강수확률", result.weather.precipitation_probability, "%"], ["풍속", result.weather.wind_speed_10m, " m/s"]]) {
    const item = element("div"); item.append(element("dt", label), element("dd", `${value}${unit}`)); metrics.append(item);
  }
  target.append(metrics, element("p", `선택 오늘 ${result.requested_at.slice(11, 16)} · 예보 ${forecastDay} ${result.forecast_at.slice(11, 16)}`, "forecast-time"),
    element("p", `예보 강수량 ${result.weather.precipitation} mm${result.offset_minutes ? ` · ${result.offset_minutes}분 뒤 예보 사용` : ""}`, "muted small"));
  const source = element("p", undefined, "forecast-source");
  const link = element("a", "Open-Meteo"); link.href = "https://open-meteo.com/";
  const licence = element("a", "CC BY 4.0"); licence.href = "https://creativecommons.org/licenses/by/4.0/";
  source.append(link, document.createTextNode(" · "), licence, document.createTextNode(` · 조회 ${result.fetched_at.slice(11, 16)}`));
  target.append(source);
  const note = element("details", undefined, "forecast-note");
  note.append(element("summary", "예보 기준과 한계"), element("p", "시각은 서울(Asia/Seoul) 기준이며 서버 조회 시각을 표시해요. 모델 발표 시각은 미확인이에요. 강수확률·강수량은 예보 시각 전 1시간의 예측값이며 실제 관측이 아니에요. 예보를 요약한 자료로, 외출 전체 시간의 날씨를 보장하지 않아요.", "muted small"));
  target.append(note);
}
function renderOuting(result) {
  if (result.status !== "available" || !result.weather) throw new Error("unavailable");
  const limits = { temperature_2m: [-90, 60], precipitation_probability: [0, 100], precipitation: [0, 1000], wind_speed_10m: [0, 150] };
  if (Object.entries(limits).some(([key, [low, high]]) => typeof result.weather[key] !== "number" || !Number.isFinite(result.weather[key]) || result.weather[key] < low || result.weather[key] > high)) throw new Error("unavailable");
  if ([result.requested_at, result.forecast_at, result.fetched_at].some(value => typeof value !== "string" || !Number.isFinite(new Date(value).getTime()))) throw new Error("unavailable");
  const target = $("outing-result");
  target.replaceChildren();
  const source = element("p", undefined, "muted small");
  const link = element("a", "날씨 데이터 제공: Open-Meteo"); link.href = "https://open-meteo.com/";
  const licence = element("a", "CC BY 4.0"); licence.href = "https://creativecommons.org/licenses/by/4.0/";
  source.append(link, document.createTextNode(" · "), licence, document.createTextNode(" · 예보를 규칙 기반 추천으로 가공했어요."));
  target.append(source, element("p", `선택 시각: ${formatTime(result.requested_at)} · 예보 시각: ${formatTime(result.forecast_at)} (Asia/Seoul)`));
  if (result.offset_minutes) target.append(element("p", `선택 시각보다 ${result.offset_minutes}분 뒤의 다음 정각 예보를 사용했어요.`, "muted"));
  target.append(element("p", `서버 조회 시각: ${formatTime(result.fetched_at)} · 제공자의 모델 발표 시각은 확인되지 않았어요.`, "muted small"));
  const weather = result.weather;
  const measurement = (value, unit) => typeof value === "number" && Number.isFinite(value) ? `${value}${unit}` : "확인 불가";
  target.append(element("p", `예보 기온 ${measurement(weather.temperature_2m, "°C")} · 강수확률 ${measurement(weather.precipitation_probability, "%")} · 예보 강수량 ${measurement(weather.precipitation, " mm")} · 풍속 ${measurement(weather.wind_speed_10m, " m/s")}`));
  target.append(element("p", "강수확률과 강수량은 예보 시각 이전 1시간 구간의 예측값이에요. 실제 측정 강수량이 아니며, 전체 외출 시간의 날씨를 보장하지 않아요.", "muted small"));
  for (const [heading, content] of [["옷차림", result.clothing], ["우산", result.umbrella], ["준비물", result.items.join(" · ")], ["추천 이유", result.reasons.join(" ")]]) {
    target.append(element("h2", heading), element("p", content));
  }
}
async function loadOuting(event) {
  event.preventDefault();
  if (outingBusy || state.chatBusy || state.historyBusy) return;
  const selected = $(event.currentTarget.id === "chat-outing-form" ? "chat-outing-time" : "outing-time").value;
  $("outing-time").value = selected; $("chat-outing-time").value = selected;
  clearOuting();
  const generation = outingGeneration;
  outingBusy = true; outingControls();
  outingStatus("서울 시간대별 예보를 확인하는 중… AI는 호출하지 않아요.");
  try {
    const result = await api.outing(selected);
    if (generation !== outingGeneration) return;
    if (result.status !== "available") {
      clearOuting(typeof result.message === "string" ? result.message : "현재 날씨 정보 확인 불가");
      return;
    }
    const validity = outingValidity(result, Date.now(), selected);
    if (!validity.valid) { clearOuting(validity.reason); return; }
    renderOuting(result); renderChatOuting(result);
    verifiedOuting = result;
    outingStatus();
    $("recommend-hint").textContent = "AI 답변과 질문이 저장돼요.";
    outingTimer = setTimeout(() => clearOuting(outingValidity(result).reason || "날씨를 다시 확인해 주세요."), Math.max(1, validity.deadline - Date.now()));
  } catch (error) {
    if (generation !== outingGeneration) return;
    clearOuting([401, 403].includes(error.status) ? errorMessage(error) : "현재 날씨 정보 확인 불가. 잠시 후 다시 확인해 주세요.");
  } finally { outingBusy = false; outingControls(); updateChatViewport(); }
}
async function recommendOuting(event) {
  event.preventDefault();
  if (state.chatBusy || state.historyBusy || outingBusy) return;
  if (!currentOutingAt()) {
    if (!$("chat-outing-status").textContent) clearOuting("날씨를 먼저 확인해 주세요.");
    return;
  }
  $("question").value = OUTING_QUESTION;
  await sendQuestion(event);
}
try {
  api = createApi(window.APP_CONFIG.API_BASE_URL, globalThis.fetch.bind(globalThis), () => evaluationCode);
  $("outing-form").addEventListener("submit", loadOuting);
  $("outing-time").addEventListener("input", changeOutingTime);
  $("chat-outing-form").addEventListener("submit", loadOuting);
  $("chat-outing-time").addEventListener("input", changeOutingTime);
  $("recommend-outing").addEventListener("click", recommendOuting);
  window.addEventListener("focus", checkOutingFreshness);
  document.addEventListener("visibilitychange", checkOutingFreshness);
  $("reenter-code").addEventListener("click", () => window.location.reload());
  $("access-form").addEventListener("submit", async event => {
    event.preventDefault();
    if ($("access-submit").disabled) return;
    evaluationCode = $("access-code").value;
    $("access-code").value = "";
    $("access-submit").disabled = true;
    status("access-status", "접근 코드를 확인하는 중… 초기 서버 구동에는 시간이 걸릴 수 있어요.");
    try {
      const result = await api.access();
      if (result.authenticated !== true || !["admin", "evaluator"].includes(result.role)) throw new Error();
      applyRole(result.role);
      $("access-panel").hidden = true; $("main").hidden = false; $("mobile-nav").hidden = false; $("reenter-code").hidden = false;
      showPanel("chat");
      status("access-status");
      await Promise.all([loadSummary(), loadHistory()]); $("messages").scrollTop = 0;
    } catch (error) {
      evaluationCode = "";
      status("access-status", errorMessage(error) + " 서버가 잠들어 있었다면 잠시 기다린 뒤 다시 확인해 주세요.", true);
      $("access-code").focus();
    } finally { $("access-submit").disabled = false; }
  });
  $("outing-tab").addEventListener("click", () => showPanel("outing"));
  $("mobile-outing").addEventListener("click", () => showPanel("outing"));
  $("chat-tab").addEventListener("click", () => showPanel("chat"));
  $("data-tab").addEventListener("click", () => { showPanel("data"); if (!state.dataBusy) loadData(); });
  $("mobile-chat").addEventListener("click", () => showPanel("chat"));
  $("mobile-history").addEventListener("click", () => showPanel("history"));
  $("mobile-data").addEventListener("click", () => { showPanel("data"); if (!state.dataBusy) loadData(); });
  $("data-date-filter").addEventListener("input", renderData);
  $("clear-date-filter").addEventListener("click", () => { $("data-date-filter").value = ""; renderData(); });
  $("chat-form").addEventListener("submit", sendQuestion);
  $("question").addEventListener("keydown", event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); $("chat-form").requestSubmit(); } });
  $("new-conversation").addEventListener("click", newConversation);
  $("history-new-conversation").addEventListener("click", newConversation);
  window.addEventListener("resize", updateChatViewport);
  window.visualViewport?.addEventListener("resize", updateChatViewport);
  $("refresh-conversations").addEventListener("click", loadHistory);
  $("refresh-summary").addEventListener("click", loadSummary);
  $("refresh-data").addEventListener("click", loadData);
  $("data-form").addEventListener("submit", saveData);
  $("cancel-edit").addEventListener("click", resetDataForm);
  renderMessages();
  let chartWidth = 0;
  new ResizeObserver(entries => {
    const width = entries[0].contentRect.width;
    if (width && width !== chartWidth) { chartWidth = width; if (state.records.length && !state.dataLoading) renderTemperatureChart($("temperature-chart"), state.records); }
  }).observe($("temperature-chart"));
} catch { status("access-status", "API 설정을 확인해 주세요. config.js에 올바른 FastAPI 서버 주소가 필요합니다.", true); $("access-submit").disabled = true; }
