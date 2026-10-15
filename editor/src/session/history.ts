/**
 * Back and forward stacks owned by the editor (docs/architecture.md section 5, editor-owned behavior).
 * Stacks are capped; visiting a note clears the forward stack like a browser.
 */
import type { NoteId } from "@overnote/core";

export const HISTORY_CAP = 100;

export class NoteHistory {
  private back: NoteId[] = [];
  private forward: NoteId[] = [];

  constructor(private readonly cap = HISTORY_CAP) {}

  /** Called when leaving `from` for a different note through a normal open. */
  visit(from: NoteId): void {
    this.push(this.back, from);
    this.forward = [];
  }

  /** The note Go Back would open, without changing the stacks. */
  peekBack(current: NoteId | null): NoteId | null {
    return this.peek(this.back, current);
  }

  peekForward(current: NoteId | null): NoteId | null {
    return this.peek(this.forward, current);
  }

  /** Pops the back stack up to its target and pushes `current` on the forward stack. */
  commitBack(current: NoteId | null): NoteId | null {
    return this.commit(this.back, this.forward, current);
  }

  commitForward(current: NoteId | null): NoteId | null {
    return this.commit(this.forward, this.back, current);
  }

  remove(id: NoteId): void {
    this.back = this.back.filter((entry) => entry !== id);
    this.forward = this.forward.filter((entry) => entry !== id);
  }

  clear(): void {
    this.back = [];
    this.forward = [];
  }

  snapshot(): { back: NoteId[]; forward: NoteId[] } {
    return { back: [...this.back], forward: [...this.forward] };
  }

  private push(stack: NoteId[], id: NoteId): void {
    if (stack[stack.length - 1] === id) return;
    stack.push(id);
    if (stack.length > this.cap) stack.splice(0, stack.length - this.cap);
  }

  private peek(stack: NoteId[], current: NoteId | null): NoteId | null {
    for (let i = stack.length - 1; i >= 0; i--) {
      const entry = stack[i];
      if (entry !== undefined && entry !== current) return entry;
    }
    return null;
  }

  private commit(from: NoteId[], to: NoteId[], current: NoteId | null): NoteId | null {
    while (from.length > 0) {
      const entry = from.pop();
      if (entry !== undefined && entry !== current) {
        if (current) this.push(to, current);
        return entry;
      }
    }
    return null;
  }
}
