"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { restaurants } from "@/data/restaurants";
import SnipePanel from "@/components/SnipePanel";
import AppNav from "@/components/AppNav";
import { loadSettings, getActiveProfile } from "@/components/SettingsDrawer";
import type { AppSettings } from "@/components/SettingsDrawer";

const resyRestaurants = restaurants.filter(
  (r) => r.resyVenueId && (r.reservationMethod === "resy" || r.reservationMethod === "both"),
);

export default function SnipePage() {
  const router = useRouter();
  const [loggedInUser, setLoggedInUser] = useState<string | null>(null);
  const [resyAuth, setResyAuth] = useState<{ authenticated: boolean; authToken?: string; firstName?: string } | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Restore session
    const user = sessionStorage.getItem("wolfepack:user");
    if (!user) {
      router.replace("/");
      return;
    }
    setLoggedInUser(user);

    // Load settings from active profile (auth token lives in settings.resyAuthToken)
    const activeProfile = getActiveProfile() ?? undefined;
    const s = loadSettings(activeProfile);
    setSettings(s);

    // Derive auth state from saved token
    if (s.resyAuthToken) {
      setResyAuth({ authenticated: true, authToken: s.resyAuthToken });
    } else {
      setResyAuth({ authenticated: false });
    }

    setReady(true);
  }, [router]);

  if (!ready || !loggedInUser) return null;

  const isAuthenticated = resyAuth?.authenticated ?? false;
  const authToken = resyAuth?.authToken;

  return (
    <div className="min-h-screen bg-cream">
      <header className="sticky top-0 z-30 bg-charcoal text-white">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-3 sm:py-4 flex items-center justify-between">
          <div className="min-w-0">
            <h1 className="font-serif text-xl sm:text-2xl tracking-tight">WolfePack Eats</h1>
            <p className="text-stone-400 text-[10px] sm:text-xs mt-0.5">
              {loggedInUser} · Snipe Mode
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isAuthenticated && (
              <span className="hidden sm:inline text-xs text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded-full">
                {resyAuth?.firstName}
              </span>
            )}
            <button
              onClick={() => { sessionStorage.removeItem("wolfepack:user"); router.push("/"); }}
              className="text-xs text-stone-500 hover:text-stone-300 transition-colors"
              title="Logout"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </div>
        </div>
        <AppNav />
      </header>

      <main className="max-w-3xl mx-auto px-3 sm:px-6 py-4 sm:py-6">
        {!isAuthenticated && (
          <div className="mb-4 p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
            Connect your Resy account in Settings on the Live screen to enable snipe scheduling.
          </div>
        )}
        <SnipePanel
          restaurants={resyRestaurants}
          isAuthenticated={isAuthenticated}
          authToken={authToken}
          partySize={settings?.partySize ?? 2}
          dayTimeWindows={settings?.dayTimeWindows}
          preferredDays={settings?.preferredDays ?? []}
          onLog={() => {}}
        />
      </main>
    </div>
  );
}
