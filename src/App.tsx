import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Menu,
  Maximize2,
  Minimize2,
  PanelRight,
  AudioLines,
  ListChecks,
  Search,
  ArrowUpRight,
} from 'lucide-react';
import { JewelCore } from './components/JewelCore';
import { Navigation } from './components/Navigation';
import { ContextPanel } from './components/ContextPanel';
import { CommandBar } from './components/CommandBar';
import { parseCommand, sections, stateLabel } from './lib/model';
import type { Section, JewelState } from './lib/model';
import { useJewel } from './lib/useJewel.ts';
import { routeCommand, describeTurn, describeError, actionLine } from './lib/runtime.ts';
export default function App() {
  const [navOpen, setNavOpen] = useState(false);
  const [focus, setFocus] = useState(false);
  const [contextOpen, setContextOpen] = useState(() => window.innerWidth > 900);
  const [section, setSection] = useState<Section>(sections[0]);
  const [state, setState] = useState<JewelState>('idle');
  const [command, setCommand] = useState('');
  const [notice, setNotice] = useState('');
  const [activity, setActivity] = useState('');
  const [demo, setDemo] = useState(false);
  const [running, setRunning] = useState(false);
  const [answer, setAnswer] = useState('');
  const timers = useRef<number[]>([]);
  const runtime = useJewel();
  const menuButton = useRef<HTMLButtonElement>(null);
  const stopDemo = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setDemo(false);
    setRunning(false);
    setState('idle');
  }, []);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !navOpen) {
        stopDemo();
        setFocus(false);
        setNotice('');
        setAnswer('');
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [navOpen, stopDemo]);
  const navigate = (target: Section) => {
    setSection(target);
    setNavOpen(false);
    setContextOpen(true);
    setFocus(false);
    setActivity(`Opened ${target === sections[0] ? 'Command Center' : target}`);
    document.title = `Jewel OS · ${target === sections[0] ? 'Command Center' : target}`;
  };
  const preview = () => {
    stopDemo();
    setDemo(true);
    setState('idle');
    setNotice('State preview. No external action is being performed.');
    const sequence: [number, JewelState][] = [
      [2200, 'listening'],
      [5200, 'thinking'],
      [8800, 'executing'],
      [11800, 'complete'],
      [14500, 'idle'],
    ];
    sequence.forEach(([delay, next]) =>
      timers.current.push(
        window.setTimeout(() => {
          setState(next);
          if (next === 'idle') {
            setDemo(false);
            setActivity('Visual state preview finished');
            setNotice('Visual preview finished. Jewel has returned to idle.');
          }
        }, delay),
      ),
    );
  };
  /**
   * Local chrome commands (navigate, focus) stay instant and offline.
   * Everything else is real work and goes to Jewel through the control API,
   * where policy, approval binding, idempotency and audit all apply.
   */
  const submit = () => {
    if (demo || running) return;
    const intent = parseCommand(command);
    const route = routeCommand(command, intent.type !== 'unsupported', runtime.connection);

    if (route.kind === 'blocked') {
      setNotice(route.reason);
      return;
    }

    stopDemo();
    setCommand('');
    setNotice('');
    setAnswer('');

    if (route.kind === 'local') {
      setRunning(true);
      setState('executing');
      if (intent.type === 'navigate') navigate(intent.section);
      else if (intent.type === 'focus') {
        setFocus(intent.enabled);
        setNavOpen(false);
        setActivity(intent.enabled ? 'Entered Focus Mode' : 'Exited Focus Mode');
      }
      timers.current.push(
        window.setTimeout(() => {
          setState('complete');
          timers.current.push(
            window.setTimeout(() => {
              setState('idle');
              setRunning(false);
            }, 1200),
          );
        }, 500),
      );
      return;
    }

    setRunning(true);
    setState('thinking');

    void (async () => {
      try {
        const turn = await runtime.ask(route.request);
        const described = describeTurn(turn);

        setState('executing');
        setAnswer(described.answer);
        setNotice(described.notice);
        setActivity(
          turn.actions.length ? turn.actions.map(actionLine).join(' · ') : `Answered · ${turn.steps} step(s)`,
        );

        timers.current.push(
          window.setTimeout(() => {
            setState('complete');
            timers.current.push(
              window.setTimeout(() => {
                setState('idle');
                setRunning(false);
              }, 1800),
            );
          }, 600),
        );
      } catch (err) {
        // A failure must never look like a quiet success.
        setState('idle');
        setRunning(false);
        setAnswer('');
        setNotice(describeError(err));
        setActivity('Request failed');
      }
    })();
  };

  const statusCopy = demo
    ? `${stateLabel[state]} · Visual preview`
    : running
      ? `${stateLabel[state]} · ${runtime.connection.label}`
      : state === 'listening'
        ? 'Receiving your text.'
        : runtime.connection.operational
          ? `Ready when you are. · ${runtime.connection.label}`
          : runtime.connection.label;
  return (
    <div
      className={`app ${focus ? 'focus-mode' : ''} ${contextOpen ? '' : 'context-hidden'}`}
      data-state={state}
    >
      <header className="topbar">
        <div className="brand-group">
          <button
            ref={menuButton}
            className="icon-button menu-toggle"
            aria-label="Open navigation"
            aria-controls="navigation"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(true)}
          >
            <Menu size={21} />
          </button>
          <div>
            <span className="wordmark">JEWEL OS</span>
            <span className="brand-subtitle">PRIVATE EXECUTIVE ASSISTANT</span>
          </div>
        </div>
        <div className="header-controls">
          <span className="preview-badge">DESIGN PREVIEW</span>
          <button
            className="icon-button"
            onClick={() => {
              setContextOpen(!contextOpen);
              setFocus(false);
            }}
            aria-label={contextOpen && !focus ? 'Hide dashboard panels' : 'Show dashboard panels'}
            aria-pressed={contextOpen && !focus}
          >
            <PanelRight size={18} />
          </button>
          <button
            className="focus-button"
            aria-pressed={focus}
            onClick={() => {
              setFocus(!focus);
              setNavOpen(false);
            }}
          >
            {focus ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            <span>{focus ? 'Exit Focus' : 'Focus Mode'}</span>
          </button>
        </div>
      </header>
      <main>
        <div className="greeting">
          <p>COMMAND CENTER</p>
          <h1>Welcome, FMB.</h1>
        </div>
        <JewelCore state={state} />
        {contextOpen && !focus && (
          <ContextPanel
            section={section}
            state={state}
            demo={demo}
            onNavigate={navigate}
            onPreview={preview}
            onStop={stopDemo}
            onHide={() => setContextOpen(false)}
            activity={activity}
          runtime={runtime}
          />
        )}
        <CommandBar
          value={command}
          onChange={setCommand}
          onSubmit={submit}
          onVoice={() => navigate('Voice Profile')}
          onFocus={() => {
            if (!demo && !running) setState('listening');
          }}
          onBlur={() => {
            if (!demo && !running)
              setState((previous) => (previous === 'listening' ? 'idle' : previous));
          }}
          busy={demo || running}
          notice={notice}
          clearNotice={() => setNotice('')}
        >
          {answer && (
            <div className="jewel-answer" role="status" aria-live="polite">
              <p>{answer}</p>
              <button
                className="text-button"
                onClick={() => setAnswer('')}
                aria-label="Dismiss Jewel's answer"
              >
                Dismiss
              </button>
            </div>
          )}
          {!notice && !answer && (
            <>
              <div className="core-caption">
                <span className="core-name">JEWEL</span>
                <p aria-live="polite">{statusCopy}</p>
              </div>
              <div className="quick-actions" aria-label="Quick actions">
                <button
                  onClick={() => {
                    navigate(sections[0]);
                    if (runtime.connection.operational) {
                      setCommand('Brief me on what needs my attention today.');
                    } else {
                      setNotice(runtime.connection.detail);
                    }
                  }}
                >
                  <ArrowUpRight size={16} />
                  Brief me
                </button>
                <button onClick={() => navigate('Tasks & Approvals')}>
                  <ListChecks size={16} />
                  Review tasks
                </button>
                <button onClick={() => navigate('Files & Assets')}>
                  <Search size={16} />
                  Find a file
                </button>
              </div>
            </>
          )}
        </CommandBar>
      </main>
      <footer className="statusbar">
        <span>
          <i className="status-dot" />
          Preview mode
        </span>
        <span>
          <AudioLines size={16} />
          {demo ? 'Visual sequence playing' : 'Voice not connected'}
        </span>
        <span>{demo || running ? stateLabel[state] : 'Awaiting command'}</span>
      </footer>
      <Navigation
        open={navOpen}
        current={section}
        onSelect={navigate}
        onClose={() => {
          setNavOpen(false);
          menuButton.current?.focus();
        }}
      />
    </div>
  );
}
