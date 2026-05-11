"use client";

import { useState, useEffect } from "react";
import { SMS_GATEWAYS } from "@/lib/notifications";

export interface DayTimeWindow {
  start: string; // "18:30"
  end: string;   // "21:30"
}

export interface BlackoutDate {
  date: string; // YYYY-MM-DD
  note: string;
}

export interface AppSettings {
  // Resy credentials
  resyEmail: string;
  resyPassword: string;
  resyAuthToken: string;
  // Dining preferences
  partySize: number;
  preferredDays: string[];
  dayTimeWindows: Record<string, DayTimeWindow>;
  blackoutDates: BlackoutDate[];
  // Per-user persistent state
  autoBookIds: string[];
  monitoredIds: string[];
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

export const DEFAULT_BRUNCH_TIME_WINDOWS: Record<string, DayTimeWindow> = {
  saturday: { start: "12:00", end: "15:30" },
  sunday: { start: "12:00", end: "15:30" },
};

const DEFAULT_SETTINGS: AppSettings = {
  resyEmail: "",
  resyPassword: "",
  resyAuthToken: "",
  partySize: 4,
  preferredDays: ["thursday", "friday", "saturday"],
  dayTimeWindows: DEFAULT_DAY_TIME_WINDOWS,
  blackoutDates: [],
  autoBookIds: [],
  monitoredIds: [],
  notifyEmail: "",
  gmailUser: "",
  gmailAppPassword: "",
  smsPhone: "",
  smsCarrier: "verizon",
};

const DAYS = [
  { key: "monday", label: "Mon" },
  { key: "tuesday", label: "Tue" },
  { key: "wednesday", label: "Wed" },
  { key: "thursday", label: "Thu" },
  { key: "friday", label: "Fri" },
  { key: "saturday", label: "Sat" },
  { key: "sunday", label: "Sun" },
];

// --- Multi-user profile storage ---

const PROFILES_KEY = "wolfepack_profiles"; // string[] of profile names
const ACTIVE_PROFILE_KEY = "wolfepack_active_profile"; // current profile name

function profileStorageKey(name: string): string {
  return `wolfepack_profile_${name.toLowerCase().replace(/\s+/g, "_")}`;
}

export function getProfiles(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function getActiveProfile(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ACTIVE_PROFILE_KEY);
}

export function setActiveProfile(name: string): void {
  localStorage.setItem(ACTIVE_PROFILE_KEY, name);
}

export function addProfile(name: string): void {
  const profiles = getProfiles();
  if (!profiles.includes(name)) {
    profiles.push(name);
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
  }
}

export function deleteProfile(name: string): void {
  const profiles = getProfiles().filter((p) => p !== name);
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
  localStorage.removeItem(profileStorageKey(name));
  if (getActiveProfile() === name) {
    localStorage.removeItem(ACTIVE_PROFILE_KEY);
  }
}

export function loadSettings(profileName?: string): AppSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  const name = profileName ?? getActiveProfile();
  if (!name) return DEFAULT_SETTINGS;

  const stored = localStorage.getItem(profileStorageKey(name));
  if (stored) {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
    } catch {
      return DEFAULT_SETTINGS;
    }
  }
  return DEFAULT_SETTINGS;
}

export function saveSettings(s: AppSettings, profileName?: string): void {
  const name = profileName ?? getActiveProfile();
  if (!name) return;
  localStorage.setItem(profileStorageKey(name), JSON.stringify(s));
}

// --- Bookmarklet ---

