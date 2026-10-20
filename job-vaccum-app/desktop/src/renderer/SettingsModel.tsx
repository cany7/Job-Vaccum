import { useEffect, useRef, useState } from "react";
import { call, type ApiError, type ModelConfig } from "./api";
import { useApp } from "./context";
import { ErrorText } from "./Settings";
import { useToast } from "./toasts";

type Protocol = ModelConfig["protocol"];

/** Per-protocol help only; nothing here adapts requests to a provider or model. */
const protocols: Record<
  Protocol,
  { label: string; example: string; suffix: string; temperature: string; maxTokens: string; reasoning: string; reasoningExample: string }
> = {
  chat_completions: {
    label: "OpenAI Chat Completions",
    example: "https://api.openai.com/v1",
    suffix: "/chat/completions",
    temperature: "temperature",
    maxTokens: "max_completion_tokens",
    reasoning: "reasoning_effort",
    reasoningExample: "low, medium or high",
  },
  responses: {
    label: "OpenAI Responses",
    example: "https://api.openai.com/v1",
    suffix: "/responses",
    temperature: "temperature",
    maxTokens: "max_output_tokens",
    reasoning: "reasoning.effort",
    reasoningExample: "low, medium or high",
  },
  anthropic_messages: {
    label: "Anthropic Messages",
    example: "https://api.anthropic.com/v1",
    suffix: "/messages",
    temperature: "temperature",
    maxTokens: "max_tokens",
    reasoning: "thinking",
    reasoningExample: '{"type": "enabled", "budget_tokens": 1024}',
  },
  gemini_generate_content: {
    label: "Gemini generateContent",
    example: "https://generativelanguage.googleapis.com/v1beta",
    suffix: "/models/{model}:generateContent",
    temperature: "generationConfig.temperature",
    maxTokens: "generationConfig.maxOutputTokens",
    reasoning: "generationConfig.thinkingConfig",
    reasoningExample: '{"thinkingBudget": 1024}',
  },
};
const protocolIds = Object.keys(protocols) as Protocol[];
const ANTHROPIC_VERSION = "2023-06-01";
/** Effort is text for the OpenAI protocols; Anthropic and Gemini take a thinking object. */
const usesEffort = (protocol: Protocol) => protocol === "chat_completions" || protocol === "responses";

interface Draft {
  protocol: Protocol;
  base_url: string;
  model_id: string;
  temperature: string;
  max_output_tokens: string;
  reasoning: string;
  anthropic_version: string;
}

function fromModel(model: ModelConfig | null): Draft {
  return {
    protocol: model?.protocol ?? "chat_completions",
    base_url: model?.base_url ?? "",
    model_id: model?.model_id ?? "",
    temperature: model?.temperature != null ? String(model.temperature) : "",
    max_output_tokens: model?.max_output_tokens != null ? String(model.max_output_tokens) : "",
    reasoning: model?.reasoning_effort ?? (model?.thinking ? JSON.stringify(model.thinking) : ""),
    anthropic_version: model?.anthropic_version ?? ANTHROPIC_VERSION,
  };
}

const isLocalHost = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");

