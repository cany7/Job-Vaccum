import { useEffect, useState, type FormEvent } from "react";
import { call, type City, type CityInput, type Direction, type Platform, type Query } from "./api";
import { useApp } from "./context";
import { siteLabel } from "./format";
import { CloseIcon } from "./icons";
import { useToast } from "./toasts";

/** New search: name needs Add; an empty name is reported under the field. */
export function AddSearchRow({ onDone }: { onDone: (created: string | null) => void }) {
  const { api, mutate, refreshCatalog } = useApp();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a name.");
      return;
    }
    setSaving(true);
    const response = await mutate(() => api.saveDirection({ name: trimmed }));
    setSaving(false);
    if (!response.ok) {
      setError(`${response.error.message} (${response.error.code})`);
      return;
    }
    refreshCatalog();
    onDone(response.result.id);
  };
  return (
    <tr>
      <td />
      <td />
      <td className="name-cell" colSpan={3}>
        <input
          className="text-input rename-input"
          value={name}
          autoFocus
          placeholder="Search name, e.g. Data engineering"
          aria-label="New search name"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "new-search-error" : undefined}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void save();
            if (event.key === "Escape") onDone(null);
          }}
        />
        {error ? (
          <p className="field-error" id="new-search-error" role="alert">
            {error}
          </p>
        ) : null}
      </td>
      <td className="actions-cell">
        <button type="button" className="button button-primary" disabled={saving} onClick={() => void save()}>
          Add
        </button>
        <button type="button" className="button" onClick={() => onDone(null)}>
          Cancel
        </button>
      </td>
    </tr>
  );
}

/** A search's queries: turn on or off and delete right away; editing and adding need Return or the button. */
export function QueriesEditor({ direction }: { direction: Direction }) {
  const { api, mutate, refreshCatalog } = useApp();
  const toast = useToast();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const failed = (what: string, response: { error: { message: string; code: string } }) =>
    toast({ text: `${what} ${response.error.message}`, code: response.error.code, error: true });

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const expression = text.trim();
    if (!expression) {
      setError("Enter a query.");
      return;
    }
    setSaving(true);
    const response = await mutate(() => api.saveQuery({ direction_id: direction.id, expression, enabled: true }));
    setSaving(false);
    if (!response.ok) {
      setError(`${response.error.message} (${response.error.code})`);
      return;
    }
    setText("");
    refreshCatalog();
  };
  const toggle = async (query: Query, enabled: boolean) => {
    const response = await mutate(() => api.saveQuery({ id: query.id, enabled }));
    if (!response.ok) failed("Couldn't change the query.", response);
    refreshCatalog();
    return response.ok;
  };
  const remove = async (query: Query) => {
    const response = await mutate(() => api.deleteQuery({ id: query.id }));
    if (!response.ok) failed("Couldn't delete the query.", response);
    else toast({ text: `Deleted query “${query.expression}”` });
    refreshCatalog();
  };

  const inputId = `add-query-${direction.id}`;
  return (
    <div className="queries">
      {direction.queries.length ? (
        <ul className="query-list" aria-label={`Queries for ${direction.name}`}>
          {sortedQueries(direction.queries).map((query) => (
            <QueryRow key={query.id} query={query} onToggle={(on) => toggle(query, on)} onDelete={() => void remove(query)} />
          ))}
        </ul>
      ) : (
        <p className="muted small">No queries yet. This search is skipped until it has one.</p>
      )}
      <form className="add-value" onSubmit={add} noValidate>
        <input
          id={inputId}
          className="text-input"
          value={text}
          placeholder="Add a query, e.g. machine learning engineer"
          aria-label={`Add a query to ${direction.name}`}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
        />
        <button type="submit" className="button" disabled={saving}>
          Add query
        </button>
      </form>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <p className="muted small">Words sent to LinkedIn and Indeed as typed. Each query runs once for every location and site.</p>
    </div>
  );
}

/** The service lists queries by ID; show them in a stable, readable order instead. */
const sortedQueries = (queries: Query[]) => [...queries].sort((a, b) => a.expression.localeCompare(b.expression) || a.id.localeCompare(b.id));

