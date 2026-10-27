// Dependency-free JSON syntax highlighting for the Policies page's document previews
// — same "no library pulled in for a small, well-defined visual need" precedent as
// icons.tsx's own inline SVGs (no icon package for five small icons). A well-known
// regex-based tokenizer (keys/strings/numbers/booleans/null); HTML-escapes the
// stringified JSON FIRST, before any <span> wrapping, so nothing in the document's own
// string values (an LLM-generated description or explanation) can ever inject markup
// — only already-escaped text is placed inside a span's innerHTML.
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlightJson(value: unknown): string {
  const json = escapeHtml(JSON.stringify(value, null, 2));
  return json.replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = "policy-json-number";
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? "policy-json-key" : "policy-json-string";
      } else if (match === "true" || match === "false") {
        cls = "policy-json-boolean";
      } else if (match === "null") {
        cls = "policy-json-null";
      }
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

export function PolicyJson({ value }: { value: unknown }) {
  // eslint-disable-next-line react/no-danger -- the content is our own escaped output, never raw
  return <pre className="policy-json" dangerouslySetInnerHTML={{ __html: highlightJson(value) }} />;
}
