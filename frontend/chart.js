import { validRecord } from "./api.js";

const DAY = 86400000;
const NS = "http://www.w3.org/2000/svg";

// Keep every observation; never interpolate a missing calendar date.
export function chartSeries(records) {
  if (!Array.isArray(records)) throw new Error("Invalid observations");
  const seen = new Set();
  const points = records.map(record => {
    if (typeof record?.value !== "number" || !Number.isFinite(record.value) || !validRecord(record.date, String(record.value), "") || seen.has(record.date)) throw new Error("Invalid observations");
    seen.add(record.date);
    return { date: record.date, value: record.value, time: Date.parse(`${record.date}T00:00:00Z`) };
  }).sort((a, b) => a.time - b.time);
  const segments = [];
  for (const point of points) {
    if (!segments.length || point.time - segments.at(-1).at(-1).time !== DAY) segments.push([]);
    segments.at(-1).push(point);
  }
  return { points, segments };
}

function svgNode(tag, attributes = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

export function chartMessage(container, text) {
  const message = document.createElement("p");
  message.className = "chart-message muted"; message.textContent = text;
  container.replaceChildren(message);
}

export function renderTemperatureChart(container, records) {
  container.replaceChildren();
  let series;
  try { series = chartSeries(records); }
  catch { chartMessage(container, "날짜나 기온 형식이 올바르지 않아 그래프를 표시할 수 없어요."); return; }
  const { points, segments } = series;
  if (!points.length) { chartMessage(container, "기온 데이터가 없어 그래프를 표시할 수 없어요."); return; }
  const width = Math.max(280, container.clientWidth), height = 300;
  const left = 64, right = width - 20, top = 30, bottom = height - 65;
  let low = 0, high = 0;
  for (const point of points) { low = Math.min(low, point.value); high = Math.max(high, point.value); }
  if (low === high) { low = -1; high = 1; }
  const magnitude = Math.max(Math.abs(low), Math.abs(high), 1);
  const y = value => bottom - ((value / magnitude - low / magnitude) / (high / magnitude - low / magnitude)) * (bottom - top);
  const first = points[0], last = points.at(-1);
  const x = time => first.time === last.time ? (left + right) / 2 : left + (time - first.time) / (last.time - first.time) * (right - left);
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-labelledby": "temperature-svg-title temperature-svg-description" });
  svg.append(svgNode("title", { id: "temperature-svg-title" }, "서울 일별 평균기온 변화"), svgNode("desc", { id: "temperature-svg-description" }, `${first.date}부터 ${last.date}까지 과거 관측 ${points.length}건. 날짜가 가로축, 일평균기온 °C가 세로축입니다. 누락 날짜 구간은 선을 연결하지 않습니다. 정확한 날짜와 기온은 아래 데이터 목록에서 확인할 수 있습니다.`));
  svg.append(svgNode("text", { x: left, y: 18, class: "chart-label" }, "일평균기온 (°C)"));
  for (let index = 0; index <= 4; index++) {
    const value = (low / magnitude + (high / magnitude - low / magnitude) * index / 4) * magnitude;
    const position = y(value);
    svg.append(svgNode("line", { x1: left, x2: right, y1: position, y2: position, class: value === 0 ? "chart-zero" : "chart-grid" }), svgNode("text", { x: left - 9, y: position + 5, "text-anchor": "end", class: "chart-label" }, value.toLocaleString("ko-KR", { maximumFractionDigits: 2, ...(Math.abs(value) >= 1e6 ? { notation: "scientific" } : {}) })));
  }
  // Label actual observed dates, with fewer labels at mobile widths.
  const indices = width < 480 ? [0, points.length - 1] : [0, Math.floor((points.length - 1) / 2), points.length - 1];
  for (const index of new Set(indices)) {
    const point = points[index];
    svg.append(svgNode("text", { x: x(point.time), y: bottom + 24, "text-anchor": index === 0 ? "start" : index === points.length - 1 ? "end" : "middle", class: "chart-label" }, point.date));
  }
  svg.append(svgNode("text", { x: (left + right) / 2, y: height - 10, "text-anchor": "middle", class: "chart-label" }, "관측 날짜"));
  for (const segment of segments) {
    if (segment.length > 1) svg.append(svgNode("polyline", { points: segment.map(point => `${x(point.time)},${y(point.value)}`).join(" "), class: "chart-line", fill: "none" }));
  }
  for (const point of points) {
    const dot = svgNode("circle", { cx: x(point.time), cy: y(point.value), r: points.length > 100 ? 2 : 3.5, class: "chart-point", "data-date": point.date, "data-value": point.value });
    dot.append(svgNode("title", {}, `${point.date} · ${point.value}°C`)); svg.append(dot);
  }
  container.append(svg);
}
