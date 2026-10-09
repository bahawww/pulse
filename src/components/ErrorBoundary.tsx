import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  /** What failed, shown in the fallback: "Trends", "the dashboard". */
  readonly label: string;
  /** Changing this clears a caught error, e.g. the view id, so leaving a broken view and coming back retries it. */
  readonly resetKey?: string;
  /** Full-page fallback with a reload button, for the outermost boundary. */
  readonly page?: boolean;
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
  readonly resetKey: string | undefined;
}

/**
 * Keeps one broken panel from blanking the whole app. A render error inside is
 * caught and replaced with a small card that says what failed and offers a
 * retry; everything outside keeps working and keeps polling.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState): Partial<ErrorBoundaryState> | null {
    if (props.resetKey === state.resetKey) return null;
    return { error: null, resetKey: props.resetKey };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[pulse] ${this.props.label} crashed:`, error, info.componentStack);
  }

  private readonly retry = (): void => {
    if (this.props.page) window.location.reload();
    else this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className={`card crash${this.props.page ? ' is-page' : ''}`} role="alert">
        <p className="card-title">Something went wrong in {this.props.label}.</p>
        <p className="card-sub">
          {error.message || 'Unknown error'}.{this.props.page ? '' : ' The rest of Pulse is still running.'}
        </p>
        <button type="button" className="btn btn-sm" onClick={this.retry}>
          {this.props.page ? 'Reload' : 'Try again'}
        </button>
      </div>
    );
  }
}
