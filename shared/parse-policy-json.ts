// JSON.parse silently discards duplicate keys, so a pasted policy could lose a rule or a setting
// without any error. parsePolicyJson parses the text and also scans it, throwing on a duplicate
// property (naming its path and line). Shared by the Escalation Desk's policy editors and the
// agent's policy routes, so the same check runs before a policy document is accepted anywhere.
export function parsePolicyJson(text: string): unknown {
  const result: unknown = JSON.parse(text);
  let i = 0;
  const whitespace = () => { while (/\s/.test(text[i] ?? "") && i < text.length) i++; };
  function string(): string {
    const start = i++;
    while (i < text.length) {
      const ch = text[i++];
      if (ch === "\\") i++;
      else if (ch === '"') break;
    }
    return JSON.parse(text.slice(start, i)) as string;
  }
  function value(path: string, depth: number) {
    if (depth > 128) throw new Error("JSON is nested too deeply at " + path);
    whitespace();
    if (text[i] === "{") {
      i++; whitespace();
      const keys = new Set<string>();
      if (text[i] === "}") { i++; return; }
      while (i < text.length) {
        whitespace();
        const offset = i, key = string();
        if (keys.has(key)) {
          const line = text.slice(0, offset).split("\n").length;
          throw new Error("Duplicate JSON property " + JSON.stringify(key) + " at " + path + " (line " + line + "). Remove the duplicate before saving.");
        }
        keys.add(key); whitespace(); i++;
        value(path + "[" + JSON.stringify(key) + "]", depth + 1);
        whitespace();
        if (text[i++] === "}") return;
      }
    } else if (text[i] === "[") {
      i++; whitespace();
      if (text[i] === "]") { i++; return; }
      let index = 0;
      while (i < text.length) {
        value(path + "[" + index++ + "]", depth + 1); whitespace();
        if (text[i++] === "]") return;
      }
    } else if (text[i] === '"') string();
    else { while (i < text.length && !/[\s,}\]]/.test(text[i])) i++; }
  }
  value("$", 0);
  return result;
}
