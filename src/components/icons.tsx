import type { JSX, SVGProps } from 'react';
import type { AgentKind, ServiceIcon } from '../shared/contract';

interface IconProps {
  readonly className?: string;
  readonly size?: number;
}

// Annotate the return type: without it TS widens strokeLinecap/strokeLinejoin
// to `string`, which is not assignable to SVGProps.
const base = (size: number): SVGProps<SVGSVGElement> => ({
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  width: size,
  height: size,
  'aria-hidden': true,
});

export function BotIcon({ className, size = 28 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2 2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" />
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <circle cx="9" cy="13" r="1.5" fill="currentColor" />
      <circle cx="15" cy="13" r="1.5" fill="currentColor" />
      <path d="M9 17h6" />
    </svg>
  );
}

/** agy (Antigravity): a lift, two chevrons up. Generic glyph, not the product's logo. */
export function AgyIcon({ className, size = 18 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <polyline points="17 11 12 6 7 11" />
      <polyline points="17 18 12 13 7 18" />
    </svg>
  );
}

/** Claude Code: code braces. Generic glyph, not the product's logo. */
export function ClaudeCodeIcon({ className, size = 18 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1" />
      <path d="M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />
    </svg>
  );
}

export function AgentKindIcon({ kind, className, size = 18 }: IconProps & { kind: AgentKind }): JSX.Element {
  return kind === 'agy' ? <AgyIcon className={className} size={size} /> : <ClaudeCodeIcon className={className} size={size} />;
}

export function NetworkIcon({ className, size = 28 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <rect x="2" y="2" width="6" height="6" rx="1" />
      <rect x="16" y="2" width="6" height="6" rx="1" />
      <rect x="9" y="16" width="6" height="6" rx="1" />
      <path d="M5 8v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
      <path d="M12 13v3" />
    </svg>
  );
}

export function ActivityIcon({ className, size = 28 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}

export function MonitorIcon({ className, size = 28 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

export function CpuIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <line x1="9" y1="1" x2="9" y2="4" />
      <line x1="15" y1="1" x2="15" y2="4" />
      <line x1="9" y1="20" x2="9" y2="23" />
      <line x1="15" y1="20" x2="15" y2="23" />
      <line x1="20" y1="9" x2="23" y2="9" />
      <line x1="20" y1="14" x2="23" y2="14" />
      <line x1="1" y1="9" x2="4" y2="9" />
      <line x1="1" y1="14" x2="4" y2="14" />
    </svg>
  );
}

export function MemoryIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M2 2h20v20H2z" />
      <path d="M6 6h12v12H6z" />
    </svg>
  );
}

export function DiskIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}

export function ClockIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

export function SearchIcon({ size = 14 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

export function SunIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

export function MoonIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

export function CopyIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function EyeIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function EyeOffIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M10.6 5.1A9.9 9.9 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.4 3.4M6.6 6.6C3.7 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  );
}

export function PanelLeftIcon({ size = 15 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

export function TerminalIcon({ size = 18 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

export function SlidersIcon({ size = 18 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="9" cy="6" r="2" fill="var(--bg, #0b0d10)" />
      <circle cx="15" cy="12" r="2" fill="var(--bg, #0b0d10)" />
      <circle cx="8" cy="18" r="2" fill="var(--bg, #0b0d10)" />
    </svg>
  );
}

/** Icon for a dashboard view. The collapsed sidebar rail shows these. */
export function ViewIcon({ view, size = 18 }: { readonly view: string; readonly size?: number }): JSX.Element {
  switch (view) {
    case 'overview':
      return <MonitorIcon size={size} />;
    case 'applications':
      return <BoxesIcon size={size} />;
    case 'trends':
      return <ActivityIcon size={size} />;
    case 'hardware':
      return <CpuIcon size={size} />;
    case 'workload':
      return <ServerIcon size={size} />;
    case 'capacity':
      return <HardDriveIcon size={size} />;
    case 'reach-and-spend':
      return <NetworkIcon size={size} />;
    case 'logs-and-control':
      return <SlidersIcon size={size} />;
    case 'files':
      return <FolderIcon size={size} />;
    case 'users':
      return <UsersIcon size={size} />;
    case 'chat':
      return <ChatIcon size={size} />;
    default:
      return <TerminalIcon size={size} />;
  }
}

export function FolderIcon({ className, size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
    </svg>
  );
}

export function FolderPlusIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
      <path d="M12 11v5M9.5 13.5h5" />
    </svg>
  );
}

export function FileIcon({ className, size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

export function UploadIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </svg>
  );
}

export function DownloadIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M12 4v12M7 11l5 5 5-5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </svg>
  );
}

export function PencilIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z" />
    </svg>
  );
}

export function LogOutIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
    </svg>
  );
}

/** A file going round: overwrite what is there. */
export function FileReplaceIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5" />
      <path d="M15 14.5a3 3 0 1 1-.9-2.1M15 11.5v2h-2" />
    </svg>
  );
}

export function WarningIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M10.3 3.9 2.4 17.5a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01" />
    </svg>
  );
}

