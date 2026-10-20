import MarkdownIt from "markdown-it";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { ApiError, ApplicationStatus, JobDetail } from "./api";
import { formatDay, formatPosted, formatSalary, formatTime, jobTypeLabel, siteLabel } from "./format";
import { ArrowDown, ArrowUp, CheckIcon, CloseIcon, ExternalIcon } from "./icons";
import { ScoreChip, StatusPicker } from "./JobTable";
import type { ListPage } from "./listModel";
import { DETAIL_DEFAULT, DETAIL_MIN } from "./prefs";
import { ErrorText } from "./Settings";

// JobSpy stores JDs as Markdown. Raw HTML is never rendered and images are not
// fetched; links are opened by the main process in the default browser.
const markdown = new MarkdownIt({ html: false, linkify: true, typographer: false }).disable(["image"]);

/** Posting link: the direct application link when known, otherwise the platform page. */
export function postingUrl(job: Pick<JobDetail, "sources"> & Partial<Pick<JobDetail, "links">>) {
  if (job.links) return job.links.job_url_direct ?? job.links.job_url;
  const source = job.sources.find((item) => item.direct_url) ?? job.sources.find((item) => item.url);
  return source?.direct_url ?? source?.url ?? null;
}

function scoreLine(job: JobDetail) {
  const when = job.scored_at ? `${formatTime(job.scored_at)}${job.score_model ? ` · ${job.score_model}` : ""}` : "";
  switch (job.score_state) {
    case "unscored":
      return job.score != null ? `Scored ${when}` : "Not scored";
    case "pending":
      return "Queued for scoring";
    case "running":
      return "Scoring now";
    case "succeeded":
      return `Scored ${when}`;
    case "failed":
      return job.score != null ? `${job.score} · ${when}` : "Scoring failed";
  }
}

export interface DetailProps {
  page: ListPage;
  job: JobDetail | null;
  loading: boolean;
  error: ApiError | null;
  overlay: boolean;
  width: number;
  onWidth: (width: number) => void;
  hasPrevious: boolean;
  hasNext: boolean;
  adding: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  onRetry: () => void;
  onAdd: (job: JobDetail) => void;
  onOpenLink: (url: string) => void;
  onStatus: (job: JobDetail, status: ApplicationStatus) => void;
  onNotes: (job: JobDetail, notes: string) => Promise<boolean>;
  onRemove: (job: JobDetail) => void;
  /** Why Score is unavailable, or null. */
  scoreBlocked: string | null;
  onScore: (job: JobDetail) => void;
}