function QueryRow({ query, onToggle, onDelete }: { query: Query; onToggle: (on: boolean) => Promise<boolean>; onDelete: () => void }) {
  const { api, mutate, refreshCatalog } = useApp();
  // The box follows the click at once and goes back if saving fails.
  const [enabled, setEnabled] = useState(query.enabled);
  useEffect(() => setEnabled(query.enabled), [query.enabled]);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(query.expression);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const expression = text.trim();
    if (!expression) {
      setError("Enter a query.");
      return;
    }
    if (expression === query.expression) {
      setEditing(false);
      return;
    }
    const response = await mutate(() => api.saveQuery({ id: query.id, expression }));
    if (!response.ok) {
      setError(`${response.error.message} (${response.error.code})`);
      return;
    }
    setEditing(false);
    refreshCatalog();
  };
  const cancel = () => {
    setText(query.expression);
    setError(null);
    setEditing(false);
  };
  return (
    <li className="query-row">
      <input
        type="checkbox"
        className="checkbox"
        checked={enabled}
        aria-label={`Use query ${query.expression}`}
        title={enabled ? "Used in runs" : "Not used in runs"}
        onChange={(event) => {
          const next = event.target.checked;
          setEnabled(next);
          void onToggle(next).then((ok) => {
            if (!ok) setEnabled(!next);
          });
        }}
      />
      {editing ? (
        <span className="query-edit">
          <input
            className="text-input"
            value={text}
            autoFocus
            aria-label="Query"
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              setText(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
              if (event.key === "Escape") cancel();
            }}
          />
          {error ? (
            <span className="field-error" role="alert">
              {error}
            </span>
          ) : null}
        </span>
      ) : (
        <span className={enabled ? "query-text" : "query-text muted"}>{query.expression}</span>
      )}
      <span className="query-actions">
        {editing ? (
          <>
            <button type="button" className="button button-small" onClick={() => void save()}>
              Save
            </button>
            <button type="button" className="button button-small" onClick={cancel}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" className="button button-small" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button type="button" className="button button-small button-danger" onClick={onDelete} aria-label={`Delete query ${query.expression}`}>
              Delete
            </button>
          </>
        )}
      </span>
    </li>
  );
}

const platforms: Platform[] = ["linkedin", "indeed"];
const DEFAULT_RADIUS = 50;

interface LocationsDraft {
  cities: (CityInput & { key: string })[];
  country: string;
  platforms: Platform[];
}

const fromSettings = (cities: City[], country: string, sites: Platform[]): LocationsDraft => ({
  cities: cities.map((city) => ({ ...city, key: city.id })),
  country,
  platforms: sites,
});

/**
 * Locations (shared by all searches), Indeed country and sites. Edits stay a
 * draft until Save; invalid fields are reported under the field and not saved.
 */
