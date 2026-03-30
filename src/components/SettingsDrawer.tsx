"use client";

import { useState, useEffect } from "react";
import { SMS_GATEWAYS } from "@/lib/notifications";

export interface DayTimeWindow {
  start: string; // "18:30"
  end: string;   // "21:30"
}

export interface AppSettings {
  // Resy credentials
  resyEmail: string;
  resyPassword: string;
  // Persisted auth token (survives page reload)
  resyAuthToken: string;
  // Dining preferences
  partySize: number;
  preferredDays: string[];
  // Per-day time windows (key = day name like "wednesday")
  dayTimeWindows: Record<string, DayTimeWindow>;
  // Legacy single window (kept for migration, unused if dayTimeWindows set)
  timeWindowStart: string;
  timeWindowEnd: string;
  // Notification
  notifyEmail: string;
  gmailUser: string;
  gmailAppPassword: string;
  smsPhone: string;
  smsCarrier: string;
}

export const DEFAULT_DAY_TIME_WINDOWS: Record<string, DayTimeWindow> = {
  wednesday: { start: "18:30", end: "20:30" },
  thursday: { start: "18:30", end: "21:30" },
  friday: { start: "19:30", end: "21:30" },
  saturday: { start: "19:30", end: "21:30" },
};

const DEFAULT_SETTINGS: AppSettings = {
  resyEmail: "",
  resyPassword: "",
  resyAuthToken: "",
  partySize: 2,
  preferredDays: ["wednesday", "thursday", "friday", "saturday"],
  dayTimeWindows: DEFAULT_DAY_TIME_WINDOWS,
  timeWindowStart: "",
  timeWindowEnd: "",
  notifyEmail: "",
  gmailUser: "",
  gmailAppPassword: "",
  smsPhone: "",
  smsCarrier: "verizon",
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

// Bookmarklet: tries multiple methods to find the Resy auth token
// 1. document.cookie (if not httpOnly)
// 2. Resy's own localStorage/sessionStorage keys
// 3. Makes an API call with credentials to extract from response
const BOOKMARKLET_CODE = `javascript:void((function(){try{var t='';var c=document.cookie.split(';').map(function(x){return x.trim()}).find(function(x){return x.startsWith('authToken=')});if(c){t=decodeURIComponent(c.split('=').slice(1).join('='))}if(!t){try{var keys=['authToken','auth_token','resy_auth_token'];for(var i=0;i<keys.length;i++){var v=localStorage.getItem(keys[i])||sessionStorage.getItem(keys[i]);if(v){t=v;break}}}catch(e){}}if(!t){try{var x=new XMLHttpRequest();x.open('GET','https://api.resy.com/2/user',false);x.setRequestHeader('Authorization','ResyAPI api_key="VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5"');x.withCredentials=true;x.send();if(x.status===200){var d=JSON.parse(x.responseText);t=d.token||''}}catch(e){}}if(t){window.prompt('Resy auth token (Cmd+C to copy):',t)}else{alert('Could not find token automatically.\\n\\nManual method:\\n1. Open DevTools (F12)\\n2. Go to Network tab\\n3. Click any page on resy.com\\n4. Find a request to api.resy.com\\n5. Copy the x-resy-auth-token header value')}}catch(e){alert('Error: '+e.message)}})())`;

interface Props {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSettingsChange: (s: AppSettings) => void;
  resyAuth: { authenticated: boolean; firstName?: string; lastName?: string; authToken?: string } | null;
  onResyLogin: (email: string, password: string) => Promise<true | string>;
  onResyTokenAuth: (token: string) => Promise<true | string>;
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
  onResyTokenAuth,
  onResyLogout,
}: Props) {
  const [local, setLocal] = useState<AppSettings>(settings);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [authMode, setAuthMode] = useState<"token" | "password">("token");
  const [tokenInput, setTokenInput] = useState(settings.resyAuthToken || "");
  const [bookmarkletCopied, setBookmarkletCopied] = useState(false);

  useEffect(() => {
    setLocal(settings);
    if (settings.resyAuthToken) setTokenInput(settings.resyAuthToken);
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
    const result = await onResyLogin(local.resyEmail, local.resyPassword);
    if (typeof result === "string") {
      setLoginError(result);
    } else if (!result) {
      setLoginError("Login failed — check your credentials");
    }
    setLoginLoading(false);
  };

  const handleTokenAuth = async () => {
    const token = tokenInput.trim();
    if (!token) return;
    setLoginLoading(true);
    setLoginError(null);
    const result = await onResyTokenAuth(token);
    if (typeof result === "string") {
      setLoginError(result);
    } else {
      // Persist the token in settings so it survives page reload
      update({ resyAuthToken: token });
    }
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
                    onClick={() => {
                      update({ resyAuthToken: "" });
                      onResyLogout();
                    }}
                    className="text-xs text-stone-400 hover:text-red-500 underline"
                  >
                    Logout
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Auth mode toggle */}
                <div className="flex gap-1 bg-stone-100 p-0.5 rounded-lg">
                  <button
                    onClick={() => setAuthMode("token")}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      authMode === "token" ? "bg-white text-charcoal shadow-sm" : "text-stone-400"
                    }`}
                  >
                    Auth Token
                  </button>
                  <button
                    onClick={() => setAuthMode("password")}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      authMode === "password" ? "bg-white text-charcoal shadow-sm" : "text-stone-400"
                    }`}
                  >
                    Email / Password
                  </button>
                </div>

                {authMode === "token" ? (
                  <>
                    <textarea
                      placeholder="Paste your Resy auth token here..."
                      value={tokenInput}
                      onChange={(e) => setTokenInput(e.target.value)}
                      rows={3}
                      className="w-full px-4 py-2.5 border border-stone-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-gold/50 font-mono text-xs resize-none"
                    />
                    <button
                      onClick={handleTokenAuth}
                      disabled={loginLoading || !tokenInput.trim()}
                      className="w-full py-2.5 bg-charcoal text-white rounded-xl text-sm font-medium hover:bg-charcoal/90 transition-colors disabled:opacity-40"
                    >
                      {loginLoading ? "Validating..." : "Connect with Token"}
                    </button>

                    {/* Bookmarklet + instructions */}
                    <div className="bg-stone-50 rounded-xl p-3 space-y-2">
                      <p className="text-[11px] font-medium text-charcoal">Easiest way — use this bookmarklet:</p>
                      <div className="flex items-center gap-2">
                        <a
                          href={BOOKMARKLET_CODE}
                          onClick={(e) => e.preventDefault()}
                          onDragStart={() => {}}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-charcoal text-white rounded-lg text-xs font-medium cursor-grab active:cursor-grabbing"
                          title="Drag this to your bookmarks bar"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                          </svg>
                          Get Resy Token
                        </a>
                        <span className="text-[10px] text-stone-400">
                          Drag to bookmarks bar
                        </span>
                      </div>
                      <p className="text-[10px] text-stone-500">
                        Then visit <a href="https://resy.com" target="_blank" rel="noopener noreferrer" className="underline">resy.com</a>, log in, and click the bookmarklet to copy your token.
                      </p>

                      <div className="border-t border-stone-200 pt-2 mt-2">
                        <p className="text-[11px] font-medium text-charcoal mb-1">Or manually:</p>
                        <ol className="text-[10px] text-stone-500 space-y-0.5 list-decimal pl-3.5">
                          <li>Go to <a href="https://resy.com" target="_blank" rel="noopener noreferrer" className="underline text-stone-600">resy.com</a> and log in</li>
                          <li>Open DevTools (F12 or Cmd+Opt+I) → <strong>Application</strong> tab</li>
                          <li>Under <strong>Cookies</strong> → resy.com, find <strong>authToken</strong></li>
                          <li>Copy the value and paste above</li>
                        </ol>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
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
                    <div className="flex gap-2">
                      <button
                        onClick={handleLogin}
                        disabled={loginLoading || !local.resyEmail || !local.resyPassword}
                        className="flex-1 py-2.5 bg-charcoal text-white rounded-xl text-sm font-medium hover:bg-charcoal/90 transition-colors disabled:opacity-40"
                      >
                        {loginLoading ? "Logging in..." : "Connect Resy Account"}
                      </button>
                    </div>
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] text-amber-500">
                        Resy may block automated login. Use Auth Token if this fails.
                      </p>
                      <a
                        href="https://resy.com/password-reset"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] text-stone-400 hover:text-stone-600 underline shrink-0 ml-2"
                      >
                        Forgot password?
                      </a>
                    </div>
                  </>
                )}

                {loginError && (
                  <p className="text-xs text-red-500">{loginError}</p>
                )}
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

              <div>
                <label className="text-xs text-stone-500 mb-2 block">Time Windows per Day</label>
                <div className="space-y-2">
                  {DAYS.filter((d) => local.preferredDays.includes(d.key)).map((d) => {
                    const window = local.dayTimeWindows?.[d.key] || { start: "18:00", end: "21:30" };
                    return (
                      <div key={d.key} className="flex items-center gap-2">
                        <span className="text-xs font-medium text-charcoal w-10">{d.label}</span>
                        <input
                          type="time"
                          value={window.start}
                          onChange={(e) => {
                            const windows = { ...local.dayTimeWindows, [d.key]: { ...window, start: e.target.value } };
                            update({ dayTimeWindows: windows });
                          }}
                          className="flex-1 px-2 py-1.5 border border-stone-200 rounded-lg text-xs"
                        />
                        <span className="text-xs text-stone-400">to</span>
                        <input
                          type="time"
                          value={window.end}
                          onChange={(e) => {
                            const windows = { ...local.dayTimeWindows, [d.key]: { ...window, end: e.target.value } };
                            update({ dayTimeWindows: windows });
                          }}
                          className="flex-1 px-2 py-1.5 border border-stone-200 rounded-lg text-xs"
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>

          {/* Auto-Book Info */}
          <section className="mb-8">
            <h3 className="text-sm font-semibold text-charcoal uppercase tracking-wider mb-3">
              Auto-Book
            </h3>
            <div className="p-4 bg-stone-50 rounded-xl">
              <p className="text-sm text-stone-600">
                Auto-book is configured <strong>per restaurant</strong>. Click the lightning bolt icon on any restaurant card to enable it.
              </p>
              <p className="text-xs text-stone-400 mt-2">
                When enabled, the bot will automatically book the first available slot at that restaurant. It checks your existing Resy reservations to avoid conflicts (no double-booking within 2 hours).
              </p>
              {!resyAuth?.authenticated && (
                <p className="text-xs text-amber-600 mt-2">
                  Connect your Resy account above to enable auto-booking.
                </p>
              )}
            </div>
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
