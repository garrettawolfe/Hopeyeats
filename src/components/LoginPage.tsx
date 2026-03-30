"use client";

import { useState } from "react";

interface Props {
  profiles: string[];
  activeProfile: string | null;
  onSwitchProfile: (name: string) => void;
  onCreateProfile: (name: string) => void;
  onTokenAuth: (token: string) => Promise<true | string>;
  onSkip: () => void;
}

export default function LoginPage({
  profiles,
  activeProfile,
  onSwitchProfile,
  onCreateProfile,
  onTokenAuth,
  onSkip,
}: Props) {
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [showNewProfile, setShowNewProfile] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);

  const handleSubmit = async () => {
    const t = token.trim();
    if (!t) return;
    setLoading(true);
    setError(null);
    const result = await onTokenAuth(t);
    if (typeof result === "string") setError(result);
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <h1 className="font-serif text-4xl text-charcoal tracking-tight">HopeYeats</h1>
          <p className="text-stone-400 text-sm mt-1">NYC Restaurant Reservation Monitor</p>
        </div>

        <div className="bg-white rounded-2xl shadow-lg border border-stone-200 overflow-hidden">
          {/* Profile selector */}
          <div className="px-6 pt-6 pb-4 border-b border-stone-100">
            <label className="text-xs font-semibold text-charcoal uppercase tracking-wider block mb-2">Profile</label>
            <div className="flex flex-wrap gap-2">
              {profiles.map((p) => (
                <button
                  key={p}
                  onClick={() => onSwitchProfile(p)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    activeProfile === p
                      ? "bg-charcoal text-white"
                      : "bg-stone-100 text-stone-500 hover:bg-stone-200"
                  }`}
                >
                  {p}
                </button>
              ))}
              {showNewProfile ? (
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newName.trim()) {
                        onCreateProfile(newName.trim());
                        setNewName("");
                        setShowNewProfile(false);
                      }
                    }}
                    placeholder="Name"
                    autoFocus
                    className="w-28 px-3 py-2 border border-stone-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gold/50"
                  />
                  <button
                    onClick={() => {
                      if (newName.trim()) {
                        onCreateProfile(newName.trim());
                        setNewName("");
                        setShowNewProfile(false);
                      }
                    }}
                    className="text-emerald-600 text-sm font-medium"
                  >
                    Add
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowNewProfile(true)}
                  className="px-4 py-2 rounded-lg text-sm font-medium border border-dashed border-stone-300 text-stone-400 hover:bg-stone-50"
                >
                  + New
                </button>
              )}
            </div>
          </div>

          {/* Token input */}
          <div className="p-6 space-y-4">
            <div>
              <label className="text-xs font-semibold text-charcoal uppercase tracking-wider block mb-2">
                Resy Auth Token
              </label>
              <textarea
                placeholder="Paste your token here..."
                value={token}
                onChange={(e) => setToken(e.target.value)}
                rows={3}
                className="w-full px-4 py-3 border border-stone-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-gold/50 font-mono text-[11px] resize-none"
              />
            </div>

            <button
              onClick={handleSubmit}
              disabled={loading || !token.trim()}
              className="w-full py-3 bg-charcoal text-white rounded-xl text-sm font-semibold hover:bg-charcoal/90 transition-colors disabled:opacity-40"
            >
              {loading ? "Validating..." : "Connect"}
            </button>

            {error && <p className="text-xs text-red-500 text-center">{error}</p>}

            {/* Get token help */}
            <div className="space-y-3">
              <button
                onClick={() => {
                  window.open("https://resy.com", "_blank", "noopener,noreferrer");
                  setShowInstructions(true);
                }}
                className="w-full py-2.5 border border-stone-200 rounded-xl text-sm font-medium text-stone-600 hover:bg-stone-50 transition-colors flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                Open Resy.com to get token
              </button>

              {showInstructions && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-2">
                  <p className="text-xs font-semibold text-amber-800">Resy.com is open — now get your token:</p>
                  <ol className="text-xs text-amber-700 space-y-1.5 list-decimal pl-4">
                    <li>Log in to Resy if you aren&apos;t already</li>
                    <li>Right-click anywhere &rarr; <strong>Inspect</strong> (or press F12)</li>
                    <li>Click the <strong>Network</strong> tab at the top</li>
                    <li>Click any link on resy.com to trigger network requests</li>
                    <li>Click any request to <strong>api.resy.com</strong></li>
                    <li>Under <strong>Request Headers</strong>, find <strong>x-resy-auth-token</strong></li>
                    <li>Copy that long value and paste it above</li>
                  </ol>
                  <p className="text-[10px] text-amber-600 mt-2">
                    Alternative: Application tab &rarr; Cookies &rarr; resy.com &rarr; <strong>authToken</strong>
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Skip */}
          <div className="px-6 pb-6">
            <button
              onClick={onSkip}
              className="w-full text-xs text-stone-400 hover:text-stone-600 underline"
            >
              Skip — monitor without auto-booking
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
