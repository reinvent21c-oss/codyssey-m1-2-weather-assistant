// Only **bold** and ***recommended item*** are interpreted, never HTML/links.
// Item semantics come from the model annotation, not a dictionary of object names.
const negativeRecommendation = /필요\s*(?:하지\s*)?않|필요(?:가|는)?\s*없|챙기지|가져가지|추천하지|권하지|불필요|없어도|안\s*챙/u;
export function emphasisTokens(text) {
  const tokens = [];
  const pattern = /(?<!\*)(\*{2,3})([^*\n]+?)\1(?!\*)/g;
  let cursor = 0, colored = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) tokens.push({ type: "text", text: text.slice(cursor, match.index) });
    const value = match[2];
    const isItem = match[1].length === 3;
    const start = text.lastIndexOf("\n", match.index) + 1;
    const end = text.indexOf("\n", match.index + match[0].length);
    const line = text.slice(start, end === -1 ? text.length : end);
    if (!value.trim() || value.length > (isItem ? 60 : 120)) {
      tokens.push({ type: "text", text: match[0] });
    } else if (isItem && negativeRecommendation.test(line)) {
      // Conservatively avoid implying that a negated/optional item must be packed.
      tokens.push({ type: "text", text: value });
    } else {
      const type = isItem && colored < 4 ? "item" : "bold";
      if (type === "item") colored += 1;
      tokens.push({ type, text: value });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) tokens.push({ type: "text", text: text.slice(cursor) });
  return tokens;
}
export function renderAssistantText(target, text) {
  const doc = target.ownerDocument;
  target.replaceChildren();
  for (const token of emphasisTokens(text)) {
    if (token.type === "text") target.append(doc.createTextNode(token.text));
    else {
      const strong = doc.createElement("strong");
      if (token.type === "item") strong.className = "recommended-item";
      strong.textContent = token.text;
      target.append(strong);
    }
  }
}
