import { useEffect, useState, type ReactNode } from "react";
import { call, type RuleId, type Rules } from "./api";
import { useApp } from "./context";
import { useToast } from "./toasts";

/** Settings › Filters & scoring: the automatic scoring switch and the filter rules. */
export function FiltersSection() {
  const { catalog } = useApp();
  if (!catalog.settings) return <p className="muted">Loading…</p>;
  return (
    <section aria-labelledby="filters-title">
      <AutoScoring />
      <hr className="divider" />
      <RulesForm />
    </section>
  );
}

function AutoScoring() {
  const { api, catalog, refreshCatalog } = useApp();
  const toast = useToast();
  const settings = catalog.settings!;
  const [saving, setSaving] = useState(false);
  // The box follows the click at once and goes back if saving fails.
  const [checked, setChecked] = useState(settings.auto_score_enabled);
  useEffect(() => setChecked(settings.auto_score_enabled), [settings.auto_score_enabled]);
  const noRubric = !settings.rubric.trim();
  // Without a rubric scoring can be turned off but not on (CONTRACTS).
  const locked = noRubric && !checked;
  const toggle = async (enabled: boolean) => {
    setChecked(enabled);
    setSaving(true);
    const response = await call(() => api.saveSettings({ auto_score_enabled: enabled }));
    setSaving(false);
    if (!response.ok) {
      setChecked(!enabled);
      toast({ text: `Couldn't change automatic scoring. ${response.error.message}`, code: response.error.code, error: true });
      return;
    }
    refreshCatalog();
    toast({ text: enabled ? "Automatic scoring is on for new runs" : "Automatic scoring is off for new runs" });
  };
  return (
    <div className="section-header">
      <h2 id="filters-title">Automatic scoring</h2>
      <label className="choice toggle-choice">
        <input
          type="checkbox"
          className="checkbox"
          checked={checked}
          disabled={saving || locked}
          aria-describedby="auto-score-help"
          onChange={(event) => void toggle(event.target.checked)}
        />
        <span>
          Score new jobs during each run
          <span className="choice-note" id="auto-score-help">
            {noRubric
              ? checked
                ? "No scoring rubric yet. Runs can't start while this is on; turn it off to search without scores."
                : "Needs a scoring rubric. Until then, new jobs stay unscored."
              : "Applies to new runs. Jobs found while it's off stay unscored; existing scores don't change."}
          </span>
        </span>
      </label>
    </div>
  );
}

const ruleIds: RuleId[] = ["test_jobs", "senior_title", "experience", "authorization", "language", "graduation", "degree"];

interface RulesDraft {
  enabled: RuleId[];
  years: string;
  companies: string;
  sponsorship: boolean;
  authorization: "" | "opt" | "unrestricted";
  languages: string;
  graduation: string;
  degrees: string;
}

const listText = (values: string[] | undefined) => (values ?? []).join(", ");
const listValues = (text: string) =>
  text
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

function fromRules(rules: Rules): RulesDraft {
  const q = rules.qualifications;
  return {
    enabled: ruleIds.filter((id) => rules.enabled_rule_ids.includes(id)),
    years: String(rules.experience_max_years),
    companies: rules.excluded_companies.join("\n"),
    sponsorship: q.requires_sponsorship ?? false,
    authorization: q.work_authorization ?? "",
    languages: listText(q.languages),
    graduation: q.graduation_date ?? "",
    degrees: listText(q.degrees),
  };
}

/**
 * Filter rules: always-on filters are stated; optional rules only act on an
 * explicit conflict with what you enter. A draft until Save.
 */
