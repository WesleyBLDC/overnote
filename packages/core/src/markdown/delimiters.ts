/**
 * A markdown-it inline rule for paired delimiters such as `~x~`, `~~x~~`, and `++x++`.
 * Runs of an allowed length become delimiters with the usual flanking rules; the opener and the
 * closer must have the same length. Other runs stay literal.
 */
import type { Delimiter as BaseDelimiter, StateInline } from "markdown-it";

type InlineRule = (state: StateInline, silent: boolean) => boolean;
type PostRule = (state: StateInline) => boolean;
type Delimiter = BaseDelimiter & { runLength?: number };

export interface DelimiterRuleOptions {
  marker: string;
  lengths: number[];
  tag: string;
}

export function delimiterRule(options: DelimiterRuleOptions): { tokenize: InlineRule; postProcess: PostRule } {
  const code = options.marker.charCodeAt(0);

  const tokenize: InlineRule = (state, silent) => {
    if (silent || state.src.charCodeAt(state.pos) !== code) return false;
    const scanned = state.scanDelims(state.pos, true);
    const run = options.marker.repeat(scanned.length);
    const token = state.push("text", "", 0);
    token.content = run;
    if (options.lengths.includes(scanned.length)) {
      const delimiter: Delimiter = {
        marker: code,
        length: 0,
        token: state.tokens.length - 1,
        end: -1,
        open: scanned.can_open,
        close: scanned.can_close,
        runLength: scanned.length,
      };
      state.delimiters.push(delimiter);
    }
    state.pos += scanned.length;
    return true;
  };

  const process = (state: StateInline, delimiters: Delimiter[]) => {
    for (const start of delimiters) {
      if (start.marker !== code || start.end === -1) continue;
      const end = delimiters[start.end];
      if (!end || end.runLength !== start.runLength) continue;
      const open = state.tokens[start.token];
      const close = state.tokens[end.token];
      if (!open || !close) continue;
      Object.assign(open, {
        type: `${options.tag}_open`,
        tag: options.tag,
        nesting: 1,
        markup: open.content,
        content: "",
      });
      Object.assign(close, {
        type: `${options.tag}_close`,
        tag: options.tag,
        nesting: -1,
        markup: close.content,
        content: "",
      });
    }
  };

  const postProcess: PostRule = (state) => {
    process(state, state.delimiters as Delimiter[]);
    for (const meta of state.tokens_meta) {
      if (meta?.delimiters) process(state, meta.delimiters as Delimiter[]);
    }
    return true;
  };

  return { tokenize, postProcess };
}
