"use client";

import { useState, useEffect } from "react";
import { SMS_GATEWAYS } from "@/lib/notifications";

export interface AppSettings {
  // Resy credentials
  resyEmail: string;
  resyPassword: string;
  // Dining preferences
  partySize: number;
  preferredDays: string[];
  timeWindowStart: string;
  timeWindowEnd: string;
  // Notification
  notifyEmail: string;
  gmailUser: string;
  gmailAppPassword: string;
  smsPhone: string;
  smsCarrier: string;
  // Auto-book
  autoBookEnabled: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  resyEmail: "",
  resyPassword: "",
  partySize: 2,
  preferredDays: ["wednesday", "thursday", "friday", "saturday"],
  timeWindowStart: "18:00",
  timeWindowEnd: "21:30",
  notifyEmail: "",
  gmailUser: "",
  gmailAppPassword: "",
  smsPhone: "",
  smsCarrier: "verizon",
  autoBookEnabled: false,
};

const STORAGE_KEY = "hopeyeats_v2_settings";

const DAYS = [
  { key: "monday", label: "Mon" },
  { key: "tuesday", label: "Tue" },
  { key: "wednesday", label: "Wed" },
  { key: "thursday", label: "Thu" },
  { key: "friday", label: "Fri" },
  { key: "saturday", label: "Sat" },
  { key: "sunday", label: "Sun" },
];

interface Props {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSettingsChange: (s: AppSettings) => void;
  resyAuth: { authenticated: boolean; firstName?: string; lastName?: string } | null;
  onResyLogin: (email: string, password: string) => Promise<boolean>;
  onResyLogout: () => void;
}

export function loadSettings(): AppSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
    } catch {
      return DEFAULT_SETTINGS;
    }
  }
  return DEFAULT_SETTINGS;
}