export function LocationsForm() {
  const { api, catalog, refreshCatalog } = useApp();
  const toast = useToast();
  const settings = catalog.settings;
  const savedKey = settings ? JSON.stringify([settings.cities, settings.country_indeed, settings.platforms]) : "";
  const [draft, setDraft] = useState<LocationsDraft | null>(null);
  const [newCity, setNewCity] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (settings) setDraft(fromSettings(settings.cities, settings.country_indeed, settings.platforms));
    setErrors({});
    // Reset only when the saved values change, not on every catalog reload.
  }, [savedKey]);

  if (!settings || !draft) return <p className="muted">Loading…</p>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(fromSettings(settings.cities, settings.country_indeed, settings.platforms));
  const change = (next: Partial<LocationsDraft>) => setDraft({ ...draft, ...next });
  const setCity = (key: string, patch: Partial<CityInput>) => {
    change({ cities: draft.cities.map((city) => (city.key === key ? { ...city, ...patch } : city)) });
    setErrors(({ [key]: _, ...rest }) => rest);
  };
  const addCity = (event: FormEvent) => {
    event.preventDefault();
    const location = newCity.trim();
    if (!location) return;
    change({ cities: [...draft.cities, { key: `new-${Date.now()}`, location, distance_miles: DEFAULT_RADIUS, enabled: true }] });
    setNewCity("");
  };

  const save = async () => {
    const problems: Record<string, string> = {};
    for (const city of draft.cities) {
      if (!city.location.trim()) problems[city.key] = "Enter a location.";
      else if (!Number.isInteger(city.distance_miles) || city.distance_miles < 0 || city.distance_miles > 1000)
        problems[city.key] = "Radius is a whole number of miles from 0 to 1000.";
    }
    if (!draft.country.trim()) problems.country = "Enter the Indeed country.";
    setErrors(problems);
    if (Object.keys(problems).length) return;
    setSaving(true);
    const response = await call(() =>
      api.saveSettings({
        cities: draft.cities.map(({ key: _, ...city }) => ({ ...city, location: city.location.trim() })),
        country_indeed: draft.country.trim(),
        platforms: platforms.filter((site) => draft.platforms.includes(site)),
      }),
    );
    setSaving(false);
    if (!response.ok) {
      setErrors({ form: `${response.error.message} (${response.error.code})` });
      return;
    }
    refreshCatalog();
    toast({ text: "Locations and sites saved" });
  };

  return (
    <section aria-labelledby="locations-title" className="settings-subsection">
      <header className="section-header">
        <h2 id="locations-title">Locations and sites</h2>
        <p className="muted">Every search uses these locations. Radius is in miles.</p>
      </header>
      {draft.cities.length ? (
        <table className="settings-table" aria-label="Locations">
          <thead>
            <tr>
              <th className="toggle-cell">On</th>
              <th>Location</th>
              <th className="number-cell">Radius (mi)</th>
              <th>
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {draft.cities.map((city) => (
              <tr key={city.key}>
                <td className="toggle-cell">
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={city.enabled}
                    aria-label={`Search in ${city.location || "this location"}`}
                    onChange={(event) => setCity(city.key, { enabled: event.target.checked })}
                  />
                </td>
                <td>
                  <input
                    className="text-input location-input"
                    value={city.location}
                    aria-label="Location"
                    aria-invalid={errors[city.key] ? true : undefined}
                    onChange={(event) => setCity(city.key, { location: event.target.value })}
                  />
                  {errors[city.key] ? (
                    <p className="field-error" role="alert">
                      {errors[city.key]}
                    </p>
                  ) : null}
                </td>
                <td className="number-cell">
                  <input
                    className="text-input days-input"
                    inputMode="numeric"
                    value={Number.isNaN(city.distance_miles) ? "" : String(city.distance_miles)}
                    aria-label={`Radius for ${city.location || "this location"} in miles`}
                    onChange={(event) => setCity(city.key, { distance_miles: event.target.value.trim() === "" ? Number.NaN : Number(event.target.value) })}
                  />
                </td>
                <td className="actions-cell">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove ${city.location || "location"}`}
                    title="Remove"
                    onClick={() => change({ cities: draft.cities.filter((item) => item.key !== city.key) })}
                  >
                    <CloseIcon size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No locations yet. Runs need at least one.</p>
      )}
      <form className="add-value" onSubmit={addCity}>
        <input
          className="text-input"
          value={newCity}
          placeholder="Add a location, e.g. Seattle, WA"
          aria-label="Add a location"
          onChange={(event) => setNewCity(event.target.value)}
        />
        <button type="submit" className="button" disabled={!newCity.trim()}>
          Add location
        </button>
      </form>

      <div className="form-grid">
        <label className="form-label" htmlFor="country-indeed">
          Indeed country
        </label>
        <div>
          <input
            id="country-indeed"
            className="text-input"
            value={draft.country}
            aria-invalid={errors.country ? true : undefined}
            aria-describedby="country-help"
            onChange={(event) => {
              change({ country: event.target.value });
              setErrors(({ country: _, ...rest }) => rest);
            }}
          />
          {errors.country ? (
            <p className="field-error" role="alert">
              {errors.country}
            </p>
          ) : null}
          <p className="muted small" id="country-help">
            A country name Indeed supports in JobSpy, such as usa, canada or uk. LinkedIn uses only the location.
          </p>
        </div>
        <span className="form-label" id="sites-label">
          Sites
        </span>
        <div className="site-row" role="group" aria-labelledby="sites-label">
          {platforms.map((site) => (
            <label key={site} className="check-row">
              <input
                type="checkbox"
                className="checkbox"
                checked={draft.platforms.includes(site)}
                onChange={(event) =>
                  change({ platforms: event.target.checked ? [...draft.platforms, site] : draft.platforms.filter((item) => item !== site) })
                }
              />
              <span>{siteLabel(site)}</span>
            </label>
          ))}
          {!draft.platforms.length ? <span className="muted small">Runs need at least one site.</span> : null}
        </div>
      </div>
      {draft.platforms.includes("linkedin") ? (
        <p className="muted small">LinkedIn limits frequent searches. For larger runs, use a proxy (Settings › Proxy).</p>
      ) : null}
      {errors.form ? (
        <p className="field-error" role="alert">
          {errors.form}
        </p>
      ) : null}
      <div className="form-actions">
        {dirty ? (
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setDraft(fromSettings(settings.cities, settings.country_indeed, settings.platforms));
              setErrors({});
            }}
          >
            Discard changes
          </button>
        ) : null}
        <button type="button" className="button button-primary" disabled={!dirty || saving} onClick={() => void save()}>
          Save
        </button>
      </div>
    </section>
  );
}