/** Builds the request settings, or field errors. Blank optional fields become null (not sent); 0 is a value. */
function toModel(draft: Draft): { model: ModelConfig; errors?: undefined } | { model?: undefined; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const base = draft.base_url.trim();
  try {
    const url = new URL(base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch {
    errors.base_url = "Enter an http or https address with its version path, without a key, query or #.";
  }
  const modelId = draft.model_id.trim();
  if (!modelId) errors.model_id = "Enter the model ID.";
  else if (draft.protocol === "gemini_generate_content" && modelId.startsWith("models/")) errors.model_id = "Leave out the models/ prefix.";

  let temperature: number | null = null;
  if (draft.temperature.trim()) {
    temperature = Number(draft.temperature.trim());
    if (!Number.isFinite(temperature)) errors.temperature = "Enter a number, such as 0 or 0.7.";
  }
  let maxTokens: number | null = null;
  if (draft.max_output_tokens.trim()) {
    maxTokens = Number(draft.max_output_tokens.trim());
    if (!/^\d+$/.test(draft.max_output_tokens.trim()) || maxTokens < 1) errors.max_output_tokens = "Enter a whole number of tokens, 1 or more.";
  } else if (draft.protocol === "anthropic_messages") errors.max_output_tokens = "Anthropic Messages requires a maximum. Enter one, such as 1024.";

  const reasoning = draft.reasoning.trim();
  let thinking: Record<string, unknown> | null = null;
  if (reasoning && !usesEffort(draft.protocol)) {
    try {
      const parsed: unknown = JSON.parse(reasoning);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      thinking = parsed as Record<string, unknown>;
    } catch {
      errors.reasoning = "Enter a JSON object, like the example.";
    }
  }
  if (Object.keys(errors).length) return { errors };
  const anthropic = draft.protocol === "anthropic_messages";
  return {
    model: {
      protocol: draft.protocol,
      base_url: base,
      model_id: modelId,
      temperature,
      max_output_tokens: maxTokens,
      reasoning_effort: usesEffort(draft.protocol) && reasoning ? reasoning : null,
      thinking,
      anthropic_version: anthropic ? draft.anthropic_version.trim() || null : null,
    },
  };
}

function endpointPreview(draft: Draft) {
  const base = draft.base_url.trim().replace(/\/+$/, "");
  if (!base) return null;
  return base + protocols[draft.protocol].suffix.replace("{model}", encodeURIComponent(draft.model_id.trim() || "{model}"));
}

/** What to try next for a failed connection test. */
function testAdvice(error: ApiError) {
  if (error.code === "CANCELLED") return null;
  if (error.http_status === 401 || error.http_status === 403 || error.code === "AUTH_ERROR") return "Check the API key and that it may use this model.";
  if (error.http_status === 404) return "Check the Base URL's version path and the model ID.";
  if (error.http_status === 400 || error.http_status === 422) return "The service rejected the request. Check the model ID and request parameters.";
  if (error.code === "NETWORK_ERROR") return "Check the Base URL and your network connection.";
  if (error.code === "RATE_LIMITED") return "The service is limiting requests. Try again later.";
  return null;
}

type TestState = { phase: "idle" } | { phase: "testing"; operationId?: string } | { phase: "ok" } | { phase: "failed"; error: ApiError };

/**
 * Settings › Model: the one Custom connection every AI feature uses. Requests
 * go straight to the chosen protocol's endpoint; the key lives in secure storage.
 */
export function ModelSection() {
  const { api, catalog, refreshCatalog, waitForOperation } = useApp();
  const toast = useToast();
  const settings = catalog.settings;
  const saved = settings?.model ?? null;
  const savedKey = JSON.stringify(saved);
  const [draft, setDraft] = useState(() => fromModel(saved));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<TestState>({ phase: "idle" });
  const connectionRevision = useRef(0);
  useEffect(() => {
    setDraft(fromModel(saved));
    setErrors({});
    // Reset only when the saved connection changes.
  }, [savedKey]);

  // A test still running when this section closes is cancelled; its result is not shown.
  const testRef = useRef(test);
  testRef.current = test;
  useEffect(
    () => () => {
      const current = testRef.current;
      if (current.phase === "testing" && current.operationId) void call(() => api.cancelOperation({ operation_id: current.operationId! }));
      testRef.current = { phase: "idle" };
    },
    [api],
  );

  if (!settings) return <p className="muted">Loading…</p>;
  const info = protocols[draft.protocol];
  const dirty = JSON.stringify(draft) !== JSON.stringify(fromModel(saved));
  const endpoint = endpointPreview(draft);
  const insecure = (() => {
    try {
      const url = new URL(draft.base_url.trim());
      return url.protocol === "http:" && !isLocalHost(url.hostname);
    } catch {
      return false;
    }
  })();

  const invalidateTest = () => {
    connectionRevision.current += 1;
    // Keep an in-flight test cancellable, but discard its result after an edit.
    if (testRef.current.phase !== "testing") setTest({ phase: "idle" });
  };
  const change = (next: Partial<Draft>) => {
    setDraft((current) => {
      const merged = { ...current, ...next };
      // The reasoning field means effort text or a thinking object depending on the protocol.
      if (next.protocol && usesEffort(next.protocol) !== usesEffort(current.protocol)) merged.reasoning = "";
      return merged;
    });
    setErrors({});
    invalidateTest();
  };

  const save = async () => {
    const built = toModel(draft);
    if (built.errors) {
      setErrors(built.errors);
      return;
    }
    setSaving(true);
    const response = await call(() => api.saveSettings({ model: built.model }));
    setSaving(false);
    if (!response.ok) {
      setErrors({ form: `${response.error.message} (${response.error.code})` });
      return;
    }
    refreshCatalog();
    toast({ text: "Model connection saved" });
  };

  const runTest = async () => {
    const built = toModel(draft);
    if (built.errors) {
      setErrors(built.errors);
      return;
    }
    setTest({ phase: "testing" });
    testRef.current = { phase: "testing" };
    const revision = connectionRevision.current;
    const started = await call(() => api.testModel({ model: built.model }));
    if (testRef.current.phase !== "testing") return;
    if (!started.ok) {
      setTest(revision === connectionRevision.current ? { phase: "failed", error: started.error } : { phase: "idle" });
      return;
    }
    const operationId = started.result.operation_id;
    setTest({ phase: "testing", operationId });
    testRef.current = { phase: "testing", operationId };
    const outcome = await waitForOperation(operationId);
    const current = testRef.current;
    if (current.phase !== "testing" || current.operationId !== operationId) return;
    setTest(revision !== connectionRevision.current ? { phase: "idle" } : outcome.ok ? { phase: "ok" } : { phase: "failed", error: outcome.error });
  };
  const cancelTest = () => {
    if (test.phase === "testing" && test.operationId) void call(() => api.cancelOperation({ operation_id: test.operationId! }));
  };

  const keyBlocked = settings.model_key_error ? "The saved API key can't be read." : !settings.has_key ? "Save an API key first." : null;
  const error = (key: string) =>
    errors[key] ? (
      <p className="field-error" role="alert">
        {errors[key]}
      </p>
    ) : null;

  return (
    <section aria-labelledby="model-title">
      <header className="section-header">
        <h2 id="model-title">Model connection</h2>
        <p className="muted">
          Job Vaccum calls your model service directly with the protocol you choose. Scoring sends your rubric with each job's title, company and description; a
          connection test sends one short message. Changing the model doesn't rescore existing jobs.
        </p>
      </header>
      <div className="form-grid">
        <label className="form-label" htmlFor="model-protocol">
          Protocol
        </label>
        <select
          id="model-protocol"
          className="select protocol-select"
          value={draft.protocol}
          onChange={(event) => {
            const protocol = event.target.value as Protocol;
            change({ protocol, ...(protocol === "anthropic_messages" && !draft.anthropic_version.trim() ? { anthropic_version: ANTHROPIC_VERSION } : {}) });
          }}
        >
          {protocolIds.map((id) => (
            <option key={id} value={id}>
              {protocols[id].label}
            </option>
          ))}
        </select>

        <label className="form-label" htmlFor="model-base-url">
          Base URL
        </label>
        <div>
          <input
            id="model-base-url"
            className="text-input wide-input"
            value={draft.base_url}
            placeholder={info.example}
            spellCheck={false}
            aria-invalid={errors.base_url ? true : undefined}
            aria-describedby="model-base-url-help"
            onChange={(event) => change({ base_url: event.target.value })}
          />
          {error("base_url")}
          <p className="muted small" id="model-base-url-help">
            Include the version path, like {info.example}. Job Vaccum adds <code>{info.suffix}</code>.
          </p>
          {endpoint ? (
            <p className="endpoint-preview small">
              <span className="muted">Requests go to </span>
              <code>{endpoint}</code>
            </p>
          ) : null}
          {insecure ? <p className="muted small">Use https for services outside this Mac.</p> : null}
        </div>

        <label className="form-label" htmlFor="model-id">
          Model ID
        </label>
        <div>
          <input
            id="model-id"
            className="text-input wide-input"
            value={draft.model_id}
            spellCheck={false}
            aria-invalid={errors.model_id ? true : undefined}
            onChange={(event) => change({ model_id: event.target.value })}
          />
          {error("model_id")}
          {draft.protocol === "gemini_generate_content" ? <p className="muted small">Without the models/ prefix.</p> : null}
        </div>

        <span className="form-label">API key</span>
        <ApiKeyField onChanged={invalidateTest} />
      </div>

      <div className="section-header">
        <h3 className="subsection-title">Request parameters</h3>
        <p className="muted small">
          Leave a field blank to leave it out of the request. Values are sent as entered for {info.label}; if the model doesn't support one, the service's error
          is shown.
        </p>
      </div>
      <div className="form-grid">
        <label className="form-label" htmlFor="model-temperature">
          Temperature
        </label>
        <div>
          <span className="inline-fields">
            <input
              id="model-temperature"
              className="text-input param-input"
              inputMode="decimal"
              value={draft.temperature}
              placeholder="Not sent"
              aria-invalid={errors.temperature ? true : undefined}
              onChange={(event) => change({ temperature: event.target.value })}
            />
            <code className="muted small">{info.temperature}</code>
          </span>
          {error("temperature")}
        </div>

        <label className="form-label" htmlFor="model-max-tokens">
          Max output tokens
        </label>
        <div>
          <span className="inline-fields">
            <input
              id="model-max-tokens"
              className="text-input param-input"
              inputMode="numeric"
              value={draft.max_output_tokens}
              placeholder={draft.protocol === "anthropic_messages" ? "Required" : "Not sent"}
              required={draft.protocol === "anthropic_messages"}
              aria-invalid={errors.max_output_tokens ? true : undefined}
              onChange={(event) => change({ max_output_tokens: event.target.value })}
            />
            <code className="muted small">{info.maxTokens}</code>
            {draft.protocol === "anthropic_messages" ? <span className="muted small">Required by this protocol</span> : null}
          </span>
          {error("max_output_tokens")}
        </div>

        <label className="form-label" htmlFor="model-reasoning">
          {usesEffort(draft.protocol) ? "Reasoning effort" : "Thinking"}
        </label>
        <div>
          {usesEffort(draft.protocol) ? (
            <span className="inline-fields">
              <input
                id="model-reasoning"
                className="text-input param-input"
                value={draft.reasoning}
                placeholder="Not sent"
                spellCheck={false}
                onChange={(event) => change({ reasoning: event.target.value })}
              />
              <code className="muted small">{info.reasoning}</code>
            </span>
          ) : (
            <>
              <input
                id="model-reasoning"
                className="text-input wide-input mono-input"
                value={draft.reasoning}
                placeholder="Not sent"
                spellCheck={false}
                aria-invalid={errors.reasoning ? true : undefined}
                aria-describedby="model-reasoning-help"
                onChange={(event) => change({ reasoning: event.target.value })}
              />
              {error("reasoning")}
            </>
          )}
          <p className="muted small" id="model-reasoning-help">
            {usesEffort(draft.protocol) ? (
              <>For reasoning models, for example {info.reasoningExample}.</>
            ) : (
              <>
                A JSON object sent as <code>{info.reasoning}</code>, for example <code>{info.reasoningExample}</code>.
              </>
            )}
          </p>
        </div>

        {draft.protocol === "anthropic_messages" ? (
          <>
            <label className="form-label" htmlFor="model-anthropic-version">
              API version
            </label>
            <span className="inline-fields">
              <input
                id="model-anthropic-version"
                className="text-input param-input"
                value={draft.anthropic_version}
                placeholder={ANTHROPIC_VERSION}
                spellCheck={false}
                onChange={(event) => change({ anthropic_version: event.target.value })}
              />
              <code className="muted small">anthropic-version</code>
            </span>
          </>
        ) : null}
      </div>

      {error("form")}
      <div className="form-actions">
        <TestResult test={test} onCancel={cancelTest} />
        <button
          type="button"
          className="button"
          disabled={test.phase === "testing" || !!keyBlocked}
          title={keyBlocked ?? "Send one short message with the settings above, saved or not"}
          onClick={() => void runTest()}
        >
          {test.phase === "testing" ? "Testing…" : "Test connection"}
        </button>
        {dirty ? (
          <button type="button" className="link-button" onClick={() => change(fromModel(saved))}>
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

function TestResult({ test, onCancel }: { test: TestState; onCancel: () => void }) {
  if (test.phase === "idle") return <span className="test-result" />;
  if (test.phase === "testing") {
    return (
      <span className="test-result muted" role="status">
        Waiting for the service…{" "}
        {test.operationId ? (
          <button type="button" className="link-button" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </span>
    );
  }
  if (test.phase === "ok") {
    return (
      <span className="test-result status-text" data-tone="ok" role="status">
        <span className="dot" aria-hidden="true" />
        Connected. The model replied.
      </span>
    );
  }
  if (test.error.code === "CANCELLED") {
    return (
      <span className="test-result muted" role="status">
        Test cancelled.
      </span>
    );
  }
  const advice = testAdvice(test.error);
  return (
    <span className="test-result">
      <span className="error-text" role="alert">
        <span>
          Couldn't connect. {test.error.message}
          {advice ? ` ${advice}` : ""}
        </span>{" "}
        <span className="error-code">
          {test.error.code}
          {test.error.http_status ? ` · HTTP ${test.error.http_status}` : ""}
        </span>
      </span>
    </span>
  );
}

/**
 * The key is saved on its own into the Mac's secure storage and never shown
 * again; settings and exports only know whether one is saved.
 */
function ApiKeyField({ onChanged }: { onChanged: () => void }) {
  const { api, catalog, refreshCatalog } = useApp();
  const toast = useToast();
  const settings = catalog.settings!;
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!key.trim()) {
      setError("Paste the API key.");
      return;
    }
    if (/[\r\n]/.test(key)) {
      setError("An API key is a single line.");
      return;
    }
    setSaving(true);
    const response = await call(() => api.setModelKey({ key }));
    setSaving(false);
    if (!response.ok) {
      setError(`${response.error.message} (${response.error.code})`);
      return;
    }
    setKey("");
    onChanged();
    refreshCatalog();
    toast({ text: "API key saved" });
  };
  const remove = async () => {
    const response = await call(() => api.deleteModelKey());
    if (!response.ok) {
      toast({ text: `Couldn't remove the API key. ${response.error.message}`, code: response.error.code, error: true });
      return;
    }
    onChanged();
    refreshCatalog();
    toast({ text: "API key removed" });
  };

  const stored = settings.has_key || settings.model_key_error;
  return (
    <div>
      <span className="inline-fields key-row">
        <input
          id="model-key"
          type="password"
          className="text-input wide-input"
          autoComplete="off"
          spellCheck={false}
          value={key}
          aria-label="API key"
          placeholder={settings.has_key ? "Saved · paste a new key to replace it" : "Paste your API key"}
          aria-invalid={error ? true : undefined}
          aria-describedby="model-key-help"
          onChange={(event) => {
            setKey(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void save();
          }}
        />
        <button type="button" className="button" disabled={saving || !key} onClick={() => void save()}>
          {settings.has_key ? "Replace key" : "Save key"}
        </button>
      </span>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {settings.model_key_error ? (
        <div className="key-error">
          <ErrorText error={settings.model_key_error} block />
          <p className="muted small">Paste the key again to replace it, or remove it. Scoring and tests stay off until then; searching still works.</p>
        </div>
      ) : null}
      <p className="muted small" id="model-key-help">
        {settings.has_key ? "Saved in this Mac's secure storage; it's never shown again." : "Kept in this Mac's secure storage, never in settings, logs or exports."}
        {stored ? (
          <>
            {" "}
            <button type="button" className="link-button" onClick={() => void remove()}>
              Remove key
            </button>
          </>
        ) : null}
      </p>
    </div>
  );
}