export function saveSettings(s: AppSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

export default function SettingsDrawer({
  open,
  onClose,
  settings,
  onSettingsChange,
  resyAuth,
  onResyLogin,
  onResyLogout,
}: Props) {
  const [local, setLocal] = useState<AppSettings>(settings);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    setLocal(settings);
  }, [settings]);

  if (!open) return null;

  const update = (patch: Partial<AppSettings>) => {
    const next = { ...local, ...patch };
    setLocal(next);
    onSettingsChange(next);
    saveSettings(next);
  };

  const toggleDay = (day: string) => {
    const days = local.preferredDays.includes(day)
      ? local.preferredDays.filter((d) => d !== day)
      : [...local.preferredDays, day];
    update({ preferredDays: days });
  };

  const handleLogin = async () => {
    setLoginLoading(true);
    setLoginError(null);
    const ok = await onResyLogin(local.resyEmail, local.resyPassword);
    if (!ok) setLoginError("Login failed — check your credentials");
    setLoginLoading(false);
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 z-40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-white z-50 shadow-2xl overflow-y-auto">
        <div className="p-6">
          {/* Header */}
          <div className="flex items-center justify-between mb-8">
            <h2 className="text-xl font-semibold text-charcoal">Settings</h2>
            <button
              onClick={onClose}
              className="p-2 hover:bg-stone-100 rounded-lg transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Resy Account */}
          <section className="mb-8">
            <h3 className="text-sm font-semibold text-charcoal uppercase tracking-wider mb-3">
              Resy Account
            </h3>
            {resyAuth?.authenticated ? (
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-emerald-800">
                      Logged in as {resyAuth.firstName} {resyAuth.lastName}
                    </p>
                    <p className="text-xs text-emerald-600 mt-0.5">
                      Auto-booking enabled
                    </p>
                  </div>
                  <button
                    onClick={onResyLogout}
                    className="text-xs text-stone-400 hover:text-red-500 underline"
                  >
                    Logout
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <input
                  type="email"
                  placeholder="Resy email"
                  value={local.resyEmail}
                  onChange={(e) => update({ resyEmail: e.target.value })}
                  className="w-full px-4 py-2.5 border border-stone-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-gold/50"
                />
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    placeholder="Resy password"
                    value={local.resyPassword}
                    onChange={(e) => update({ resyPassword: e.target.value })}
                    className="w-full px-4 py-2.5 border border-stone-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-gold/50 pr-16"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-stone-400 hover:text-stone-600"
                  >
                    {showPassword ? "Hide" : "Show"}
                  </button>
                </div>
                <button
                  onClick={handleLogin}
                  disabled={loginLoading || !local.resyEmail || !local.resyPassword}
                  className="w-full py-2.5 bg-charcoal text-white rounded-xl text-sm font-medium hover:bg-charcoal/90 transition-colors disabled:opacity-40"
                >
                  {loginLoading ? "Logging in..." : "Connect Resy Account"}
                </button>
                {loginError && (
                  <p className="text-xs text-red-500">{loginError}</p>
                )}
                <p className="text-[10px] text-stone-400">
                  Required for auto-booking. Your credentials are only sent to Resy's API and stored in your browser.
                </p>
              </div>
            )}
          </section>

          {/* Dining Preferences */}
          <section className="mb-8">
            <h3 className="text-sm font-semibold text-charcoal uppercase tracking-wider mb-3">
              Dining Preferences
            </h3>
            <div className="space-y-4">
              <div>
                <label className="text-xs text-stone-500 mb-1.5 block">Party Size</label>
                <div className="flex gap-2">
                  {[1, 2, 3, 4, 5, 6].map((n) => (
                    <button
                      key={n}
                      onClick={() => update({ partySize: n })}
                      className={`w-10 h-10 rounded-lg text-sm font-medium transition-colors ${
                        local.partySize === n
                          ? "bg-charcoal text-white"
                          : "bg-stone-100 text-stone-500 hover:bg-stone-200"
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs text-stone-500 mb-1.5 block">Preferred Days</label>
                <div className="flex gap-1.5">
                  {DAYS.map((d) => (
                    <button
                      key={d.key}
                      onClick={() => toggleDay(d.key)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                        local.preferredDays.includes(d.key)
                          ? "bg-charcoal text-white"
                          : "bg-stone-100 text-stone-400 hover:bg-stone-200"
                      }`}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-stone-500 mb-1.5 block">Earliest Time</label>
                  <input
                    type="time"
                    value={local.timeWindowStart}
                    onChange={(e) => update({ timeWindowStart: e.target.value })}
                    className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs text-stone-500 mb-1.5 block">Latest Time</label>
                  <input
                    type="time"
                    value={local.timeWindowEnd}
                    onChange={(e) => update({ timeWindowEnd: e.target.value })}
                    className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm"
                  />
                </div>
              </div>
            </div>
          </section>

          {/* Auto-Book */}
          <section className="mb-8">
            <h3 className="text-sm font-semibold text-charcoal uppercase tracking-wider mb-3">
              Auto-Book
            </h3>
            <label className="flex items-center justify-between p-4 bg-stone-50 rounded-xl cursor-pointer">
              <div>
                <p className="text-sm font-medium text-charcoal">
                  Automatically book when slots appear
                </p>
                <p className="text-xs text-stone-400 mt-0.5">
                  Books the first matching slot at each restaurant
                </p>
              </div>
              <div
                className={`w-11 h-6 rounded-full transition-colors relative ${
                  local.autoBookEnabled ? "bg-emerald-500" : "bg-stone-300"
                }`}
                onClick={() => update({ autoBookEnabled: !local.autoBookEnabled })}
              >
                <div
                  className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                    local.autoBookEnabled ? "translate-x-[22px]" : "translate-x-0.5"
                  }`}
                />
              </div>
            </label>
            {local.autoBookEnabled && !resyAuth?.authenticated && (
              <p className="text-xs text-amber-600 mt-2">
                Connect your Resy account above to enable auto-booking.
              </p>
            )}
          </section>

          {/* Notifications */}
          <section className="mb-8">
            <h3 className="text-sm font-semibold text-charcoal uppercase tracking-wider mb-3">
              Email Notifications
            </h3>
            <div className="space-y-3">
              <input
                type="email"
                placeholder="Notification email"
                value={local.notifyEmail}
                onChange={(e) => update({ notifyEmail: e.target.value })}
                className="w-full px-4 py-2.5 border border-stone-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-gold/50"
              />
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="email"
                  placeholder="Gmail (sender)"
                  value={local.gmailUser}
                  onChange={(e) => update({ gmailUser: e.target.value })}
                  className="w-full px-3 py-2.5 border border-stone-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-gold/50"
                />
                <input
                  type="password"
                  placeholder="App password"
                  value={local.gmailAppPassword}
                  onChange={(e) => update({ gmailAppPassword: e.target.value })}
                  className="w-full px-3 py-2.5 border border-stone-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-gold/50"
                />
              </div>

              <div>
                <label className="text-xs text-stone-500 mb-1.5 block">SMS (optional — via carrier gateway)</label>
                <div className="flex gap-2">
                  <input
                    type="tel"
                    placeholder="Phone number"
                    value={local.smsPhone}
                    onChange={(e) => update({ smsPhone: e.target.value })}
                    className="flex-1 px-3 py-2.5 border border-stone-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-gold/50"
                  />
                  <select
                    value={local.smsCarrier}
                    onChange={(e) => update({ smsCarrier: e.target.value })}
                    className="px-3 py-2.5 border border-stone-200 rounded-xl text-sm bg-white"
                  >
                    {Object.keys(SMS_GATEWAYS).map((c) => (
                      <option key={c} value={c}>
                        {c.charAt(0).toUpperCase() + c.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
