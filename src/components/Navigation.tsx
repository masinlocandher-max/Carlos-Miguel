import { useEffect, useRef } from 'react';
import {
  Home,
  Layers3,
  ListChecks,
  Github,
  Files,
  Database,
  ShieldCheck,
  AudioLines,
  X,
  ArrowUpRight,
} from 'lucide-react';
import { sections } from '../lib/model';
import type { Section } from '../lib/model';
const icons = [Home, Layers3, ListChecks, Github, Files, Database, ShieldCheck, AudioLines];
export function Navigation({
  open,
  current,
  onClose,
  onSelect,
}: {
  open: boolean;
  current: Section;
  onClose: () => void;
  onSelect: (section: Section) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog?.open) dialog?.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      id="navigation"
      className="navigation glass"
      aria-labelledby="nav-title"
      onCancel={onClose}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const rect = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < rect.left ||
            e.clientX > rect.right ||
            e.clientY < rect.top ||
            e.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <div className="drawer-head">
        <span id="nav-title" className="wordmark">
          JEWEL OS
        </span>
        <button className="icon-button" onClick={onClose} aria-label="Close navigation">
          <X />
        </button>
      </div>
      <p className="drawer-caption">Your executive workspace</p>
      <nav aria-label="Primary navigation">
        {sections.map((section, i) => {
          const Icon = icons[i];
          return (
            <button
              key={section}
              onClick={() => onSelect(section)}
              aria-current={current === section ? 'page' : undefined}
            >
              <Icon size={19} />
              <span>{section}</span>
              {current === section && <ArrowUpRight size={14} />}
            </button>
          );
        })}
      </nav>
      <div className="owner">
        <span className="monogram">FMB</span>
        <div>
          FMB<small>Private workspace · Preview</small>
        </div>
      </div>
    </dialog>
  );
}
