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
