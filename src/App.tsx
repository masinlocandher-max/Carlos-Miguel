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
  const timers = useRef<number[]>([]);
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
  const submit = () => {
    if (!command.trim() || demo || running) return;
    const intent = parseCommand(command);
    stopDemo();
    setRunning(true);
    setState('thinking');
    setCommand('');
    setNotice('');
    timers.current.push(
      window.setTimeout(() => {
        if (intent.type === 'unsupported') {
          setNotice(
            'This is the interface preview. Try “open projects”, “open files”, or “focus mode”. AI responses and connected actions are not available yet.',
          );
          setState('idle');
          setRunning(false);
          return;
        }
        setState('executing');
        // This state is tied to a real local UI operation, never an external action.
        if (intent.type === 'navigate') navigate(intent.section);
        else {
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
              }, 1800),
            );
          }, 1000),
        );
      }, 1400),
    );
  };
  const statusCopy = demo
    ? `${stateLabel[state]} · Visual preview`
    : running
      ? `${stateLabel[state]} · Local command`
      : state === 'listening'
        ? 'Receiving your text.'
        : 'Ready when you are.';
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
        <div className="core-caption">
          <span className="core-name">JEWEL</span>
          <p aria-live="polite">{statusCopy}</p>
        </div>
        <div className="quick-actions" aria-label="Quick actions">
          <button
            onClick={() => {
              navigate(sections[0]);
              setNotice(
                'Your daily brief will be available after email, calendar, and task sources are connected.',
              );
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
        />
      </main>
      <footer className="statusbar">
        <span>
          <i className="status-dot" />
          Preview mode
        </span>
        <span>
          <AudioLines size={16} />
          {demo ? 'Visual sequence playing' : 'Voice standby'}
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
