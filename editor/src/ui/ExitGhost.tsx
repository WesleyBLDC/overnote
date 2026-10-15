/**
 * A short fade out for a popover that has already closed. Right before the popover leaves the DOM,
 * getSnapshotBeforeUpdate copies its markup (and list scroll); the copy is rendered inert and
 * hidden from assistive tech while the stylesheet fades it (.panel-ghost). The real component is gone
 * at once, so focus, keys, and window height behave exactly as without the animation.
 */
import { Component, createRef, type RefObject } from "react";
import { prefersReducedMotion } from "../lib/motion";

interface ExitGhostProps {
  open: boolean;
  /** Where to find the closing element. */
  root: RefObject<HTMLElement | null>;
  selector: string;
  className: string;
  /** How long the copy stays, a little longer than its CSS animation. */
  ms?: number;
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
    const element = this.props.root.current?.querySelector(this.props.selector);
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
      this.timer = setTimeout(() => this.setState({ ghost: null }), this.props.ms ?? 180);
      return;
    }
    if (this.props.open && this.state.ghost) {
      clearTimeout(this.timer);
      this.setState({ ghost: null });
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

  override render() {
    const { ghost } = this.state;
    if (!ghost) return null;
    return <div ref={this.container} className={this.props.className} aria-hidden="true" inert dangerouslySetInnerHTML={{ __html: ghost.html }} />;
  }
}
