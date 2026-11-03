import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  aiInsightStatus,
  InsightsAiError,
  requestAiInsights,
  type InsightsInput,
} from "./insights-ai";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRouterStatus, removeSavedOpenRouterKey, saveOpenRouterKey } from "./openrouter-config";

const originalKey = process.env.OPENROUTER_API_KEY;
afterEach(() => {
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
});

const input: InsightsInput = {
  intent: "Find a smooth next track",
  candidates: [{
    id: "video-1",
    title: "Track",
    artist: "Artist",
    playlist: "Bass",
    flags: [],
    evidence: ["Exact upstream video ID match"],
  }],
};

describe("OpenRouter insights", () => {
  test("status reveals configuration presence but never the key", () => {
    process.env.OPENROUTER_API_KEY = "top-secret";
    expect(aiInsightStatus()).toEqual({ configured: true, source: "environment", model: "openrouter/free" });
    expect(JSON.stringify(aiInsightStatus())).not.toContain("top-secret");
  });

  test("uses only the free router and validates a grounded response", async () => {
    const fetchMock = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("openrouter/free");
      expect(body.models).toBeUndefined();
      expect(body.provider).toEqual({ require_parameters: true });
      expect(body.response_format.json_schema.strict).toBe(true);
      expect(init?.headers).toMatchObject({ authorization: "Bearer test-key" });
      return Response.json({
        choices: [{ message: { content: JSON.stringify({
          summary: "One grounded option.",
          suggestions: [{ candidateId: "video-1", reason: "Exact ID match." }],
        }) } }],
      });
    });

    expect(await requestAiInsights(input, { apiKey: "test-key", fetch: fetchMock })).toEqual({
      summary: "One grounded option.",
      suggestions: [{ candidateId: "video-1", reason: "Exact ID match." }],
      model: "openrouter/free",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("rejects invented candidate IDs", async () => {
    const fetchMock = mock(async () => Response.json({
      choices: [{ message: { content: JSON.stringify({
        summary: "Bad",
        suggestions: [{ candidateId: "invented", reason: "Made up" }],
      }) } }],
    }));
    await expect(requestAiInsights(input, { apiKey: "test-key", fetch: fetchMock }))
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  test("does not call the network without server configuration", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const fetchMock = mock(async () => Response.json({}));
    await expect(requestAiInsights(input, { fetch: fetchMock })).rejects.toEqual(
      new InsightsAiError(
        "not_configured",
        "AI steering is optional. Add an OpenRouter key in settings to use it.",
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("saves, uses, and removes an app-local key without revealing it", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const directory = mkdtempSync(join(tmpdir(), "dj-organizer-openrouter-"));
    const path = join(directory, "config.json");
    const secret = "sk-or-v1-local-test-secret";
    try {
      expect(saveOpenRouterKey(secret, path)).toEqual({
        configured: true, source: "saved", model: "openrouter/free",
      });
      expect(JSON.stringify(openRouterStatus(path))).not.toContain(secret);
      expect(readFileSync(path, "utf8")).toContain(secret);

      const fetchMock = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.headers).toMatchObject({ authorization: `Bearer ${secret}` });
        return Response.json({ choices: [{ message: { content: JSON.stringify({
          summary: "Grounded.", suggestions: [{ candidateId: "video-1", reason: "Exact match." }],
        }) } }] });
      });
      await requestAiInsights(input, { configPath: path, fetch: fetchMock });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      expect(removeSavedOpenRouterKey(path)).toEqual({
        configured: false, source: null, model: "openrouter/free",
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("environment configuration takes priority over a saved key", () => {
    const directory = mkdtempSync(join(tmpdir(), "dj-organizer-openrouter-"));
    const path = join(directory, "config.json");
    try {
      saveOpenRouterKey("saved-secret-key", path);
      process.env.OPENROUTER_API_KEY = "environment-secret-key";
      expect(openRouterStatus(path).source).toBe("environment");
      expect(removeSavedOpenRouterKey(path).source).toBe("environment");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("turns timeout and upstream failures into user-readable errors", async () => {
    const hangingFetch = mock((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }));
    await expect(requestAiInsights(input, {
      apiKey: "test-key", fetch: hangingFetch, timeoutMs: 1,
    })).rejects.toMatchObject({ code: "timeout" });

    const failedFetch = mock(async () => new Response("internal details", { status: 503 }));
    await expect(requestAiInsights(input, { apiKey: "test-key", fetch: failedFetch }))
      .rejects.toMatchObject({ code: "unavailable" });
  });
});
