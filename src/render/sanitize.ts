/**
 * Terminal-safety sanitizing shared by renderers: newline/tab → visible
 * markers, other C0 controls + ESC stripped (data-driven escape injection).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char stripping
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/g;

export function sanitizeCell(s: string): string {
  return s.replace(/\r?\n/g, "⏎").replace(/\t/g, "⇥").replace(CONTROL_CHARS, "");
}

/** Strip control chars without visible markers (for compact inline use). */
export function stripControlChars(s: string): string {
  return s.replace(CONTROL_CHARS, "");
}
