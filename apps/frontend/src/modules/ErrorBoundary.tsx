import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          minHeight: '100vh', gap: 16, fontFamily: 'system-ui', color: '#e0e0e0', background: '#1a1a2e',
        }}>
          <h2 style={{ margin: 0 }}>⚠️ 页面出错了</h2>
          <pre style={{ maxWidth: 600, whiteSpace: 'pre-wrap', fontSize: 13, color: '#ff6b6b' }}>
            {this.state.error?.message}
          </pre>
          <button
            onClick={this.handleReset}
            style={{ padding: '8px 24px', cursor: 'pointer', borderRadius: 6, border: '1px solid #444', background: '#2a2a4a', color: '#e0e0e0' }}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
