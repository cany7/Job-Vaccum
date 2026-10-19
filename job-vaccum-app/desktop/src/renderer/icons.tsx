import type { ReactNode } from "react";

function Icon({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const SidebarIcon = () => (
  <Icon>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
    <path d="M6 2.75v10.5M3.5 5.5h0.5M3.5 7.5h0.5" />
  </Icon>
);

export const SearchIcon = () => (
  <Icon size={14}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.25 10.25 3 3" />
  </Icon>
);

export const JobsIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <circle cx="8" cy="8" r="5.75" />
    <circle cx="8" cy="8" r="2.5" />
  </Icon>
);

export const ShortlistIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8" />
    <path d="M2.5 4.5h0.25M2.5 8h0.25M2.5 11.5h0.25" strokeWidth="1.8" />
  </Icon>
);

export const SettingsIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="2.25" />
    <path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05" />
  </Icon>
);

export const WarningIcon = () => (
  <Icon size={32}>
    <path d="M8 2.25 14.25 13.25H1.75Z" strokeWidth="1.1" />
    <path d="M8 6.5v3" strokeWidth="1.2" />
    <path d="M8 11.4v0.1" strokeWidth="1.5" />
  </Icon>
);

export const StoppedIcon = () => (
  <Icon size={32}>
    <path d="M8 2v5.5" strokeWidth="1.1" />
    <path d="M4.75 4.25a5.25 5.25 0 1 0 6.5 0" strokeWidth="1.1" />
  </Icon>
);

export const SearchesIcon = () => (
  <Icon>
    <path d="M3 5.25h10M3 8h10M3 10.75h6" />
    <circle cx="12" cy="11" r="1.75" />
  </Icon>
);

export const ChevronDown = ({ size = 10 }: { size?: number }) => (
  <Icon size={size}>
    <path d="m4 6 4 4 4-4" strokeWidth="1.8" />
  </Icon>
);

export const ChevronLeft = () => (
  <Icon size={14}>
    <path d="m10 3.5-4.5 4.5 4.5 4.5" strokeWidth="1.6" />
  </Icon>
);

export const ChevronRight = () => (
  <Icon size={14}>
    <path d="m6 3.5 4.5 4.5-4.5 4.5" strokeWidth="1.6" />
  </Icon>
);

export const ArrowUp = () => (
  <Icon size={14}>
    <path d="M8 13V3.5M3.75 7.5 8 3.25l4.25 4.25" strokeWidth="1.5" />
  </Icon>
);

export const ArrowDown = () => (
  <Icon size={14}>
    <path d="M8 3v9.5M3.75 8.5 8 12.75l4.25-4.25" strokeWidth="1.5" />
  </Icon>
);

export const CloseIcon = ({ size = 14 }: { size?: number }) => (
  <Icon size={size}>
    <path d="m4 4 8 8M12 4l-8 8" strokeWidth="1.5" />
  </Icon>
);

export const ExternalIcon = () => (
  <Icon size={11}>
    <path d="M5.5 3.5h7v7M12.25 3.75 4 12" strokeWidth="1.6" />
  </Icon>
);

export const CheckIcon = ({ size = 12 }: { size?: number }) => (
  <Icon size={size}>
    <path d="m3.5 8.5 3 3 6-7" strokeWidth="1.8" />
  </Icon>
);

export const GripIcon = () => (
  <Icon size={14}>
    <path d="M6 4h0.01M10 4h0.01M6 8h0.01M10 8h0.01M6 12h0.01M10 12h0.01" strokeWidth="2.2" />
  </Icon>
);

export const AlertIcon = () => (
  <Icon size={14}>
    <path d="M8 2.25 14.25 13.25H1.75Z" strokeWidth="1.3" />
    <path d="M8 6.5v3" strokeWidth="1.4" />
    <path d="M8 11.4v0.1" strokeWidth="1.7" />
  </Icon>
);
