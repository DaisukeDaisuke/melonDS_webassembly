// Cursor-based access to the existing bounded script output, not a second logger.
export function createScriptConsole() {
  const lines = [];
  let next = 1, unread = 1;
  return {
    append(values) {
      for (const value of values) for (const text of String(value).slice(0, 2048).replace(/\r\n?/g, '\n').split('\n')) {
        lines.push({ line: next++, text });
      }
      if (lines.length > 500) lines.splice(0, lines.length - 500);
    },
    read(args = {}) {
      const firstAvailable = lines[0]?.line ?? next, lastAvailable = next - 1;
      const integer = (value, fallback) => Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback;
      const requested = args.startLine === undefined ? unread : integer(args.startLine, firstAvailable);
      const start = Math.max(firstAvailable, Math.min(next, requested));
      let end = args.endLine === undefined ? lastAvailable : integer(args.endLine, lastAvailable);
      // A missing/out-of-range/backwards end means the current end of output.
      if (end < start || end > lastAvailable) end = lastAvailable;
      const limit = Math.max(1, Math.min(500, integer(args.limit, 100)));
      const budget = Math.max(2048, Math.min(1048576, integer(args.maxChars, 8192)));
      const selected = [];
      let characters = 0;
      for (const line of lines) {
        if (line.line < start || line.line > end) continue;
        if (selected.length >= limit || (selected.length && characters + line.text.length + 1 > budget)) break;
        selected.push(line); characters += line.text.length + 1;
      }
      const nextLine = selected.length ? selected.at(-1).line + 1 : start;
      const markRead = args.markRead ?? (args.startLine === undefined);
      if (markRead) unread = Math.max(unread, nextLine);
      return { firstAvailable, lastAvailable, startLine: start, endLine: selected.at(-1)?.line ?? null,
        nextLine, unreadFrom: unread, missedLines: Math.max(0, firstAvailable - Math.max(1, requested)),
        hasMore: nextLine <= end, lines: selected, text: selected.map(line => line.text).join('\n') };
    }
  };
}