const BOOKMARKLET_CODE = `javascript:void((function(){` +
  /* Step 1: Check cookies with broad patterns */
  `var t='';try{var cookies=document.cookie.split(';');` +
  `var patterns=['authtoken','resytoken','_resy_auth','resy_auth','x-resy-auth','auth_token','token'];` +
  `for(var i=0;i<cookies.length;i++){var c=cookies[i].trim();var cl=c.toLowerCase();` +
  `for(var j=0;j<patterns.length;j++){if(cl.startsWith(patterns[j]+'=')){` +
  `t=decodeURIComponent(c.split('=').slice(1).join('='));break}}if(t)break}}catch(e){}` +
  /* Step 2: Search all localStorage and sessionStorage keys */
  `if(!t){try{var stores=[localStorage,sessionStorage];` +
  `for(var s=0;s<stores.length;s++){if(t)break;var store=stores[s];` +
  `for(var k=0;k<store.length;k++){var key=store.key(k);var kl=key.toLowerCase();` +
  `if(kl.indexOf('auth')!==-1||kl.indexOf('token')!==-1||kl.indexOf('resy')!==-1){` +
  `var val=store.getItem(key);if(val){` +
  /* Try to parse JSON values that might contain a token */
  `try{var parsed=JSON.parse(val);` +
  `if(typeof parsed==='string'){t=parsed}` +
  `else if(parsed.token){t=parsed.token}` +
  `else if(parsed.authToken){t=parsed.authToken}` +
  `else if(parsed.auth_token){t=parsed.auth_token}` +
  `}catch(e){if(val.length>20&&val.length<500&&!/\\s/.test(val)){t=val}}` +
  `if(t)break}}}}}catch(e){}}` +
  /* Step 3: Try __NEXT_DATA__ and other global JS objects */
  `if(!t){try{` +
  `if(window.__NEXT_DATA__){var nd=JSON.stringify(window.__NEXT_DATA__);` +
  `var m=nd.match(/"(?:auth_?token|token|x-resy-auth-token)":"([^"]+)"/i);if(m)t=m[1]}` +
  `}catch(e){}}` +
  `if(!t){try{` +
  `var state=null;` +
  `if(window.__REDUX_STORE__){state=window.__REDUX_STORE__.getState()}` +
  `else if(window.__store__){state=window.__store__.getState()}` +
  `else if(window.__NEXT_REDUX_STORE__){state=window.__NEXT_REDUX_STORE__.getState()}` +
  `if(state){var ss=JSON.stringify(state);` +
  `var rm=ss.match(/"(?:auth_?token|token)":"([^"]{20,})"/i);if(rm)t=rm[1]}` +
  `}catch(e){}}` +
  /* Step 4: Fetch api.resy.com/2/user with credentials */
  `if(!t){` +
  `try{fetch('https://api.resy.com/2/user',{method:'GET',credentials:'include',` +
  `headers:{'Authorization':'ResyAPI api_key="VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5"'}` +
  `}).then(function(r){if(r.ok)return r.json();throw new Error('not ok')` +
  `}).then(function(d){` +
  `var found=d.token||d.auth_token||d.authToken||'';` +
  `if(found){window.prompt('Resy auth token (Cmd+C / Ctrl+C to copy):',found)}` +
  `else{showManualPrompt()}` +
  `}).catch(function(){showManualPrompt()})}catch(e){showManualPrompt()}}` +
  /* If we already found a token synchronously, show it */
  `if(t){window.prompt('Resy auth token (Cmd+C / Ctrl+C to copy):',t)}` +
  /* Step 5: Manual prompt fallback */
  `function showManualPrompt(){` +
  `var manual=window.prompt(` +
  `'Could not find token automatically.\\n\\n'+` +
  `'To find it manually:\\n'+` +
  `'1. Open DevTools (F12 or Cmd+Opt+I)\\n'+` +
  `'2. Go to the Network tab\\n'+` +
  `'3. Click any link on resy.com\\n'+` +
  `'4. Find a request to api.resy.com\\n'+` +
  `'5. Look for the x-resy-auth-token header\\n'+` +
  `'6. Paste it below:','');` +
  `if(manual&&manual.trim()){window.prompt('Your token (Cmd+C / Ctrl+C to copy):',manual.trim())}}` +
  `})())`;

// --- Component ---

