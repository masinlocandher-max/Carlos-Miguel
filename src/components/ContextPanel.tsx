import { useEffect, useState } from 'react';
import {
  CalendarDays,
  ShieldCheck,
  ArrowUpRight,
  Mail,
  Calendar,
  Github,
  Folder,
  Database,
  AudioLines,
  Layers3,
  ListChecks,
  Files,
  Play,
  Square,
  X,
  Workflow,
  Cpu,
} from 'lucide-react';
import type { Section, JewelState } from '../lib/model';
import { sections, stateLabel } from '../lib/model';
import type { Runtime } from '../lib/useJewel.ts';
import { RuntimeStrip, ApprovalsPanel, TasksPanel, MemoryPanel, NotWired } from './LivePanels.tsx';
const integrations = [
  { label: 'Email', Icon: Mail },
  { label: 'Calendar', Icon: Calendar },
  { label: 'Notion', Icon: Database },
  { label: 'Google Drive', Icon: Folder },
  { label: 'GitHub', Icon: Github },
  { label: 'OpenAI', Icon: Cpu },
];
const emptyContent: Partial<
  Record<Section, { Icon: typeof Folder; title: string; copy: string; source: string }>
> = {
  Projects: {
    Icon: Layers3,
    title: 'Space for your next move.',
    copy: 'Your projects will appear here when your workspace is connected.',
    source: 'Project source · Notion',
  },
  'Tasks & Approvals': {
    Icon: ListChecks,
    title: 'A clear view of what matters.',
    copy: 'Tasks and their approval status will appear here. No task data is loaded.',
    source: 'Task source · Notion',
  },
  GitHub: {
    Icon: Github,
    title: 'Your code, within reach.',
    copy: 'Repository activity will appear here after GitHub is connected to Jewel.',
    source: 'Repository connection · Not configured',
  },
  'Files & Assets': {
    Icon: Files,
    title: 'Everything in its place.',
    copy: 'Approved files and assets will appear here when Google Drive is connected.',
    source: 'File source · Google Drive',
  },
  'Memory Vault': {
    Icon: Database,
    title: 'Continuity starts here.',
    copy: 'Source-linked memory will appear here after authenticated retrieval is configured.',
    source: 'Knowledge sources · Notion and Drive',
  },
  'Approval Queue': {
    Icon: ShieldCheck,
    title: 'Your decision comes first.',
    copy: 'No items loaded. Future actions will show their exact details here before approval.',
    source: 'Approval service · Not configured',
  },
};
/** Report what is actually connected, rather than a blanket "not connected". */
function providerStatus(tool: string, runtime: Runtime): string {
  const providers = runtime.status?.providers;
  if (!providers) return `${tool} status is unavailable while the runtime is unreachable.`;
  const map: Record<string, boolean | undefined> = {
    Email: providers.google,
    Calendar: providers.google,
    Notion: providers.notion,
    'Google Drive': providers.google,
    GitHub: providers.github,
    OpenAI: undefined,
  };
  const connected = map[tool];
  if (connected === undefined) return `${tool} connection is reported by \`jewel doctor\`, not here.`;
  return connected
    ? `${tool} is connected. Jewel can read it; acting still needs your approval.`
    : `${tool} is not connected. Jewel will say so rather than guess.`;
}

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <>
      <div className="panel-heading">
        <span>Today</span>
        <CalendarDays size={16} />
      </div>
      <div className="clock">
        <time dateTime={now.toISOString()}>
          {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
        </time>
        <span>LOCAL TIME</span>
      </div>
      <p className="date">
        {now.toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' })}
      </p>
    </>
  );
}
export function ContextPanel({
  section,
  state,
  demo,
  onNavigate,
  onPreview,
  onStop,
  onHide,
  activity,
  runtime,
}: {
  section: Section;
  state: JewelState;
  demo: boolean;
  onNavigate: (section: Section) => void;
  onPreview: () => void;
  onStop: () => void;
  onHide: () => void;
  activity: string;
  runtime: Runtime;
}) {
  const [tool, setTool] = useState<string | null>(null);
  const empty = emptyContent[section];
  return (
    <aside className="context-panel" aria-label="Context panel">
      <div className="context-heading">
        <span>{section === sections[0] ? 'AT A GLANCE' : section.toUpperCase()}</span>
        <button className="icon-button" onClick={onHide} aria-label="Hide context panel">
          <X size={16} />
        </button>
      </div>
      {section === sections[0] ? (
        <>
          <section className="glass panel today-panel">
            <Clock />
            <div className="schedule-empty">
              <span className="timeline-dot" />
              <p>
                Your schedule will appear here<small>Calendar not connected</small>
              </p>
            </div>
          </section>
          <RuntimeStrip runtime={runtime} />
          <div className="live-approvals">
            <ApprovalsPanel runtime={runtime} compact />
            <button
              className="text-button"
              onClick={() => onNavigate('Approval Queue')}
              aria-label="Open approval queue"
            >
              Open approval queue <ArrowUpRight size={16} />
            </button>
          </div>
          <section className="glass panel">
            <div className="panel-heading">
              <span>Tools</span>
              <span className="micro">Preview</span>
            </div>
            <div className="tool-grid">
              {integrations.map(({ label, Icon }) => (
                <button
                  key={label}
                  onClick={() => setTool(tool === label ? null : label)}
                  aria-expanded={tool === label}
                >
                  <Icon size={17} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
            {tool && (
              <p className="tool-detail" role="status">
                {providerStatus(tool, runtime)}
              </p>
            )}
          </section>
          <section className="glass panel activity-panel">
            <div className="panel-heading">
              <span>
                <Workflow size={16} /> Recent activity
              </span>
            </div>
            <p className="empty-line">{activity || 'Activity will appear here'}</p>
          </section>
        </>
      ) : section === 'Voice Profile' ? (
        <section className="glass panel voice-profile">
          <AudioLines className="empty-icon" />
          <h2>
            One Jewel.
            <br />
            Every state.
          </h2>
          <p className="supporting">
            Neutral development core, from quiet attention to completion.
          </p>
          <ol className="state-list">
            {(['idle', 'listening', 'thinking', 'executing', 'complete'] as JewelState[]).map(
              (s, i) => (
                <li key={s} className={state === s ? 'selected' : ''}>
                  <span>0{i + 1}</span>
                  <div>
                    {stateLabel[s]}
                    {s === 'executing' && <small>Controlled execution</small>}
                  </div>
                  <i />
                </li>
              ),
            )}
          </ol>
          <button className="outline-button" onClick={demo ? onStop : onPreview}>
            {demo ? <Square size={15} /> : <Play size={15} />}{' '}
            {demo ? 'Stop preview' : 'Preview state sequence'}
          </button>
          <p className="preview-note">
            Visual demonstration only. No microphone access or external actions.
          </p>
          <div className="voice-settings">
            <span>Voice connection</span>
            <strong>Not configured</strong>
          </div>
        </section>
      ) : section === 'Approval Queue' ? (
        <ApprovalsPanel runtime={runtime} />
      ) : section === 'Tasks & Approvals' ? (
        <TasksPanel runtime={runtime} />
      ) : section === 'Memory Vault' ? (
        <MemoryPanel runtime={runtime} />
      ) : empty ? (
        <section className="glass panel section-empty">
          <empty.Icon className="empty-icon" />
          <h2>{empty.title}</h2>
          <p className="supporting">{empty.copy}</p>
          <div className="source-note">{empty.source}</div>
          <NotWired connection={runtime.connection} />
          <button className="text-button" onClick={() => onNavigate(sections[0])}>
            Back to command center <ArrowUpRight size={16} />
          </button>
        </section>
      ) : null}
    </aside>
  );
}
