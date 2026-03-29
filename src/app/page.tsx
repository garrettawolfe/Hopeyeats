"use client";

import { useState, useEffect, useCallback } from "react";
import { restaurants } from "@/data/restaurants";
import type { UserSettings } from "@/lib/emailTemplates";
import { getBookingContext } from "@/lib/emailTemplates";
import Header from "@/components/Header";
import RestaurantCard from "@/components/RestaurantCard";
import SettingsPanel from "@/components/SettingsPanel";
import ReservationMonitor from "@/components/ReservationMonitor";

const SENT_KEY = "hopeyeats_sent";

const DEFAULT_SETTINGS: UserSettings = {
  name: "",
  email: "",
  gmailAppPassword: "",
  diningDateStart: "",
  diningDateEnd: "",
  partySize: 2,
  specialRequests: "",
  preferredDays: ["wednesday", "thursday", "friday", "saturday"],
  diningTimeStart: "18:30",
  diningTimeEnd: "21:30",
};

type SortKey = "bookSoonest" | "default" | "advanceDays" | "neighborhood";
type FilterKey = "upcoming" | "all" | "hasEmail" | "resyOnly" | "michelin" | "sent" | "unsent";

// Days until booking opens for a given restaurant + settings
function daysUntilBooking(r: { advanceDays: number }, diningDateStart: string): number {
  const ctx = getBookingContext(r.advanceDays, null, diningDateStart);
  return ctx.daysUntilBooking;
}

