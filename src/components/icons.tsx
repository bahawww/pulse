import type { JSX, SVGProps } from 'react';
import type { ServiceIcon } from '../shared/contract';

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
    default:
      return <TerminalIcon size={size} />;
  }
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
};

export function ServiceIconGlyph({ icon, size = 28 }: { icon: ServiceIcon; size?: number }): JSX.Element {
  const Component = REGISTRY[icon];
  return <Component size={size} />;
}