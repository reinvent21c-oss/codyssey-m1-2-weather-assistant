// Pure UI validity checks. The server rechecks its cache before paid AI work.
export const OUTING_QUESTION = "선택한 서울의 오늘 외출 시각 예보를 바탕으로 옷차림, 우산, 준비물과 간단한 이유를 추천해 주세요. 과거 관측 통계와 오늘의 예보는 구분해 주세요.";
export function outingValidity(result, now = Date.now(), selectedTime) {
  const invalid = reason => ({ valid: false, reason });
  if (!result || result.status !== "available") return invalid("외출 시각을 선택하고 날씨를 먼저 확인해 주세요.");
  const limits = { temperature_2m: [-90, 60], precipitation_probability: [0, 100], precipitation: [0, 1000], wind_speed_10m: [0, 150] };
  if (!result.weather || Object.entries(limits).some(([key, [low, high]]) => typeof result.weather[key] !== "number" || !Number.isFinite(result.weather[key]) || result.weather[key] < low || result.weather[key] > high)) return invalid("날씨 응답의 필수 값을 확인할 수 없어요. 날씨를 다시 확인해 주세요.");
  if ([result.requested_at, result.forecast_at, result.fetched_at].some(value => typeof value !== "string" || !value.endsWith("+09:00") || !Number.isFinite(Date.parse(value)))) return invalid("날씨 응답의 기준 시각을 확인할 수 없어요.");
  const requested = Date.parse(result.requested_at);
  const fetched = Date.parse(result.fetched_at);
  if (result.requested_at.slice(0, 10) !== new Date(now + 9 * 3600000).toISOString().slice(0, 10) || requested <= now) return invalid("선택한 외출 시각이 지났어요. 오늘의 다른 시각을 선택해 주세요.");
  if (selectedTime && result.requested_at.slice(11, 16) !== selectedTime) return invalid("선택 시각이 달라졌어요. 날씨를 다시 확인해 주세요.");
  const providerExpiry = result.valid_until === undefined ? fetched + 600000 : Date.parse(result.valid_until);
  const deadline = Math.min(requested, fetched + 600000, providerExpiry);
  if (!Number.isFinite(deadline) || fetched > now + 30000 || now >= deadline) return invalid("날씨 정보의 유효기간이 지났어요. 날씨를 다시 확인해 주세요.");
  return { valid: true, deadline };
}
