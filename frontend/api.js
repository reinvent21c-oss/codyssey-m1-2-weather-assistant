export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function errorMessage(error, area = "data") {
  if (!(error instanceof ApiError)) return "문제가 발생했어요. 잠시 후 다시 확인해 주세요.";
  const messages = {
    401: "접근 코드가 없거나 올바르지 않아요. 접근 코드를 다시 입력해 주세요.",
    403: "관리자만 사용할 수 있는 기능이에요. 평가자 모드에서는 새 질문과 기온 자료 조회를 이용해 주세요.",
    429: "전체 AI 요청 한도에 도달했어요. 잠시 기다린 뒤 다시 시도해 주세요. 자동으로 재전송하지 않습니다.",
    404: area === "chat" ? "대화가 없거나 삭제되었어요. 목록을 새로고침하고 새 대화를 시작해 주세요." : "데이터가 없거나 이미 삭제되었어요. 목록을 새로고침해 주세요.",
    409: area === "chat" ? "대화 저장 한도에 도달했어요. 새 대화를 시작해 주세요." : "이 날짜의 데이터가 이미 있어요. 기존 데이터를 수정해 주세요.",
    422: "입력 형식을 확인해 주세요. 날짜, 숫자 또는 질문 길이가 올바르지 않아요.",
    502: "AI 답변을 받지 못했어요. 서버의 모델 연결 설정을 확인한 뒤 다시 시도해 주세요.",
    503: "저장소에 연결할 수 없어요. 서버 설정을 확인하거나 잠시 후 새로고침해 주세요.",
    504: "AI 응답 시간이 초과되었어요. 대화 기록을 확인한 뒤 다시 시도해 주세요.",
  };
  return messages[error.status] || error.message;
}

export function createApi(baseUrl, fetchImpl = globalThis.fetch.bind(globalThis), getAccessCode = () => "") {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("올바른 FastAPI 서버 주소를 설정해 주세요.");
  const prefix = base.href.replace(/\/$/, "");
  async function request(path, method = "GET", body) {
    const code = getAccessCode();
    if (!code) throw new ApiError(401, "평가용 접근 코드를 입력해 주세요.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35000);
    try {
      const response = await fetchImpl(`${prefix}${path}`, {
        method, signal: controller.signal, credentials: "omit", redirect: "error",
        headers: { "X-Evaluation-Code": code, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new ApiError(response.status, "서버 요청을 처리하지 못했어요. 잠시 후 다시 확인해 주세요.");
      try { return await response.json(); }
      catch { throw new ApiError(0, "서버 응답 형식을 확인할 수 없어요. 서버 상태를 확인해 주세요."); }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(0, error.name === "AbortError" ? "요청 시간이 초과되었어요. 저장 여부를 확인한 뒤 다시 시도해 주세요." : "서버에 연결하지 못했어요. 서버 주소와 CORS 설정을 확인해 주세요.");
    } finally { clearTimeout(timeout); }
  }
  const id = value => encodeURIComponent(value);
  return {
    access: () => request("/api/access"),
    outing: time => request(`/api/outing-recommendation?time=${id(time)}`),
    chat: (question, conversationId, outingAt) => request("/api/chat", "POST", { question, ...(conversationId ? { conversation_id: conversationId } : {}), ...(outingAt ? { outing_at: outingAt } : {}) }),
    createConversation: () => request("/api/conversations", "POST"),
    conversations: () => request("/api/conversations"),
    conversation: value => request(`/api/conversations/${id(value)}`),
    deleteConversation: value => request(`/api/conversations/${id(value)}`, "DELETE"),
    data: () => request("/api/data"),
    addData: record => request("/api/data", "POST", record),
    updateData: (value, record) => request(`/api/data/${id(value)}`, "PUT", record),
    deleteData: value => request(`/api/data/${id(value)}`, "DELETE"),
    summary: () => request("/api/data/summary"),
  };
}

export function validRecord(date, value, memo) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith("0000")) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return false;
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) && typeof memo === "string";
}
