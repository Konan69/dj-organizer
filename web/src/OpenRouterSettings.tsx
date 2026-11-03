import { useState } from "react";
import "./openrouter-settings.css";

export type OpenRouterStatus = {
  configured: boolean;
  source: "environment" | "saved" | null;
  model: "openrouter/free";
};

async function request(method: "PUT" | "DELETE", apiKey?: string): Promise<OpenRouterStatus> {
  const response = await fetch("/api/suggestions/ai/config", {
    method,
    headers: apiKey === undefined ? undefined : { "content-type": "application/json" },
    body: apiKey === undefined ? undefined : JSON.stringify({ apiKey }),
  });
  const value = await response.json() as OpenRouterStatus & { error?: string };
  if (!response.ok) throw new Error(value.error || "Could not update OpenRouter settings.");
  return value;
}

/**
 * The OpenRouter key form inside Suggestions' setup disclosure. The details
 * (where the key lives, that saving never calls OpenRouter) sit in tooltips;
 * the form itself is a status, a field and two buttons.
 */
export function OpenRouterSettings({ status, onStatus }: {
  status: OpenRouterStatus;
  onStatus: (status: OpenRouterStatus) => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    if (!key.trim()) return;
    setBusy(true); setMessage(null);
    try {
      onStatus(await request("PUT", key));
      setKey(""); setMessage("Key saved");
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true); setMessage(null);
    try {
      const next = await request("DELETE");
      onStatus(next);
      setMessage(next.configured ? "Key removed. The server key is still active." : "Key removed");
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };

  const where = status.source === "environment" ? "server environment" : "saved on this server";

  return (
    <div className="or-settings">
      <span
        className={`ui-tag ${status.configured ? "ok" : ""}`}
        title={status.configured ? `Key from the ${where} · model ${status.model}` : `Model ${status.model}`}
      >
        <span className="ui-dot" />{status.configured ? "Steering on" : "Steering off"}
      </span>
      {status.source !== "environment" ? (
        <div className="or-settings-row">
          <label className="ui-field">
            <input type="password" value={key} autoComplete="off" spellCheck={false}
              placeholder={status.configured ? "Replace key" : "OpenRouter API key"}
              aria-label="OpenRouter API key" onChange={(event) => setKey(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void save(); }} />
          </label>
          <button
            type="button" className="ui-btn outline" onClick={() => void save()} disabled={busy || !key.trim()}
            title="Stored in the app's server data and never shown again. Saving does not test or spend it."
          >Save key</button>
          {status.source === "saved" ? (
            <button type="button" className="ui-btn ghost danger" onClick={() => void remove()} disabled={busy}>
              Remove
            </button>
          ) : null}
        </div>
      ) : null}
      {message ? <div className="or-settings-message" role="status">{message}</div> : null}
    </div>
  );
}
