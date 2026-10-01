/**
 * DIN-1493 — read one secret from the terminal without echoing it. The terminal is put in raw mode, so the
 * typed characters are never written back; only the question and a final newline are. Backspace edits the
 * buffer, Enter (or Ctrl-D) ends it, Ctrl-C aborts. It refuses to run without a TTY: a secret is never read from
 * a non-interactive stream by accident.
 */

/** The part of a TTY stream the prompt uses (process.stdin satisfies it). */
export interface HiddenPromptInput {
  readonly isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  setEncoding: (encoding: BufferEncoding) => unknown;
  on: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown;
  removeListener: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown;
  resume: () => unknown;
  pause: () => unknown;
}

export interface HiddenPromptIo {
  readonly input: HiddenPromptInput;
  readonly output: { write: (chunk: string) => unknown };
}

export class HiddenPromptAborted extends Error {
  constructor() {
    super('Input cancelled');
    this.name = 'HiddenPromptAborted';
  }
}

const ENTER = new Set(['\r', '\n', '\u0004']);
const BACKSPACE = new Set(['\u007f', '\b']);
const CTRL_C = '\u0003';

/** Fold typed characters into the buffer; stop at Enter/Ctrl-D ('enter') or Ctrl-C ('abort'). */
function applyKeys(start: string, chunk: string): { buffer: string; end?: 'enter' | 'abort' } {
  let buffer = start;
  for (const ch of chunk) {
    if (ch === CTRL_C) return { buffer, end: 'abort' };
    if (ENTER.has(ch)) return { buffer, end: 'enter' };
    buffer = BACKSPACE.has(ch) ? buffer.slice(0, -1) : buffer + ch;
  }
  return { buffer };
}

/** The real terminal: stdin for keys, stdout for the question. */
function terminal(): HiddenPromptIo {
  return { input: process.stdin, output: process.stdout };
}

export function promptHidden(question: string, io?: HiddenPromptIo): Promise<string> {
  const { input, output } = io ?? terminal();
  const setRawMode = input.setRawMode?.bind(input);
  if (input.isTTY !== true || setRawMode === undefined) {
    return Promise.reject(new Error('A hidden prompt needs an interactive terminal'));
  }
  output.write(question);
  return new Promise((resolve, reject) => {
    let buffer = '';
    const finish = (settle: () => void) => {
      input.removeListener('data', onData);
      setRawMode(false);
      input.pause();
      output.write('\n');
      settle();
    };
    const onData = (chunk: Buffer | string) => {
      const typed = applyKeys(buffer, String(chunk));
      buffer = typed.buffer;
      if (typed.end === 'abort') finish(() => reject(new HiddenPromptAborted()));
      if (typed.end === 'enter') finish(() => resolve(buffer));
    };
    setRawMode(true);
    input.setEncoding('utf8');
    input.on('data', onData);
    input.resume();
  });
}