export function Detail(props: DetailProps) {
  const { job } = props;
  const html = useMemo(() => (job ? markdown.render(job.description) : ""), [job]);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [job?.id]);

  const onBodyClick = (event: MouseEvent) => {
    const link = (event.target as HTMLElement).closest("a");
    if (!link) return;
    event.preventDefault();
    props.onOpenLink(link.href);
  };
  const url = job ? postingUrl(job) : null;

  // Dragging the left edge resizes the panel; the width is saved on release.
  const panel = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const width = draft ?? props.width;
  const clampWidth = (value: number) => {
    const available = panel.current?.parentElement?.clientWidth ?? Infinity;
    const max = props.overlay ? available - 48 : available * 0.6;
    return Math.round(Math.max(DETAIL_MIN, Math.min(value, max)));
  };
  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = panel.current?.getBoundingClientRect().width ?? width;
    let latest = startWidth;
    const move = (moveEvent: PointerEvent) => {
      latest = clampWidth(startWidth + startX - moveEvent.clientX);
      setDraft(latest);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      setDraft(null);
      props.onWidth(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const onResizeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "ArrowLeft") props.onWidth(clampWidth(width + step));
    else if (event.key === "ArrowRight") props.onWidth(clampWidth(width - step));
    else return;
    event.preventDefault();
  };

  return (
    <aside
      ref={panel}
      className={props.overlay ? "detail detail-overlay" : "detail"}
      style={{ "--detail-width": `${width}px` } as CSSProperties}
      aria-label="Job details"
      aria-busy={props.loading}
    >
      <div
        className="detail-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize details"
        aria-valuenow={Math.round(width)}
        aria-valuemin={DETAIL_MIN}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={onResizeStart}
        onDoubleClick={() => props.onWidth(DETAIL_DEFAULT)}
        onKeyDown={onResizeKey}
      />
      <div className="detail-bar">
        <button type="button" className="icon-button" disabled={!props.hasPrevious} onClick={props.onPrevious} aria-label="Previous job" title="Previous job (↑ or K)">
          <ArrowUp />
        </button>
        <button type="button" className="icon-button" disabled={!props.hasNext} onClick={props.onNext} aria-label="Next job" title="Next job (↓ or J)">
          <ArrowDown />
        </button>
        <span className="spacer" />
        <button type="button" className="icon-button" onClick={props.onClose} aria-label="Close details" title="Close (Esc)">
          <CloseIcon />
        </button>
      </div>
      <div className="detail-scroll" ref={scroller}>
        {props.error ? (
          <div className="detail-error">
            <ErrorText error={props.error} block />
            <button type="button" className="button" onClick={props.onRetry}>
              Try again
            </button>
          </div>
        ) : !job ? (
          <div className="detail-loading" aria-hidden="true">
            <span className="skeleton" style={{ width: "70%" }} />
            <span className="skeleton" style={{ width: "40%" }} />
            <span className="skeleton" style={{ width: "90%" }} />
          </div>
        ) : (
          <>
            <header className="detail-header">
              <ScoreChip job={job} large />
              <div className="detail-heading">
                <h2>{job.title}</h2>
                <p className="muted">{[job.company, job.location].filter(Boolean).join(" · ")}</p>
              </div>
            </header>
            {job.score_reason ? <p className="detail-reason">{job.score_reason}</p> : null}
            <dl className="detail-facts">
              {props.page === "shortlist" && job.application ? (
                <Fact label="Status">
                  <StatusPicker status={job.application.status} onChange={(status) => props.onStatus(job, status)} />
                </Fact>
              ) : null}
              {props.page === "shortlist" && job.application ? <NotesField job={job} onSave={props.onNotes} /> : null}
              <Fact label="Score">
                {scoreLine(job)}
                {job.score_state === "failed" ? <div className="score-attempt-error">Last attempt failed{job.last_score_error ? ` · ${job.last_score_error}` : ""}</div> : null}
              </Fact>
              {job.location ? <Fact label="Location">{job.location}</Fact> : null}
              {job.job_type ? <Fact label="Type">{jobTypeLabel(job.job_type)}</Fact> : null}
              <Fact label="Posted">
                {job.date_posted ? formatPosted(job.date_posted) : "Unknown"}
                <span className="muted"> · found {formatDay(job.first_seen_at)}</span>
              </Fact>
              {formatSalary(job.salary) ? <Fact label="Salary">{formatSalary(job.salary)}</Fact> : null}
              <Fact label="Searches">{job.directions.length ? job.directions.map((direction) => direction.name).join(", ") : "None"}</Fact>
              {job.queries.length ? <Fact label="Queries">{[...new Set(job.queries.map((query) => query.text))].join("; ")}</Fact> : null}
              <Fact label="Sources">{[...new Set(job.sources.map((source) => siteLabel(source.site)))].join(", ") || "None"}</Fact>
              {job.application ? (
                <Fact label="Added">
                  {formatDay(job.application.added_at)}
                  <span className="muted"> · updated {formatDay(job.application.updated_at)}</span>
                </Fact>
              ) : null}
            </dl>
            <div className="detail-actions">
              {props.page === "jobs" ? (
                job.in_applications ? (
                  <span className="added-label">
                    <CheckIcon /> In Shortlist
                  </span>
                ) : (
                  <button type="button" className="button" disabled={props.adding} onClick={() => props.onAdd(job)} title="Add to Shortlist (S)">
                    Add to Shortlist
                  </button>
                )
              ) : null}
              <button type="button" className="button" disabled={!url} onClick={() => url && props.onOpenLink(url)} title="Open posting (O)">
                Open posting <ExternalIcon />
              </button>
              <ScoreButton job={job} blocked={props.scoreBlocked} onScore={props.onScore} />
              {props.page === "shortlist" && job.application ? (
                <button type="button" className="button button-danger" onClick={() => props.onRemove(job)}>
                  Remove from Shortlist
                </button>
              ) : null}
            </div>
            <section className="jd" aria-label="Job description">
              {/* markdown-it escapes any HTML in the source (html: false). */}
              <div className="markdown" onClick={onBodyClick} dangerouslySetInnerHTML={{ __html: html }} />
            </section>
          </>
        )}
      </div>
    </aside>
  );
}

/** Active runs block scoring; a stopped run can leave jobs pending for a later attempt. */
function ScoreButton({ job, blocked, onScore }: { job: JobDetail; blocked: string | null; onScore: DetailProps["onScore"] }) {
  return (
    <button type="button" className="button" disabled={!!blocked} onClick={() => onScore(job)} title={blocked ?? "Score this job with your current model and rubric"}>
      {job.score != null ? "Rescore" : "Score"}
    </button>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Multi-line notes: saved on blur or ⌘↩, Esc puts back the saved text. */
function NotesField({ job, onSave }: { job: JobDetail; onSave: DetailProps["onNotes"] }) {
  const saved = job.application!.notes;
  const [draft, setDraft] = useState(saved);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const field = useRef<HTMLTextAreaElement>(null);
  const discarding = useRef(false);
  useEffect(() => {
    setDraft(saved);
  }, [job.id, saved]);
  const save = async () => {
    if (discarding.current) {
      discarding.current = false;
      return;
    }
    if (draft === saved) return;
    setState("saving");
    const ok = await onSave(job, draft);
    setState(ok ? "saved" : "idle");
  };
  return (
    <div className="fact fact-notes">
      <dt>
        <label htmlFor="detail-notes">Notes</label>
      </dt>
      <dd>
        <textarea
          id="detail-notes"
          ref={field}
          className="text-input notes-area"
          rows={3}
          value={draft}
          placeholder="Add a note"
          onChange={(event) => {
            setDraft(event.target.value);
            setState("idle");
          }}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.metaKey) {
              event.preventDefault();
              void save();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              discarding.current = true;
              setDraft(saved);
              setState("idle");
              field.current?.blur();
            }
          }}
        />
        <span className="notes-hint muted small" aria-live="polite">
          {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : "Click away or ⌘↩ to save, Esc to cancel"}
        </span>
      </dd>
    </div>
  );
}