export default function Home() {
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [sentIds, setSentIds] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortKey>("bookSoonest");
  const [filter, setFilter] = useState<FilterKey>("upcoming");
  const [search, setSearch] = useState("");
  const [settingsReady, setSettingsReady] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(SENT_KEY);
    if (stored) setSentIds(new Set(JSON.parse(stored)));
    const storedSettings = localStorage.getItem("hopeyeats_settings");
    if (storedSettings) {
      setSettings(JSON.parse(storedSettings));
    }
    setSettingsReady(true);
  }, []);

  function markSent(id: string) {
    setSentIds((prev) => {
      const next = new Set(prev).add(id);
      localStorage.setItem(SENT_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  const handleSettingsChange = useCallback((s: UserSettings) => {
    setSettings(s);
  }, []);

  // Filter
  const filtered = restaurants.filter((r) => {
    const hasEmail = r.reservationEmail !== null || r.contactEmail !== null;

    if (filter === "upcoming") {
      // Only show restaurants where the booking window is today or in the future
      const days = daysUntilBooking(r, settings.diningDateStart);
      if (days < 0) return false;
      // Without a specific dining date, cap at 5-week dining window
      if (!settings.diningDateStart && r.advanceDays > 35) return false;
    }
    if (filter === "hasEmail" && !hasEmail) return false;
    if (filter === "resyOnly" && hasEmail) return false;
    if (filter === "michelin" && !r.michelinStar && !r.bibGourmand) return false;
    if (filter === "sent" && !sentIds.has(r.id)) return false;
    if (filter === "unsent" && sentIds.has(r.id)) return false;

    if (search) {
      const q = search.toLowerCase();
      return (
        r.name.toLowerCase().includes(q) ||
        r.neighborhood.toLowerCase().includes(q) ||
        r.cuisine.toLowerCase().includes(q) ||
        r.tags.some((t) => t.toLowerCase().includes(q))
      );
    }
    return true;
  });

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    if (sort === "bookSoonest") {
      // Sort by days until booking opens (most urgent first)
      // Without dining date, advanceDays IS the proxy (fewer = dine sooner)
      return daysUntilBooking(a, settings.diningDateStart) - daysUntilBooking(b, settings.diningDateStart);
    }
    if (sort === "advanceDays") return a.advanceDays - b.advanceDays;
    if (sort === "neighborhood") return a.neighborhood.localeCompare(b.neighborhood);
    return 0;
  });

  // Today context for the header bar
  const todayStr = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const settingsComplete = !!settings.email;

  return (
    <>
      <Header
        sentCount={sentIds.size}
        totalCount={restaurants.length}
        onSettingsOpen={() => setShowSettings(true)}
      />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Setup Banner */}
        {settingsReady && !settingsComplete && (
          <div className="mb-8 bg-[#C9A84C]/10 border border-[#C9A84C]/30 rounded-2xl px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <p className="font-medium text-[#1C1C1C]">
                Set up your profile to start sending
              </p>
              <p className="text-sm text-stone-500 mt-0.5">
                Add your Gmail credentials to enable one-click emails and
                reminders. Booking windows are already shown below.
              </p>
            </div>
            <button
              onClick={() => setShowSettings(true)}
              className="shrink-0 px-5 py-2.5 bg-[#1C1C1C] text-white rounded-xl text-sm font-medium hover:bg-[#333] transition-colors"
            >
              Open Settings
            </button>
          </div>
        )}

        {/* Today context bar */}
        <div className="mb-6 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2 text-sm text-stone-500">
            <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block animate-pulse" />
            <span>
              <strong className="text-stone-700">{todayStr}</strong>
              {settings.diningDateStart ? (
                <>
                  {" "}· Targeting{" "}
                  <strong className="text-stone-700">
                    {new Date(settings.diningDateStart + "T00:00:00").toLocaleDateString(
                      "en-US",
                      { month: "long", day: "numeric" }
                    )}
                    {settings.diningDateEnd &&
                      settings.diningDateEnd !== settings.diningDateStart &&
                      ` – ${new Date(settings.diningDateEnd + "T00:00:00").toLocaleDateString(
                        "en-US",
                        { month: "long", day: "numeric" }
                      )}`}
                  </strong>
                  {" "}· Party of {settings.partySize}
                </>
              ) : (
                <span className="text-stone-400">
                  {" "}· Showing next 5 weeks of booking windows
                </span>
              )}
            </span>
          </div>
          {settings.diningDateStart && (
            <button
              onClick={() => setShowSettings(true)}
              className="text-xs text-stone-400 underline hover:text-stone-600"
            >
              Change dates
            </button>
          )}
        </div>

        {/* Filters + Sort + Search */}
        <div className="flex flex-col sm:flex-row gap-3 mb-8">
          <input
            type="text"
            placeholder="Search restaurants, neighborhoods, cuisines…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 px-4 py-2.5 border border-stone-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#C9A84C]/50 bg-white"
          />
          <div className="flex gap-2 flex-wrap">
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as FilterKey)}
              className="px-3 py-2.5 border border-stone-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#C9A84C]/50 text-stone-600"
            >
              <option value="upcoming">Next 5 Weeks</option>
              <option value="all">All ({restaurants.length})</option>
              <option value="hasEmail">Email Available</option>
              <option value="resyOnly">Resy Only</option>
              <option value="michelin">Michelin Recognized</option>
              <option value="sent">Contacted</option>
              <option value="unsent">Not Yet Contacted</option>
            </select>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="px-3 py-2.5 border border-stone-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#C9A84C]/50 text-stone-600"
            >
              <option value="bookSoonest">Sort: Book Soonest</option>
              <option value="default">Sort: Default</option>
              <option value="advanceDays">Sort: Advance Days</option>
              <option value="neighborhood">Sort: Neighborhood</option>
            </select>
          </div>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 mb-6 flex-wrap text-xs text-stone-400">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            Book Today
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-400" />
            Book within 6 days
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-stone-300" />
            Upcoming window
          </span>
          <span className="flex items-center gap-1.5">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            Calendar = set booking alert (15 min heads-up)
          </span>
        </div>

        {/* Reservation Monitor */}
        <div className="mb-8">
          <ReservationMonitor partySize={settings.partySize} />
        </div>

        {/* Restaurant Grid */}
        {sorted.length === 0 ? (
          <div className="text-center py-20 text-stone-400">
            <p className="text-lg mb-2">No restaurants match your filters</p>
            <button
              onClick={() => {
                setFilter("upcoming");
                setSearch("");
              }}
              className="text-sm underline hover:text-stone-600"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {sorted.map((r) => (
              <RestaurantCard
                key={r.id}
                restaurant={r}
                settings={settings}
                isSent={sentIds.has(r.id)}
                onSent={markSent}
              />
            ))}
          </div>
        )}

        {/* Footer */}
        <footer className="mt-16 pt-8 border-t border-stone-200 text-center text-xs text-stone-400">
          <p>
            HopeYeats · NYC Dining Command Center · Reservation data sourced from
            The Infatuation, Resy, and restaurant websites.
          </p>
          <p className="mt-1">
            Your Gmail credentials are stored locally in your browser and
            transmitted only when you click Send.
          </p>
        </footer>
      </main>

      {showSettings && (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          onChange={handleSettingsChange}
        />
      )}
    </>
  );
}
