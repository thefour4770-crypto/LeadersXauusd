import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string | null;
}

function extractReadableError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: string; operationType?: string; path?: string };
    if (parsed && typeof parsed.error === 'string') {
      if (parsed.error.toLowerCase().includes('quota exceeded')) {
        return 'Daily Firestore free-tier quota exceeded. Quota resets tomorrow.';
      }
      return `${parsed.error}${parsed.path ? ` (${parsed.operationType ?? 'op'} on ${parsed.path})` : ''}`;
    }
  } catch {
    // Plain error string
  }
  return raw || 'An unexpected error occurred.';
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, message: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: extractReadableError(error.message),
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Application ErrorBoundary caught error:', error, info);
  }

  private handleReset = () => {
    this.setState({ hasError: false, message: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen w-full bg-[#09090B] text-[#F4F4F5] flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-2xl border border-[#D4AF37]/35 bg-[#121318] p-6 space-y-4 text-center shadow-2xl">
            <div className="mx-auto w-12 h-12 rounded-2xl bg-red-500/15 border border-red-500/40 flex items-center justify-center text-red-400">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <div className="space-y-1.5">
              <h1 className="text-lg font-display font-bold text-zinc-100">
                Application Recovery Required
              </h1>
              <p className="text-xs text-zinc-400 leading-relaxed break-words">
                {this.state.message}
              </p>
            </div>
            <div className="flex items-center justify-center gap-2.5 pt-1">
              <button
                type="button"
                onClick={this.handleReset}
                className="min-h-[42px] px-4 rounded-xl bg-[#D4AF37] text-[#09090B] text-xs font-semibold inline-flex items-center gap-2 hover:bg-[#F5D061] transition-colors cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Try Again</span>
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="min-h-[42px] px-4 rounded-xl bg-[#181A20] border border-[#D4AF37]/30 text-xs font-semibold text-zinc-200 hover:border-[#D4AF37]/55 transition-colors cursor-pointer"
              >
                Reload App
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
