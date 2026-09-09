export const sections = [
  'Home / Command Center',
  'Projects',
  'Tasks & Approvals',
  'GitHub',
  'Files & Assets',
  'Memory Vault',
  'Approval Queue',
  'Voice Profile',
] as const;
export type Section = (typeof sections)[number];
export type JewelState = 'idle' | 'listening' | 'thinking' | 'executing' | 'complete';
export const states: JewelState[] = ['idle', 'listening', 'thinking', 'executing', 'complete'];
export const stateLabel: Record<JewelState, string> = {
  idle: 'At rest',
  listening: 'Listening',
  thinking: 'Thinking',
  executing: 'Executing',
  complete: 'Complete',
};
export type LocalIntent =
  | { type: 'navigate'; section: Section }
  | { type: 'focus'; enabled: boolean }
  | { type: 'unsupported' };
// A narrow local command router, not a model or a provider action executor.
export function parseCommand(input: string): LocalIntent {
  const value = input
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ');
  if (['focus', 'focus mode', 'enter focus mode'].includes(value))
    return { type: 'focus', enabled: true };
  if (['exit focus', 'exit focus mode', 'show dashboard'].includes(value))
    return { type: 'focus', enabled: false };
  const target = value.replace(/^(open|show|go to) /, '');
  const aliases: Record<string, Section> = {
    home: sections[0],
    'command center': sections[0],
    projects: sections[1],
    tasks: sections[2],
    'tasks & approvals': sections[2],
    'review tasks': sections[2],
    github: sections[3],
    files: sections[4],
    'files & assets': sections[4],
    'find a file': sections[4],
    memory: sections[5],
    'memory vault': sections[5],
    approvals: sections[6],
    'approval queue': sections[6],
    voice: sections[7],
    'voice profile': sections[7],
  };
  return aliases[target] ? { type: 'navigate', section: aliases[target] } : { type: 'unsupported' };
}
