/**
 * A short fade out for a popover that has already closed. Right before the popover leaves the DOM,
 * getSnapshotBeforeUpdate copies its markup (and list scroll); the copy is rendered inert and
 * hidden from assistive tech while the stylesheet fades it (.panel-ghost). The real component is gone
 * at once, so focus, keys, and window height behave exactly as without the animation.
 *
 * The stylesheet owns the timing: the copy leaves when its exit animation ends, with a fallback timer
 * derived from the same motion token in case the event never fires. With reduced motion (every token
 * is 0ms) no copy is made at all.
 */
import { Component, createRef } from "react";
import { exitFallbackMs, prefersReducedMotion, type MotionToken } from "../lib/motion";

interface ExitGhostProps {
  open: boolean;
  /** Where to find the closing element. */
  root: HTMLElement | null;
  selector: string;
  className: string;
  /** The motion token the exit animation in the stylesheet runs for. */
  token: MotionToken;
}

interface Snapshot {
  html: string;
  scrollTop: number;
}

export class ExitGhost extends Component<ExitGhostProps, { ghost: Snapshot | null }> {
  override state = { ghost: null as Snapshot | null };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private container = createRef<HTMLDivElement>();
  private scrolled = false;

  override getSnapshotBeforeUpdate(previous: ExitGhostProps): Snapshot | null {
    if (!previous.open || this.props.open || prefersReducedMotion()) return null;
    if (exitFallbackMs(this.props.token) === 0) return null;
    const element = this.props.root?.querySelector(this.props.selector);
    if (!element) return null;
    // Test ids and ids stay unique to the live UI.
    const html = element.outerHTML.replace(/\s(data-testid|id)="[^"]*"/g, "");
    return { html, scrollTop: element.querySelector(".panel-list")?.scrollTop ?? 0 };
  }

  override componentDidUpdate(_previous: ExitGhostProps, _state: unknown, snapshot: Snapshot | null): void {
    if (snapshot) {
      clearTimeout(this.timer);
      this.scrolled = false;
      this.setState({ ghost: snapshot });
      this.timer = setTimeout(this.dismiss, exitFallbackMs(this.props.token));
      return;
    }
    if (this.props.open && this.state.ghost) {
      this.dismiss();
      return;
    }
    const list = this.container.current?.querySelector(".panel-list");
    if (list && this.state.ghost && !this.scrolled) {
      list.scrollTop = this.state.ghost.scrollTop;
      this.scrolled = true;
    }
  }

  override componentWillUnmount(): void {
    clearTimeout(this.timer);
  }

  private dismiss = (): void => {
    clearTimeout(this.timer);
    if (this.state.ghost) this.setState({ ghost: null });
  };

  override render() {
    const { ghost } = this.state;
    if (!ghost) return null;
    return (
      <div
        ref={this.container}
        className={this.props.className}
        aria-hidden="true"
        inert
        // Only the copied popover animates (everything inside it is still), so its end is the exit's end.
        onAnimationEnd={this.dismiss}
        dangerouslySetInnerHTML={{ __html: ghost.html }}
      />
    );
  }
}
