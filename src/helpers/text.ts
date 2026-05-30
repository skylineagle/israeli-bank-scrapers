const BIDIRECTIONAL_CONTROL_CHARACTERS_REGEX = /\u200e|\u200f|\u061c/g;
const COLLAPSIBLE_WHITESPACE_REGEX = /\s+/g;

/**
 * Remove Unicode bidirectional control characters (commonly injected by RTL Hebrew UIs),
 * trim, and collapse runs of whitespace into single spaces.
 */
export function stripBidirectionalAndTrim(raw: string): string {
  return raw.replace(BIDIRECTIONAL_CONTROL_CHARACTERS_REGEX, '').trim().replace(COLLAPSIBLE_WHITESPACE_REGEX, ' ');
}
