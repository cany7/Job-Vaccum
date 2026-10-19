import { useEffect, useState } from "react";
import { call } from "./api";
import { useApp } from "./context";
import { useToast } from "./toasts";

const ORIGIN = /^(https?|socks5):\/\/[^/@\s:]+(:\d+)$|^(https?|socks5):\/\/\[[0-9a-fA-F:.]+\](:\d+)$/;

/**
 * Settings › Proxy: direct connection or one ordinary proxy for both sites.
 * The address holds no sign-in; a username and password are kept by the Mac's
 * secure storage and never shown again.
 */
export function ProxySection() {
  const { api, catalog, refreshCatalog } = useApp();
  const toast = useToast();
  const settings = catalog.settings;
  const saved = settings?.proxy ?? { mode: "off" as const, url: null };
  const [mode, setMode] = useState(saved.mode);
  const [address, setAddress] = useState(saved.url ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const savedKey = JSON.stringify(saved);
  useEffect(() => {
    setMode(saved.mode);
    setAddress(saved.url ?? "");
    setError(null);
  }, [savedKey]);

  if (!settings) return <p className="muted">Loading…</p>;
  const trimmed = address.trim().replace(/\/$/, "");
  const dirty = mode !== saved.mode || (trimmed || null) !== saved.url;

  const save = async () => {
    if (trimmed && !ORIGIN.test(trimmed)) {
      setError("Enter an http, https or socks5 address with a port, like http://127.0.0.1:8080, without a username or path.");
      return;
    }
    if (mode === "ordinary" && !trimmed) {
      setError("Enter the proxy address.");
      return;
    }
    setSaving(true);
    const response = await call(() => api.saveSettings({ proxy: { mode, url: trimmed || null } }));
    setSaving(false);
    if (!response.ok) {
      setError(`${response.error.message} (${response.error.code})`);
      return;
    }
    refreshCatalog();
    toast({ text: mode === "off" ? "Runs connect directly" : "Runs use the proxy" });
  };

  const saveSignIn = async () => {
    if (!saved.url) return;
    if (!user.trim() || !password) {
      setSignInError("Enter a username and password.");
      return;
    }
    const [scheme, host] = saved.url.split("://");
    setSigningIn(true);
    const response = await call(() => api.setProxyCredential({ url: `${scheme}://${encodeURIComponent(user.trim())}:${encodeURIComponent(password)}@${host}` }));
    setSigningIn(false);
    if (!response.ok) {
      setSignInError(`${response.error.message} (${response.error.code})`);
      return;
    }
    setUser("");
    setPassword("");
    refreshCatalog();
    toast({ text: "Proxy sign-in saved" });
  };
  const removeSignIn = async () => {
    const response = await call(() => api.deleteProxyCredential());
    if (!response.ok) {
      toast({ text: `Couldn't remove the proxy sign-in. ${response.error.message}`, code: response.error.code, error: true });
      return;
    }
    refreshCatalog();
    toast({ text: "Proxy sign-in removed" });
  };

  return (
    <section aria-labelledby="proxy-title">
      <header className="section-header">
        <h2 id="proxy-title">Proxy</h2>
        <p className="muted">
          LinkedIn limits frequent searches; a proxy helps with larger runs. Job Vaccum never falls back to a direct connection when the proxy fails. Changes apply to
          the next run.
        </p>
      </header>
      <fieldset className="dialog-group">
        <legend className="visually-hidden">Connection</legend>
        <label className="choice">
          <input type="radio" name="proxy-mode" checked={mode === "off"} onChange={() => (setMode("off"), setError(null))} />
          <span>
            Direct connection
            <span className="choice-note">Ignores system and environment proxy settings.</span>
          </span>
        </label>
        <label className="choice">
          <input type="radio" name="proxy-mode" checked={mode === "ordinary"} onChange={() => (setMode("ordinary"), setError(null))} />
          <span>
            Proxy for LinkedIn and Indeed
            <span className="choice-note">Every request goes through one address. Job Vaccum doesn't switch nodes for you.</span>
          </span>
        </label>
      </fieldset>
      <div className="form-grid">
        <label className="form-label" htmlFor="proxy-address">
          Address
        </label>
        <div>
          <input
            id="proxy-address"
            className="text-input wide-input"
            value={address}
            placeholder="http://127.0.0.1:8080"
            aria-invalid={error ? true : undefined}
            aria-describedby="proxy-help"
            onChange={(event) => {
              setAddress(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && dirty) void save();
            }}
          />
          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}
          <p className="muted small" id="proxy-help">
            http, https or socks5 with a port. Put a username and password under Sign-in, not in the address.
          </p>
        </div>
      </div>
      <div className="form-actions">
        <button type="button" className="button button-primary" disabled={!dirty || saving} onClick={() => void save()}>
          Save
        </button>
      </div>

      <hr className="divider" />
      <header className="section-header">
        <h2>Sign-in</h2>
        <p className="muted">
          {settings.has_proxy_credentials
            ? "A username and password are saved for this proxy in secure storage."
            : "Only if your proxy asks for a username and password."}
        </p>
      </header>
      {saved.url ? (
        <>
          <div className="form-grid">
            <label className="form-label" htmlFor="proxy-user">
              Username
            </label>
            <input id="proxy-user" className="text-input wide-input" autoComplete="off" value={user} onChange={(event) => (setUser(event.target.value), setSignInError(null))} />
            <label className="form-label" htmlFor="proxy-password">
              Password
            </label>
            <input
              id="proxy-password"
              type="password"
              className="text-input wide-input"
              autoComplete="off"
              value={password}
              onChange={(event) => (setPassword(event.target.value), setSignInError(null))}
            />
          </div>
          {signInError ? (
            <p className="field-error" role="alert">
              {signInError}
            </p>
          ) : null}
          <div className="form-actions">
            {settings.has_proxy_credentials ? (
              <button type="button" className="link-button" onClick={() => void removeSignIn()}>
                Remove saved sign-in
              </button>
            ) : null}
            <button type="button" className="button" disabled={signingIn} onClick={() => void saveSignIn()}>
              {settings.has_proxy_credentials ? "Replace sign-in" : "Save sign-in"}
            </button>
          </div>
          <p className="muted small">Saved for {saved.url}. If you change the address, save the sign-in again.</p>
        </>
      ) : (
        <div className="form-actions form-actions-start">
          <span className="muted small">Save a proxy address first.</span>
          {settings.has_proxy_credentials ? (
            <button type="button" className="link-button" onClick={() => void removeSignIn()}>
              Remove saved sign-in
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