interface Props {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSettingsChange: (s: AppSettings) => void;
  resyAuth: { authenticated: boolean; firstName?: string; lastName?: string; authToken?: string } | null;
  onResyLogin: (email: string, password: string) => Promise<true | string>;
  onResyTokenAuth: (token: string) => Promise<true | string>;
  onResyLogout: () => void;
  activeProfile: string | null;
  profiles: string[];
  onSwitchProfile: (name: string) => void;
  onCreateProfile: (name: string) => void;
  onDeleteProfile: (name: string) => void;
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
  activeProfile,
  profiles,
  onSwitchProfile,
  onCreateProfile,
  onDeleteProfile,
}: Props) {
  const [local, setLocal] = useState<AppSettings>(settings);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [authMode, setAuthMode] = useState<"token" | "password">("token");
  const [tokenInput, setTokenInput] = useState(settings.resyAuthToken || "");
  const [newProfileName, setNewProfileName] = useState("");
  const [showNewProfile, setShowNewProfile] = useState(false);
  const [bookmarkletCopied, setBookmarkletCopied] = useState(false);
  const [newBlackoutDate, setNewBlackoutDate] = useState("");
  const [newBlackoutNote, setNewBlackoutNote] = useState("");

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
    if (typeof result === "string") setLoginError(result);
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
      update({ resyAuthToken: token });
    }
    setLoginLoading(false);
  };

  const handleCreateProfile = () => {
    const name = newProfileName.trim();
    if (!name) return;
    onCreateProfile(name);
    setNewProfileName("");
    setShowNewProfile(false);
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40 backdrop-blur-sm" onClick={onClose} />

      <div className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-white z-50 shadow-2xl overflow-y-auto">
        <div className="p-4 sm:p-6">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-semibold text-charcoal">Settings</h2>
            <button onClick={onClose} className="p-2 hover:bg-stone-100 rounded-lg transition-colors">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* User Profile Switcher */}
          <section className="mb-6">
            <h3 className="text-sm font-semibold text-charcoal uppercase tracking-wider mb-2">Profile</h3>
            <div className="flex flex-wrap gap-2 mb-2">
              {profiles.map((p) => (
                <div key={p} className="flex items-center gap-1">
                  <button
                    onClick={() => onSwitchProfile(p)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      activeProfile === p
                        ? "bg-charcoal text-white"
                        : "bg-stone-100 text-stone-500 hover:bg-stone-200"
                    }`}
                  >
                    {p}
                  </button>
                  {activeProfile === p && profiles.length > 1 && (
                    <button
                      onClick={() => onDeleteProfile(p)}
                      className="text-stone-300 hover:text-red-400 text-xs"
                      title="Delete profile"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
              {showNewProfile ? (
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={newProfileName}
                    onChange={(e) => setNewProfileName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleCreateProfile()}
                    placeholder="Name"
                    autoFocus
                    className="w-24 px-2 py-1.5 border border-stone-200 rounded-lg text-xs focus:outline-none focus:ring-1 focus:ring-gold/50"
                  />
                  <button onClick={handleCreateProfile} className="text-emerald-500 text-xs font-medium">Add</button>
                  <button onClick={() => setShowNewProfile(false)} className="text-stone-400 text-xs">Cancel</button>
                </div>
              ) : (
                <button
                  onClick={() => setShowNewProfile(true)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-dashed border-stone-300 text-stone-400 hover:bg-stone-50"
                >
                  + New
                </button>
              )}
            </div>
          </section>

          {/* Resy Account */}
          <section className="mb-6">
            <h3 className="text-sm font-semibold text-charcoal uppercase tracking-wider mb-2">Resy Account</h3>
            {resyAuth?.authenticated ? (
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-emerald-800">
                      {resyAuth.firstName} {resyAuth.lastName}
                    </p>
                    <p className="text-xs text-emerald-600 mt-0.5">Auto-booking enabled</p>
                  </div>
                  <button
                    onClick={() => { update({ resyAuthToken: "" }); onResyLogout(); }}
                    className="text-xs text-stone-400 hover:text-red-500 underline"
                  >
                    Logout
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
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
                      rows={2}
                      className="w-full px-3 py-2 border border-stone-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-gold/50 font-mono text-[11px] resize-none"
                    />
                    <button
                      onClick={handleTokenAuth}
                      disabled={loginLoading || !tokenInput.trim()}
                      className="w-full py-2.5 bg-charcoal text-white rounded-xl text-sm font-medium hover:bg-charcoal/90 transition-colors disabled:opacity-40"
                    >
                      {loginLoading ? "Validating..." : "Connect with Token"}
                    </button>
                    <div className="bg-stone-50 rounded-xl p-3 space-y-2">
                      <p className="text-[11px] font-medium text-charcoal">Get your token:</p>
                      <div className="space-y-2">
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(BOOKMARKLET_CODE).then(() => {
                              setBookmarkletCopied(true);
                              setTimeout(() => setBookmarkletCopied(false), 3000);
                            });
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-charcoal text-white rounded-lg text-xs font-medium hover:bg-charcoal/80 transition-colors"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                          {bookmarkletCopied ? "Copied!" : "Copy Bookmarklet Code"}
                        </button>
                        <p className="text-[10px] text-stone-500">
                          {bookmarkletCopied
                            ? "Now create a new bookmark, paste this as the URL, then click it on resy.com"
                            : "Copy, then create a new bookmark and paste as the URL. Click it on resy.com while logged in."}
                        </p>
                      </div>
                      <div className="border-t border-stone-200 pt-2 mt-2">
                        <p className="text-[11px] font-medium text-charcoal mb-1">Or manually:</p>
                        <ol className="text-[10px] text-stone-500 space-y-0.5 list-decimal pl-3.5">
                          <li>Go to <a href="https://resy.com" target="_blank" rel="noopener noreferrer" className="underline text-stone-600">resy.com</a> and log in</li>
                          <li>Open DevTools (F12) &rarr; <strong>Network</strong> tab</li>
                          <li>Click around, find a request to api.resy.com</li>
                          <li>Copy the <strong>x-resy-auth-token</strong> header value</li>
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
                      className="w-full px-3 py-2.5 border border-stone-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-gold/50"
                    />
                    <div className="relative">
                      <input
                        type={showPassword ? "text" : "password"}
                        placeholder="Resy password"
                        value={local.resyPassword}
                        onChange={(e) => update({ resyPassword: e.target.value })}
                        className="w-full px-3 py-2.5 border border-stone-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-gold/50 pr-16"
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
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] text-amber-500">Resy may block automated login. Use Auth Token if this fails.</p>
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
                {loginError && <p className="text-xs text-red-500">{loginError}</p>}
              </div>
            )}
          </section>

          {/* Dining Preferences */}
          <section className="mb-6">
            <h3 className="text-sm font-semibold text-charcoal uppercase tracking-wider mb-2">Dining Preferences</h3>
            <div className="space-y-4">
              <div>
                <label className="text-xs text-stone-500 mb-1.5 block">Party Size</label>
                <div className="flex gap-1.5">
                  {[1, 2, 3, 4, 5, 6].map((n) => (
                    <button
                      key={n}
                      onClick={() => update({ partySize: n })}
                      className={`w-9 h-9 rounded-lg text-sm font-medium transition-colors ${
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
                <div className="flex gap-1">
                  {DAYS.map((d) => (
                    <button
                      key={d.key}
                      onClick={() => toggleDay(d.key)}
                      className={`flex-1 py-1.5 rounded-lg text-[11px] font-medium transition-colors ${
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
                <label className="text-xs text-stone-500 mb-2 block">Time Windows</label>
                <div className="space-y-1.5">
                  {DAYS.filter((d) => local.preferredDays.includes(d.key)).map((d) => {
                    const tw = local.dayTimeWindows?.[d.key] || { start: "18:00", end: "21:30" };
                    return (
                      <div key={d.key} className="flex items-center gap-1.5">
                        <span className="text-[11px] font-medium text-charcoal w-8">{d.label}</span>
                        <input
                          type="time"
                          value={tw.start}
                          onChange={(e) => {
                            const windows = { ...local.dayTimeWindows, [d.key]: { ...tw, start: e.target.value } };
                            update({ dayTimeWindows: windows });
                          }}
                          className="flex-1 px-1.5 py-1 border border-stone-200 rounded text-[11px]"
                        />
                        <span className="text-[10px] text-stone-400">-</span>
                        <input
                          type="time"
                          value={tw.end}
                          onChange={(e) => {
                            const windows = { ...local.dayTimeWindows, [d.key]: { ...tw, end: e.target.value } };
                            update({ dayTimeWindows: windows });
                          }}
                          className="flex-1 px-1.5 py-1 border border-stone-200 rounded text-[11px]"
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>

          {/* Blackout Dates */}
          <section className="mb-6">
            <h3 className="text-sm font-semibold text-charcoal uppercase tracking-wider mb-2">Blackout Dates</h3>
            <p className="text-[10px] text-stone-400 mb-2">Dates to skip for auto-book and notifications</p>
            <div className="space-y-2">
              {(local.blackoutDates ?? []).map((bd, i) => (
                <div key={i} className="flex items-center gap-2 bg-stone-50 rounded-lg px-2.5 py-1.5">
                  <span className="text-xs font-medium text-charcoal">{bd.date}</span>
                  {bd.note && <span className="text-[10px] text-stone-400 truncate flex-1">{bd.note}</span>}
                  <button
                    onClick={() => {
                      const dates = (local.blackoutDates ?? []).filter((_, j) => j !== i);
                      update({ blackoutDates: dates });
                    }}
                    className="text-stone-300 hover:text-red-400 shrink-0"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
              <div className="flex gap-1.5">
                <input
                  type="date"
                  value={newBlackoutDate}
                  onChange={(e) => setNewBlackoutDate(e.target.value)}
                  className="flex-1 px-2 py-1.5 border border-stone-200 rounded-lg text-xs"
                />
                <input
                  type="text"
                  placeholder="Note (optional)"
                  value={newBlackoutNote}
                  onChange={(e) => setNewBlackoutNote(e.target.value)}
                  className="flex-1 px-2 py-1.5 border border-stone-200 rounded-lg text-xs"
                />
                <button
                  onClick={() => {
                    if (!newBlackoutDate) return;
                    const dates = [...(local.blackoutDates ?? []), { date: newBlackoutDate, note: newBlackoutNote }];
                    update({ blackoutDates: dates });
                    setNewBlackoutDate("");
                    setNewBlackoutNote("");
                  }}
                  className="px-2.5 py-1.5 bg-charcoal text-white rounded-lg text-xs font-medium hover:bg-charcoal/80"
                >
                  Add
                </button>
              </div>
            </div>
          </section>

          {/* Auto-Book */}
          <section className="mb-6">
            <h3 className="text-sm font-semibold text-charcoal uppercase tracking-wider mb-2">Auto-Book</h3>
            <div className="p-3 bg-stone-50 rounded-xl">
              <p className="text-xs text-stone-600">
                Click the lightning bolt on any restaurant card to enable auto-book for that restaurant.
              </p>
              {!resyAuth?.authenticated && (
                <p className="text-xs text-amber-600 mt-1.5">Connect Resy account above to enable.</p>
              )}
            </div>
          </section>

          {/* Notifications */}
          <section className="mb-6">
            <h3 className="text-sm font-semibold text-charcoal uppercase tracking-wider mb-2">Notifications</h3>
            <div className="space-y-2">
              <input
                type="email"
                placeholder="Notification email"
                value={local.notifyEmail}
                onChange={(e) => update({ notifyEmail: e.target.value })}
                className="w-full px-3 py-2 border border-stone-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-gold/50"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="email"
                  placeholder="Gmail (sender)"
                  value={local.gmailUser}
                  onChange={(e) => update({ gmailUser: e.target.value })}
                  className="w-full px-2.5 py-2 border border-stone-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-gold/50"
                />
                <input
                  type="password"
                  placeholder="App password"
                  value={local.gmailAppPassword}
                  onChange={(e) => update({ gmailAppPassword: e.target.value })}
                  className="w-full px-2.5 py-2 border border-stone-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-gold/50"
                />
              </div>
              <div>
                <label className="text-[10px] text-stone-500 mb-1 block">SMS (optional)</label>
                <div className="flex gap-2">
                  <input
                    type="tel"
                    placeholder="Phone"
                    value={local.smsPhone}
                    onChange={(e) => update({ smsPhone: e.target.value })}
                    className="flex-1 px-2.5 py-2 border border-stone-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-gold/50"
                  />
                  <select
                    value={local.smsCarrier}
                    onChange={(e) => update({ smsCarrier: e.target.value })}
                    className="px-2 py-2 border border-stone-200 rounded-xl text-sm bg-white"
                  >
                    {Object.keys(SMS_GATEWAYS).map((c) => (
                      <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
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
