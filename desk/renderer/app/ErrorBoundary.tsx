// One layer's crash stays in that layer (JD-63): the overlay wraps the orb, the cards, file drop and
// the hand pointers in their own boundary, so a bad card can't blank the orb. The error goes to the
// console, which main copies into desk.log with the window it came from.
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** Which layer, for the log: "orb", "cards", "drop", "hands"… */
  name: string;
  /** What shows instead once the layer has failed (nothing by default). */
  fallback?: ReactNode;
  children: ReactNode;
}

export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.name}] layer crashed and was dropped:`, error, info.componentStack ?? "");
  }

  render(): ReactNode {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