export function TrashIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1.5 1.5 0 0 0 1.5 1.4h7a1.5 1.5 0 0 0 1.5-1.4L18 7M9 7V4.5A.5.5 0 0 1 9.5 4h5a.5.5 0 0 1 .5.5V7" />
    </svg>
  );
}

export function UsersIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20v-1a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v1M16 4.2a3.5 3.5 0 0 1 0 6.6M18 14.2a5 5 0 0 1 3 4.8v1" />
    </svg>
  );
}

export function HomeIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M4 11l8-7 8 7v8.5a.5.5 0 0 1-.5.5H15v-6H9v6H4.5a.5.5 0 0 1-.5-.5z" />
    </svg>
  );
}

export function CheckIcon({ className, size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} strokeWidth={2.5}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function ArrowUpRightIcon({ size = 14 }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} width={size} height={size} aria-hidden>
      <line x1="7" y1="17" x2="17" y2="7" />
      <polyline points="7 7 17 7 17 17" />
    </svg>
  );
}

export function LinkIcon({ size = 13 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
    </svg>
  );
}

export function ServerIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  );
}

export function ChevronDownIcon({ className, size = 14 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} strokeWidth={2.5} className={className}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/** Notification bell for the navbar alert indicator. */
export function BellIcon({ className, size = 17 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

export function ClipboardIcon({ size = 17 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </svg>
  );
}

export function RefreshIcon({ size = 17 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
    </svg>
  );
}

export function ArrowDownIcon({ className, size = 12 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} strokeWidth={2.5} className={className}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </svg>
  );
}

export function ArrowUpIcon({ className, size = 12 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} strokeWidth={2.5} className={className}>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

export function CpuGridIcon({ className, size = 18 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <rect x="3" y="3" width="3" height="3" rx="1" />
      <rect x="18" y="3" width="3" height="3" rx="1" />
      <rect x="3" y="18" width="3" height="3" rx="1" />
      <rect x="18" y="18" width="3" height="3" rx="1" />
      <path d="M12 2v5M12 17v5M2 12h5M17 12h5" />
    </svg>
  );
}

export function BoxesIcon({ className, size = 18 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 2 3 7v10l9 5 9-5V7z" />
      <path d="M3 7l9 5 9-5" />
      <path d="M12 12v10" />
    </svg>
  );
}

export function HardDriveIcon({ className, size = 18 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <line x1="3" y1="12" x2="21" y2="12" />
      <path d="M5.5 5h13l2.5 7v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z" />
      <line x1="7" y1="16" x2="7.01" y2="16" />
    </svg>
  );
}

export function SwapIcon({ className, size = 18 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <polyline points="7 4 3 8 7 12" />
      <polyline points="17 20 21 16 17 12" />
      <line x1="4" y1="8" x2="20" y2="16" />
    </svg>
  );
}

const REGISTRY: Record<ServiceIcon, (props: IconProps) => JSX.Element> = {
  bot: BotIcon,
  network: NetworkIcon,
  activity: ActivityIcon,
  monitor: MonitorIcon,
  terminal: TerminalIcon,
  server: ServerIcon,
  boxes: BoxesIcon,
};

export function ServiceIconGlyph({ icon, size = 28 }: { icon: ServiceIcon; size?: number }): JSX.Element {
  const Component = REGISTRY[icon];
  return <Component size={size} />;
}
export function ChatIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z" />
    </svg>
  );
}

export function PlusIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function SendIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

export function StopIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  );
}

/** Leave full screen: the chat shrinks back to its floating button. */
export function MinimizeIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
    </svg>
  );
}

export function MoreIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <circle cx="5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <circle cx="19" cy="12" r="1.2" fill="currentColor" />
    </svg>
  );
}

export function ListIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
    </svg>
  );
}

export function ForkIcon({ className, size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="18" cy="5" r="2.2" />
      <circle cx="12" cy="19" r="2.2" />
      <path d="M6 7.2v1.3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7.2M12 11.5v5.3" />
    </svg>
  );
}

export function MicIcon({ className, size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <rect x="9" y="2.5" width="6" height="12" rx="3" />
      <path d="M5 11.5a7 7 0 0 0 14 0M12 18.5v3" />
    </svg>
  );
}

export function PaperclipIcon({ className, size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="m21 11.2-8.6 8.6a5.2 5.2 0 0 1-7.4-7.4l8.8-8.8a3.5 3.5 0 0 1 5 5l-8.8 8.8a1.8 1.8 0 0 1-2.5-2.5l8-8" />
    </svg>
  );
}

export function PinIcon({ className, size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6zM12 14v7" />
    </svg>
  );
}

export function ArchiveIcon({ className, size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <rect x="3" y="4" width="18" height="4.5" rx="1" />
      <path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5M10 12.5h4" />
    </svg>
  );
}

export function PlayIcon({ className, size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M7 4.5v15l12-7.5-12-7.5z" fill="currentColor" />
    </svg>
  );
}

export function XIcon({ className, size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}
