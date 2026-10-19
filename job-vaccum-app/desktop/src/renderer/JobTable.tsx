import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import type { ApplicationStatus, JobSummary, Sort } from "./api";
import { formatDay, formatPosted, jobTypeLabel, scoreChip, siteLabel, statusLabels, statuses } from "./format";
import { CheckIcon, ChevronDown, ExternalIcon } from "./icons";
import { columns, MIN_COLUMN_WIDTH, type ColumnKey, type ListPage } from "./listModel";
import { Menu } from "./ui";

const SELECT_WIDTH = 36;

export function ScoreChip({ job, large }: { job: Pick<JobSummary, "score" | "score_state">; large?: boolean }) {
  const chip = scoreChip(job);
  return (
    <span className={large ? "score score-large" : "score"} data-tone={chip.tone} title={chip.label} aria-label={chip.label}>
      {chip.text}
    </span>
  );
}

/** Status chip that opens the seven states; choosing one saves right away. */
export function StatusPicker({
  status,
  onChange,
  label,
}: {
  status: ApplicationStatus;
  onChange: (status: ApplicationStatus) => void;
  label?: string;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="status-chip"
        data-status={status}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label ?? "Status"}: ${statusLabels[status]}`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        {statusLabels[status]}
        <ChevronDown size={9} />
      </button>
      {open ? (
        <Menu
          anchor={button.current!}
          onClose={() => setOpen(false)}
          label="Status"
          entries={statuses.map((value) => ({
            key: value,
            checked: value === status,
            label: (
              <span className="status-option">
                <span className="status-dot" data-status={value} aria-hidden="true" />
                {statusLabels[value]}
              </span>
            ),
            onSelect: () => {
              if (value !== status) onChange(value);
            },
          }))}
        />
      ) : null}
    </>
  );
}

function NotesEditor({ value, onCommit, onCancel }: { value: string; onCommit: (notes: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(value);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save && draft !== value) onCommit(draft);
    else onCancel();
  };
  return (
    <input
      className="notes-input"
      aria-label="Notes"
      value={draft}
      autoFocus
      onChange={(event) => setDraft(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

export interface TableProps {
  page: ListPage;
  items: JobSummary[];
  visible: ColumnKey[];
  widths: Partial<Record<ColumnKey, number>>;
  sort: Sort;
  selected: Set<string>;
  currentId: string | null;
  editingNotes: string | null;
  skeleton: boolean;
  label: string;
  onSort: (key: string) => void;
  onResize: (key: ColumnKey, width: number, done: boolean) => void;
  onHeaderMenu: (point: { x: number; y: number }) => void;
  onToggle: (id: string, range: boolean) => void;
  onRowClick: (id: string) => void;
  /** Makes a row current without opening details (Notes cells, where a double-click edits). */
  onCurrent: (id: string) => void;
  onStatus: (job: JobSummary, status: ApplicationStatus) => void;
  onEditNotes: (id: string | null) => void;
  onNotes: (job: JobSummary, notes: string) => void;
  onOpenLink: (job: JobSummary) => void;
}

export const columnWidth = (key: ColumnKey, widths: TableProps["widths"]) => widths[key] ?? columns[key].width;

export function JobTable(props: TableProps) {
  const { items, visible, widths, sort, selected, currentId } = props;
  const total = SELECT_WIDTH + visible.reduce((sum, key) => sum + columnWidth(key, widths), 0);
  const rows = useRef(new Map<string, HTMLTableRowElement>());
  useEffect(() => {
    if (currentId) rows.current.get(currentId)?.scrollIntoView({ block: "nearest" });
  }, [currentId]);
  const [sortKey, order] = [sort.slice(0, sort.lastIndexOf("_")), sort.slice(sort.lastIndexOf("_") + 1)];

  return (
    <div className="table-scroll" tabIndex={-1}>
      <table className="job-table" style={{ width: total }} aria-label={props.label} aria-rowcount={items.length}>
        <colgroup>
          <col style={{ width: SELECT_WIDTH }} />
          {visible.map((key) => (
            <col key={key} style={{ width: columnWidth(key, widths) }} />
          ))}
          <col />
        </colgroup>
        <thead
          onContextMenu={(event) => {
            event.preventDefault();
            props.onHeaderMenu({ x: event.clientX, y: event.clientY });
          }}
        >
          <tr>
            <th className="select-cell">
              <span className="visually-hidden">Selected</span>
            </th>
            {visible.map((key) => (
              <HeaderCell
                key={key}
                column={key}
                sorted={columns[key].sort === sortKey ? (order as "asc" | "desc") : null}
                width={columnWidth(key, widths)}
                onSort={props.onSort}
                onResize={props.onResize}
              />
            ))}
            <th className="filler" aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {props.skeleton
            ? Array.from({ length: 8 }, (_, index) => (
                <tr key={index} className="skeleton-row" aria-hidden="true">
                  <td className="select-cell">
                    <span className="skeleton skeleton-box" />
                  </td>
                  {visible.map((key, column) => (
                    <td key={key}>
                      <span className="skeleton" style={{ width: key === "score" ? 24 : `${45 + ((index * 7 + column * 13) % 40)}%` }} />
                    </td>
                  ))}
                  <td className="filler" />
                </tr>
              ))
            : items.map((job) => (
                <tr
                  key={job.id}
                  ref={(element) => {
                    if (element) rows.current.set(job.id, element);
                    else rows.current.delete(job.id);
                  }}
                  data-job-id={job.id}
                  data-current={job.id === currentId || undefined}
                  data-selected={selected.has(job.id) || undefined}
                  onClick={() => props.onRowClick(job.id)}
                >
                  <td className="select-cell">
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={selected.has(job.id)}
                      aria-label={`Select ${job.title}`}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => props.onToggle(job.id, (event.nativeEvent as unknown as globalThis.MouseEvent).shiftKey)}
                    />
                  </td>
                  {visible.map((key) => (
                    <td key={key} className={`cell-${key}`}>
                      <Cell column={key} job={job} {...props} />
                    </td>
                  ))}
                  <td className="filler" />
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}

function HeaderCell({
  column,
  sorted,
  width,
  onSort,
  onResize,
}: {
  column: ColumnKey;
  sorted: "asc" | "desc" | null;
  width: number;
  onSort: (key: string) => void;
  onResize: TableProps["onResize"];
}) {
  const def = columns[column];
  const drag = useRef<{ x: number; width: number } | null>(null);
  const move = (event: PointerEvent) => {
    if (!drag.current) return;
    onResize(column, Math.max(MIN_COLUMN_WIDTH, drag.current.width + event.clientX - drag.current.x), false);
  };
  const end = (event: PointerEvent) => {
    if (!drag.current) return;
    onResize(column, Math.max(MIN_COLUMN_WIDTH, drag.current.width + event.clientX - drag.current.x), true);
    drag.current = null;
  };
  return (
    <th
      className={`cell-${column}`}
      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
      scope="col"
    >
      {def.sort ? (
        <button
          type="button"
          className="th-button"
          onClick={() => onSort(def.sort!)}
          title={`Sort by ${def.label}`}
        >
          <span className="th-label">{def.label}</span>
          {sorted ? <span className="sort-arrow" aria-hidden="true">{sorted === "asc" ? "▲" : "▼"}</span> : null}
        </button>
      ) : (
        <span className="th-label th-static">{def.label}</span>
      )}
      <span
        className="col-resizer"
        aria-hidden="true"
        onClick={(event: MouseEvent) => event.stopPropagation()}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, width };
        }}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      />
    </th>
  );
}

function Cell({ column, job, ...props }: { column: ColumnKey; job: JobSummary } & TableProps): ReactNode {
  const text = (value: string | null | undefined, className = "cell-text") =>
    value ? (
      <span className={className} title={value}>
        {value}
      </span>
    ) : null;
  switch (column) {
    case "score":
      return <ScoreChip job={job} />;
    case "title":
      return (
        <span className="title-cell">
          <span className="cell-text cell-strong" title={job.title}>
            {job.title}
          </span>
          {props.page === "jobs" && job.in_applications ? (
            <span className="in-shortlist" title="In Shortlist" aria-label="In Shortlist">
              <CheckIcon size={11} />
            </span>
          ) : null}
        </span>
      );
    case "company":
      return text(job.company);
    case "reason":
      return text(job.score_reason);
    case "directions":
      return text(job.directions.map((direction) => direction.name).join(", "));
    case "location":
      return text(job.location);
    case "date_posted":
      return <span className="cell-text cell-muted">{formatPosted(job.date_posted)}</span>;
    case "first_seen":
      return <span className="cell-text cell-muted">{formatDay(job.first_seen_at)}</span>;
    case "job_type":
      return text(job.job_type ? jobTypeLabel(job.job_type) : null);
    case "sources":
      return text([...new Set(job.sources.map((source) => siteLabel(source.site)))].join(", "));
    case "status":
      return job.application ? (
        <StatusPicker status={job.application.status} label={`Status of ${job.title}`} onChange={(status) => props.onStatus(job, status)} />
      ) : null;
    case "notes":
      if (props.editingNotes === job.id && job.application) {
        return (
          <NotesEditor
            value={job.application.notes}
            onCommit={(notes) => props.onNotes(job, notes)}
            onCancel={() => props.onEditNotes(null)}
          />
        );
      }
      return (
        <span
          className="notes-cell"
          title={job.application?.notes || "Double-click to add a note"}
          onClick={(event) => {
            event.stopPropagation();
            props.onCurrent(job.id);
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            props.onEditNotes(job.id);
          }}
        >
          {job.application?.notes}
        </span>
      );
    case "added":
      return <span className="cell-text cell-muted">{formatDay(job.application?.added_at)}</span>;
    case "updated":
      return <span className="cell-text cell-muted">{formatDay(job.application?.updated_at)}</span>;
    case "link": {
      const url = job.sources.find((source) => source.direct_url || source.url);
      return url ? (
        <button
          type="button"
          className="link-button"
          onClick={(event) => {
            event.stopPropagation();
            props.onOpenLink(job);
          }}
        >
          Open <ExternalIcon />
        </button>
      ) : null;
    }
  }
}
