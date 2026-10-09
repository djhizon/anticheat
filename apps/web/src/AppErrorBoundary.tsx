import { Component, type ReactNode } from 'react';

/** Keep renderer failures visible and recoverable instead of showing a blank page. */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    const bridge = (window as Window & { electronExam?: { reportRenderFailure?: () => void } })
      .electronExam;
    bridge?.reportRenderFailure?.();
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <main style={{ padding: 32, background: '#fff', color: '#182033' }} role="alert">
          <h1>The exam screen encountered an error</h1>
          <p>You can close this window normally with Cmd+W or quit with Cmd+Q.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload application
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}
