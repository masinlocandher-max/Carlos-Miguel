import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { ArrowUp, Mic, X } from 'lucide-react';
export function CommandBar({
  children,
  value,
  onChange,
  onSubmit,
  onVoice,
  onFocus,
  onBlur,
  busy,
  notice,
  clearNotice,
}: {
  children?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onVoice: () => void;
  onFocus: () => void;
  onBlur: () => void;
  busy: boolean;
  notice: string;
  clearNotice: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const zone = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = zone.current;
    const app = element?.closest<HTMLElement>('.app');
    if (!element || !app) return;
    const measure = () =>
      app.style.setProperty('--command-zone-height', `${element.getBoundingClientRect().height}px`);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => {
      observer.disconnect();
      app.style.removeProperty('--command-zone-height');
    };
  }, []);
  return (
    <div ref={zone} className="command-zone">
      {children}
      {notice && (
        <div className="command-notice glass" role="status">
          <p>{notice}</p>
          <button className="icon-button" aria-label="Dismiss message" onClick={clearNotice}>
            <X size={16} />
          </button>
        </div>
      )}
      <form
        className="command-bar glass"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
          input.current?.blur();
        }}
      >
        <span className="command-sigil" aria-hidden="true">
          J
        </span>
        <input
          ref={input}
          aria-label="Command Jewel"
          placeholder="Ask Jewel or give a command…"
          autoComplete="off"
          maxLength={1000}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          disabled={busy}
        />
        <button
          className="icon-button voice-button"
          type="button"
          aria-label="Voice profile and preview"
          onClick={onVoice}
        >
          <Mic size={19} />
        </button>
        <button
          className="send-button"
          type="submit"
          aria-label="Submit command"
          disabled={!value.trim() || busy}
        >
          <ArrowUp size={20} />
        </button>
      </form>
      <div className="command-hint">
        <span>Text commands available</span>
        <span>Voice · Not connected</span>
      </div>
    </div>
  );
}
