import type { ReactNode, SVGProps } from 'react';

// A minimal, consistent outline icon set (24px grid, 1.75 stroke, currentColor).
// Hand-drawn paths kept deliberately simple and geometric — no filled shapes,
// no clip-art. Every icon inherits color from text, so they stay on-palette.

type IconProps = SVGProps<SVGSVGElement>;

function Base({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      width={18}
      height={18}
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

/* --- Navigation --- */
export const GaugeIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 13.5 15.5 9" />
    <path d="M4.5 17a8 8 0 1 1 15 0" />
    <circle cx="12" cy="13.5" r="1.1" fill="currentColor" stroke="none" />
  </Base>
);

export const LayersIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 3.5 20 8l-8 4.5L4 8l8-4.5Z" />
    <path d="M4 12.5 12 17l8-4.5" />
    <path d="M4 16.8 12 21l8-4.2" opacity="0.5" />
  </Base>
);

export const JobsIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="m4 7 1.6 1.6L8.6 5.5" />
    <path d="m4 15 1.6 1.6 3-3.1" />
    <path d="M12 7.5h8" />
    <path d="M12 15.5h8" />
  </Base>
);

export const WorkersIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="4" y="4.5" width="16" height="6" rx="1.6" />
    <rect x="4" y="13.5" width="16" height="6" rx="1.6" />
    <path d="M7.5 7.5h.01M7.5 16.5h.01" />
  </Base>
);

export const DeadLetterIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 8.5 12 13l8-4.5" />
    <path d="M4 8.2 6.2 5h11.6L20 8.2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8.2Z" />
    <path d="M12 15.4v.01" />
    <path d="M12 9.2v3.4" />
  </Base>
);

/* --- Login feature highlights --- */
export const NetworkIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="5" r="2.2" />
    <circle cx="5" cy="18" r="2.2" />
    <circle cx="19" cy="18" r="2.2" />
    <path d="M10.6 6.8 6.4 16.2M13.4 6.8l4.2 9.4M7.2 18h9.6" />
  </Base>
);

export const CalendarClockIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M5 5.5h14a1 1 0 0 1 1 1v3H4v-3a1 1 0 0 1 1-1Z" />
    <path d="M4 9.5v9a1 1 0 0 0 1 1h6.5" />
    <path d="M8 3.5v3M16 3.5v3" />
    <circle cx="17" cy="16" r="3.4" />
    <path d="M17 14.6V16l1 .9" />
  </Base>
);

export const ActivityIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M3.5 12.5h3.2l2-6 3.4 12 2.3-7.2 1.5 3.2h4.6" />
  </Base>
);

export const RetryIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M20 5.5v4h-4" />
    <path d="M19.2 13a7.2 7.2 0 1 1-1.6-5.9L20 9.5" />
  </Base>
);

/* --- Utility --- */
export const PlusIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 5v14M5 12h14" />
  </Base>
);

export const ArrowRightIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Base>
);

export const ChevronLeftIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="m14 6-6 6 6 6" />
  </Base>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="m10 6 6 6-6 6" />
  </Base>
);

export const CloseIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Base>
);

export const CheckIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Base>
);

export const SearchIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-3.5-3.5" />
  </Base>
);

export const ExternalLinkIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M14 5h5v5" />
    <path d="M19 5l-8 8" />
    <path d="M18 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 18V9a1.5 1.5 0 0 1 1.5-1.5H12" />
  </Base>
);

export const LogOutIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M14 8V6a1.5 1.5 0 0 0-1.5-1.5h-6A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5h6A1.5 1.5 0 0 0 14 18v-2" />
    <path d="M9.5 12H20m0 0-3-3m3 3-3 3" />
  </Base>
);

export const PauseIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M9 5.5v13M15 5.5v13" />
  </Base>
);

export const PlayIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M7.5 5.5v13l11-6.5-11-6.5Z" />
  </Base>
);

export const TrashIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M4.5 7h15M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" />
    <path d="M6.5 7 7 19a1.5 1.5 0 0 0 1.5 1.4h7A1.5 1.5 0 0 0 17 19l.5-12" />
  </Base>
);

export const InboxIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 13h4l1.5 2.5h5L16 13h4" />
    <path d="M4 13 6.2 5.5h11.6L20 13v4.5A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5V13Z" />
  </Base>
);

/* --- Brand mark --- */
// A compact geometric glyph: three stacked "queue" bars of decreasing length
// draining into a node — a scheduler in one shape. Solid rose on a soft tile.
export function CodityMark({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-[10px] bg-indigo-600 text-white shadow-soft ${className}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
        <path d="M5 8h10" opacity="0.95" />
        <path d="M5 12h7" opacity="0.8" />
        <path d="M5 16h4" opacity="0.65" />
        <circle cx="17.5" cy="14.5" r="2.3" fill="currentColor" stroke="none" />
      </svg>
    </span>
  );
}
