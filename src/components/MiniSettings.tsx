"use client";

import { useState, useEffect } from "react";
import { loadSettings, saveSettings, getActiveProfile } from "@/components/SettingsDrawer";
import type { AppSettings } from "@/components/SettingsDrawer";

/**
 * Self-contained settings gear button + minimal drawer for sub-pages (Snipe, Notify).
 * Handles Resy auth token entry without needing any parent state.
 */
export default function MiniSettings() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [authMode, setAuthMode] = useState<"token" | "password">("token");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    const profile = getActiveProfile() ?? undefined;
    const s = loadSettings(profile);
    setSettings(s);
    setTokenInput(s.resyAuthToken ?? "");
  }, [open]);

  function update(patch: Partial<AppSettings>) {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next, getActiveProfile() ?? undefined);
  }

  async function handleSaveToken() {
    update({ resyAuthToken: tokenInput.trim() });
    setMessage({ type: "ok", text: "Token saved." });
    setTimeout(() => setMessage(null), 2000);
  }

  async function handleLogin() {
    if (!email || !password) return;
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch("/api/resy-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (data.authToken) {
        update({ resyAuthToken: data.authToken, resyEmail: email, resyPassword: password });
        setTokenInput(data.authToken);
        setMessage({ type: "ok", text: `Logged in as ${data.firstName ?? email}` });
        setTimeout(() => setMessage(null), 3000);
      } else {
        setMessage({ type: "err", text: data.error ?? "Login failed" });
      }
    } catch (err) {
      setMessage({ type: "err", text: String(err) });
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    update({ resyAuthToken: "" });
    setTokenInput("");
    setMessage({ type: "ok", text: "Logged out." });
    setTimeout(() => setMessage(null), 2000);
  }

  const isAuthenticated = Boolean(settings?.resyAuthToken);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Settings"
        className="flex items-center gap-1.5 text-sm text-stone-300 hover:text-white transition-colors border border-stone-700 hover:border-stone-500 px-2.5 py-2 rounded-lg"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <span className="hidden sm:inline">Settings</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="relative bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-md p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-semibold text-gray-900 text-lg">Settings</h2>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>

            {/* Resy Auth */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-medium text-gray-800">Resy Account</h3>
                {isAuthenticated && (
                  <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">Connected</span>
                )}
              </div>

              <div className="flex gap-2 mb-3">
                <button
                  onClick={() => setAuthMode("token")}
                  className={`flex-1 py-1.5 text-sm rounded-lg transition-colors ${authMode === "token" ? "bg-orange-500 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                >
                  Token
                </button>
                <button
                  onClick={() => setAuthMode("password")}
                  className={`flex-1 py-1.5 text-sm rounded-lg transition-colors ${authMode === "password" ? "bg-orange-500 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                >
                  Email / Password
                </button>
              </div>

              {authMode === "token" ? (
                <div className="space-y-2">
                  <input
                    type="text"
                    placeholder="Paste Resy auth token..."
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-orange-300"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleSaveToken}
                      disabled={!tokenInput.trim()}
                      className="flex-1 py-2 text-sm bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-50 transition-colors"
                    >
                      Save Token
                    </button>
                    {isAuthenticated && (
                      <button
                        onClick={handleLogout}
                        className="px-4 py-2 text-sm bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 transition-colors"
                      >
                        Logout
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <input
                    type="email"
                    placeholder="Resy email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                  />
                  <input
                    type="password"
                    placeholder="Resy password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleLogin}
                      disabled={loading || !email || !password}
                      className="flex-1 py-2 text-sm bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-50 transition-colors"
                    >
                      {loading ? "Logging in..." : "Log In"}
                    </button>
                    {isAuthenticated && (
                      <button
                        onClick={handleLogout}
                        className="px-4 py-2 text-sm bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 transition-colors"
                      >
                        Logout
                      </button>
                    )}
                  </div>
                </div>
              )}

              {message && (
                <p className={`mt-2 text-xs ${message.type === "ok" ? "text-emerald-600" : "text-red-500"}`}>
                  {message.text}
                </p>
              )}
            </section>

            <p className="mt-5 text-xs text-gray-400">
              For full settings (party size, time windows, notifications), visit the Live screen.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
