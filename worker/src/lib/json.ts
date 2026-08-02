// Parse a stored JSON TEXT column; a malformed value degrades to an empty
// object rather than throwing on a read path.
export function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}