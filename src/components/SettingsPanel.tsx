"use client";

import { useState, useEffect } from "react";
import type { UserSettings } from "@/lib/emailTemplates";

const STORAGE_KEY = "hopeyeats_settings";

const DEFAULT_SETTINGS: UserSettings = {
  name: "",
  email: "",
  gmailAppPassword: "",
  diningDateStart: "",
  diningDateEnd: "",
  partySize: 2,
  specialRequests: "",
};

interface Props {
  onClose: () => void;
  onChange: (settings: UserSettings) => void;
}

export default function SettingsPanel({ onClose, onChange }: Props) {
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as UserSettings;
      setSettings(parsed);
      onChange(parsed);
    }
  }, [onChange]);

  function update<K extends keyof UserSettings>(key: K, value: UserSettings[K]) {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    onChange(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative w-full max-w-md h-full bg-[#FAF7F2] shadow-2xl overflow-y-auto">
        <div className="p-6 border-b border-stone-200">
          <div className="flex items-center justify-between">
            <h2 className="font-serif text-xl text-[#1C1C1C]">Settings</h2>
            <button
              onClick={onClose}
              className="text-stone-400 hover:text-stone-700 transition-colors text-2xl leading-none"
            >
              ×
            </button>
          </div>
          <p className="text-sm text-stone-500 mt-1">
            Your preferences are saved locally and never sent to any server
            except when you send an email.
          </p>
        </div>

        <div className="p-6 space-y-6">
          {/* Personal Info */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-stone-400 mb-3">
              Your Info
            </h3>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">
                  Your Name
                </label>
                <input
                  type="text"
                  value={settings.name}
                  onChange={(e) => update("name", e.target.value)}
                  placeholder="Jane Smith"
                  className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#C9A84C]/50 bg-white"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">
                  Your Gmail Address
                </label>
                <input
                  type="email"
                  value={settings.email}
                  onChange={(e) => update("email", e.target.value)}
                  placeholder="you@gmail.com"
                  className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#C9A84C]/50 bg-white"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">
                  Gmail App Password
                  <span className="ml-1 text-xs text-stone-400 font-normal">
                    (not your regular password)
                  </span>
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={settings.gmailAppPassword}
                    onChange={(e) => update("gmailAppPassword", e.target.value)}
                    placeholder="xxxx xxxx xxxx xxxx"
                    className="w-full px-3 py-2 pr-16 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#C9A84C]/50 bg-white font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((p) => !p)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-stone-400 hover:text-stone-600"
                  >
                    {showPassword ? "Hide" : "Show"}
                  </button>
                </div>
                <p className="text-xs text-stone-400 mt-1">
                  Generate at: Google Account → Security → 2-Step Verification → App Passwords
                </p>
              </div>
            </div>
          </section>

          {/* Dining Preferences */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-stone-400 mb-3">
              Dining Window
            </h3>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-1">
                    Earliest Date
                  </label>
                  <input
                    type="date"
                    value={settings.diningDateStart}
                    onChange={(e) => update("diningDateStart", e.target.value)}
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#C9A84C]/50 bg-white"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-1">
                    Latest Date
                  </label>
                  <input
                    type="date"
                    value={settings.diningDateEnd}
                    onChange={(e) => update("diningDateEnd", e.target.value)}
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#C9A84C]/50 bg-white"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">
                  Party Size
                </label>
                <select
                  value={settings.partySize}
                  onChange={(e) =>
                    update("partySize", parseInt(e.target.value))
                  }
                  className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#C9A84C]/50 bg-white"
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                    <option key={n} value={n}>
                      {n} {n === 1 ? "guest" : "guests"}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">
                  Special Requests
                </label>
                <textarea
                  value={settings.specialRequests}
                  onChange={(e) => update("specialRequests", e.target.value)}
                  placeholder="e.g. celebrating an anniversary, prefer a quiet table, one vegetarian guest..."
                  rows={3}
                  className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#C9A84C]/50 bg-white resize-none"
                />
              </div>
            </div>
          </section>
        </div>

        <div className="sticky bottom-0 bg-[#FAF7F2] border-t border-stone-200 p-6">
          <button
            onClick={save}
            className="w-full py-3 bg-[#1C1C1C] text-white rounded-lg text-sm font-medium hover:bg-[#333] transition-colors"
          >
            {saved ? "Saved!" : "Save Settings"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function loadSettings(): UserSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return DEFAULT_SETTINGS;
  return JSON.parse(stored) as UserSettings;
}
