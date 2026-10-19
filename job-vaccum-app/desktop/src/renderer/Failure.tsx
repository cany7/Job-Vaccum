import { useEffect, useRef } from "react";
import type { AppInfo, ConnectionState, JobVaccumApi } from "./api";
import { StoppedIcon, WarningIcon } from "./icons";

interface Explained {
  title: string;
  reason: string;
  code?: string;
}

/**
 * Startup messages are backend stderr ("ERROR BUSY: …") or Electron main text.
 * Known codes get a readable reason and fix; anything else is shown as written.
 */
export function explainStartup(message: string): Explained {
  const lines = message.trim().split("\n");
  const match = /\b([A-Z][A-Z_]{2,}):\s/.exec(lines[lines.length - 1] ?? "");
  switch (match?.[1]) {
    case "BUSY":
      return {
        title: "Job Vaccum is already using its data",
        reason: "Another copy of the backend has this data folder open. Quit other copies of Job Vaccum, then open it again.",
        code: "BUSY",
      };
    case "STARTUP_ERROR":
      return {
        title: "Job Vaccum can't open its data",
        reason:
          "The data folder can't be read or written, or its database is damaged or from a newer version of Job Vaccum. Check the folder's permissions, or move the data folder aside to start fresh.",
        code: "STARTUP_ERROR",
      };
    default:
      return { title: "Job Vaccum couldn't start", reason: message.trim() || "The local backend did not start." };
  }
}

function Quit({ api }: { api: JobVaccumApi }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => button.current?.focus(), []);
  return (
    <button ref={button} type="button" className="button button-primary" onClick={() => void api.quit()}>
      Quit Job Vaccum
    </button>
  );
}

/** Whole-window page: reason first, data folder, Quit, then the code in small text. */
export function StartupFailure({ api, message, info }: { api: JobVaccumApi; message: string; info: AppInfo | null }) {
  const { title, reason, code } = explainStartup(message);
  return (
    <div className="failure-window">
      <div className="drag-strip" />
      <main className="failure" role="alert" aria-labelledby="failure-title">
        <span className="failure-icon failure-icon-error">
          <WarningIcon />
        </span>
        <h1 id="failure-title">{title}</h1>
        <p className="failure-reason">{reason}</p>
        {info ? (
          <div className="failure-folder">
            <span className="path">{info.data_dir}</span>
            <button type="button" className="button" onClick={() => void api.showDataFolder()}>
              Show in Finder
            </button>
          </div>
        ) : null}
        <Quit api={api} />
        {code ? <p className="error-code">{code}</p> : null}
      </main>
    </div>
  );
}

/** Replaces the card content while the rest of the shell is inert. */
export function BackendStopped({ api, state }: { api: JobVaccumApi; state: Extract<ConnectionState, { phase: "exited" }> }) {
  const detail = state.signal !== null ? `signal ${state.signal}` : `code ${state.exit_code ?? "unknown"}`;
  return (
    <div className="failure" role="alertdialog" aria-modal="true" aria-labelledby="stopped-title" aria-describedby="stopped-reason">
      <span className="failure-icon">
        <StoppedIcon />
      </span>
      <h1 id="stopped-title">Job Vaccum's backend stopped</h1>
      <p className="failure-reason" id="stopped-reason">
        Your saved data is safe. Quit and reopen Job Vaccum to continue.
      </p>
      <Quit api={api} />
      <p className="error-code">BACKEND_EXITED · {detail}</p>
    </div>
  );
}