function RulesForm() {
  const { api, catalog, refreshCatalog } = useApp();
  const toast = useToast();
  const rules = catalog.settings!.rules;
  const savedKey = JSON.stringify(rules);
  const [draft, setDraft] = useState(() => fromRules(rules));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setDraft(fromRules(rules));
    setErrors({});
    // Reset only when the saved rules change.
  }, [savedKey]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(fromRules(rules));
  const change = (next: Partial<RulesDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setErrors({});
  };
  const on = (id: RuleId) => draft.enabled.includes(id);
  const setRule = (id: RuleId, enabled: boolean) =>
    change({ enabled: ruleIds.filter((rule) => (rule === id ? enabled : draft.enabled.includes(rule))) });

  const save = async () => {
    const problems: Record<string, string> = {};
    const years = draft.years.trim();
    if (!/^\d+$/.test(years) || Number(years) > 100) problems.years = "Enter whole years from 0 to 100.";
    if (draft.graduation && !/^\d{4}-\d{2}-\d{2}$/.test(draft.graduation)) problems.graduation = "Choose a date.";
    setErrors(problems);
    if (Object.keys(problems).length) return;
    const qualifications: Rules["qualifications"] = {};
    if (draft.sponsorship) qualifications.requires_sponsorship = true;
    if (draft.authorization) qualifications.work_authorization = draft.authorization;
    if (listValues(draft.languages).length) qualifications.languages = listValues(draft.languages);
    if (draft.graduation) qualifications.graduation_date = draft.graduation;
    if (listValues(draft.degrees).length) qualifications.degrees = listValues(draft.degrees);
    const next: Rules = {
      enabled_rule_ids: draft.enabled,
      experience_max_years: Number(years),
      excluded_companies: [...new Set(draft.companies.split("\n").map((name) => name.trim()).filter(Boolean))],
      qualifications,
    };
    setSaving(true);
    const response = await call(() => api.saveSettings({ rules: next }));
    setSaving(false);
    if (!response.ok) {
      setErrors({ form: `${response.error.message} (${response.error.code})` });
      return;
    }
    refreshCatalog();
    toast({ text: "Filter rules saved" });
  };

  const error = (key: string) =>
    errors[key] ? (
      <p className="field-error" role="alert">
        {errors[key]}
      </p>
    ) : null;

  return (
    <>
      <header className="section-header">
        <h2>Filters</h2>
        <p className="muted">
          Filtered jobs are dropped before scoring and never saved; Runs shows how many. Jobs already saved or in your Shortlist are never removed by these rules.
          Changes apply to the next run.
        </p>
      </header>
      <div className="note-box">
        Always filtered: companies on the list below, postings without a title or description, and clearly part-time jobs.
      </div>

      <div className="rules-field">
        <label className="form-label" htmlFor="excluded-companies">
          Excluded companies
        </label>
        <textarea
          id="excluded-companies"
          className="text-input companies-input"
          rows={4}
          value={draft.companies}
          placeholder={"One company per line"}
          aria-describedby="companies-help"
          onChange={(event) => change({ companies: event.target.value })}
        />
        <p className="muted small" id="companies-help">
          One per line; you can paste a list. Matches the exact company name, ignoring case and spacing.
        </p>
      </div>

      <fieldset className="rules">
        <legend className="group-label">Optional rules</legend>
        <Rule id="test_jobs" on={on("test_jobs")} onChange={setRule} title="Test postings" note="Titles that say test job, test posting or do not apply." />
        <Rule id="senior_title" on={on("senior_title")} onChange={setRule} title="Senior titles" note="Titles with Senior, Sr., Staff, Principal, Director or VP." />
        <Rule
          id="experience"
          on={on("experience")}
          onChange={setRule}
          title="More experience required than"
          inline={
            <span className="inline-fields">
              <input
                className="text-input number-input"
                inputMode="numeric"
                value={draft.years}
                aria-label="Most years of required experience"
                aria-invalid={errors.years ? true : undefined}
                onChange={(event) => change({ years: event.target.value })}
              />
              years
            </span>
          }
          note="Only stated requirements (required, minimum, at least, N+ years). Preferred experience is kept. With a degree alternative, your degrees below count."
        >
          {error("years")}
        </Rule>
        <Rule
          id="authorization"
          on={on("authorization")}
          onChange={setRule}
          title="Work authorization conflicts"
          note="Removes a job only when it clearly excludes you; unclear postings are kept."
        >
          <label className="check-row">
            <input type="checkbox" className="checkbox" checked={draft.sponsorship} onChange={(event) => change({ sponsorship: event.target.checked })} />
            <span>I need visa sponsorship — exclude jobs that state they don't sponsor</span>
          </label>
          <label className="inline-fields">
            My work authorization
            <select
              className="select"
              value={draft.authorization}
              onChange={(event) => change({ authorization: event.target.value as RulesDraft["authorization"] })}
            >
              <option value="">Not specified</option>
              <option value="opt">OPT — exclude jobs that rule out OPT</option>
              <option value="unrestricted">Unrestricted</option>
            </select>
          </label>
        </Rule>
        <Rule
          id="language"
          on={on("language")}
          onChange={setRule}
          title="Required languages I don't speak"
          note="Removes jobs that require fluency in a language you don't list."
        >
          <label className="inline-fields wide-field">
            Languages I speak
            <input
              className="text-input"
              value={draft.languages}
              placeholder="English, Spanish"
              onChange={(event) => change({ languages: event.target.value })}
            />
          </label>
        </Rule>
        <Rule
          id="graduation"
          on={on("graduation")}
          onChange={setRule}
          title="Graduation deadline conflicts"
          note="Removes jobs that require graduating before a date earlier than yours."
        >
          <label className="inline-fields">
            My graduation date
            <input
              type="date"
              className="text-input"
              value={draft.graduation}
              aria-invalid={errors.graduation ? true : undefined}
              onChange={(event) => change({ graduation: event.target.value })}
            />
          </label>
          {error("graduation")}
        </Rule>
        <Rule id="degree" on={on("degree")} onChange={setRule} title="PhD-only roles" note="Removes jobs that require a PhD with no master's alternative, unless you list a PhD.">
          <label className="inline-fields wide-field">
            My degrees
            <input
              className="text-input"
              value={draft.degrees}
              placeholder="Bachelor, Master"
              onChange={(event) => change({ degrees: event.target.value })}
            />
          </label>
        </Rule>
      </fieldset>
      {error("form")}
      <div className="form-actions">
        {dirty ? (
          <button type="button" className="link-button" onClick={() => change(fromRules(rules))}>
            Discard changes
          </button>
        ) : null}
        <button type="button" className="button button-primary" disabled={!dirty || saving} onClick={() => void save()}>
          Save
        </button>
      </div>
    </>
  );
}

function Rule({
  id,
  on,
  onChange,
  title,
  note,
  inline,
  children,
}: {
  id: RuleId;
  on: boolean;
  onChange: (id: RuleId, on: boolean) => void;
  title: string;
  note: string;
  inline?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="rule">
      <div className="rule-head">
        <label className="choice">
          <input type="checkbox" className="checkbox" checked={on} onChange={(event) => onChange(id, event.target.checked)} />
          <span>{title}</span>
        </label>
        {inline}
      </div>
      <p className="choice-note rule-note">{note}</p>
      {children ? <div className="rule-body">{children}</div> : null}
    </div>
  );
}
