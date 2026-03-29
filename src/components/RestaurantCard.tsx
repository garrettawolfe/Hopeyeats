"use client";

import { useState } from "react";
import Image from "next/image";
import type { Restaurant } from "@/data/restaurants";
import type { UserSettings } from "@/lib/emailTemplates";
import { generateEmail, getBookingContext, buildResyUrl } from "@/lib/emailTemplates";
import EmailModal from "./EmailModal";

interface Props {
  restaurant: Restaurant;
  settings: UserSettings;
  isSent: boolean;
  onSent: (id: string) => void;
}

function formatTime(t: string): string {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

const urgencyStyles = {
  today: "bg-emerald-50 text-emerald-700 border border-emerald-200",
  soon: "bg-amber-50 text-amber-700 border border-amber-200",
  upcoming: "bg-stone-50 text-[#C9A84C] border border-stone-200",
  past: "bg-stone-50 text-stone-400 border border-stone-200 line-through",
};

export default function RestaurantCard({
  restaurant,
  settings,
  isSent,
  onSent,
}: Props) {
  const [showModal, setShowModal] = useState(false);
  const [calendarLoading, setCalendarLoading] = useState(false);

  const hasEmail =
    restaurant.reservationEmail !== null || restaurant.contactEmail !== null;
  const draft = settings.email ? generateEmail(restaurant, settings) : null;

  // Always compute from today — works with or without settings.diningDateStart
  const ctx = getBookingContext(
    restaurant.advanceDays,
    restaurant.bookingTime,
    settings.diningDateStart
  );

  async function downloadCalendarReminder() {
    if (!ctx.isActionable) {
      alert(
        "The booking window for this restaurant has already passed for your selected dates."
      );
      return;
    }

    setCalendarLoading(true);
    try {
      const bookingDateStr = ctx.bookingDate.toISOString().split("T")[0];
      const diningDateStr = ctx.targetDiningDate.toISOString().split("T")[0];

      const res = await fetch("/api/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          restaurantId: restaurant.id,
          restaurantName: restaurant.name,
          bookingDate: bookingDateStr,
          diningDate: diningDateStr,
          bookingTime: restaurant.bookingTime,
          resyUrl: restaurant.resyUrl,
          tip: restaurant.bookingTip,
        }),
      });

      if (!res.ok) throw new Error("Failed to generate calendar file");

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${restaurant.id}-booking-reminder.ics`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      alert("Failed to create calendar reminder. Please try again.");
    } finally {
      setCalendarLoading(false);
    }
  }

  return (
    <>
      <div
        className={`relative bg-white rounded-2xl overflow-hidden shadow-sm border transition-all duration-200 hover:shadow-md ${
          isSent ? "border-emerald-200" : "border-stone-100"
        } ${ctx.urgencyTier === "past" ? "opacity-60" : ""}`}
      >
        {/* Photo */}
        <div className="relative h-48 overflow-hidden">
          <Image
            src={restaurant.imageUrl}
            alt={restaurant.name}
            fill
            className="object-cover transition-transform duration-500 hover:scale-105"
            sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
          />
          {/* Overlay badges */}
          <div className="absolute top-3 left-3 flex gap-1.5 flex-wrap">
            {restaurant.michelinStar && (
              <span className="bg-[#C9A84C] text-white text-xs px-2 py-0.5 rounded-full font-medium shadow">
                ★ Michelin Star
              </span>
            )}
            {restaurant.bibGourmand && (
              <span className="bg-red-500 text-white text-xs px-2 py-0.5 rounded-full font-medium shadow">
                Bib Gourmand
              </span>
            )}
          </div>
          {isSent && (
            <div className="absolute top-3 right-3">
              <span className="bg-emerald-500 text-white text-xs px-2 py-0.5 rounded-full font-medium shadow flex items-center gap-1">
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
                Emailed
              </span>
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent" />
          <div className="absolute bottom-3 left-3">
            <span className="text-white/90 text-xs bg-black/30 backdrop-blur-sm px-2 py-0.5 rounded-full">
              {restaurant.priceRange} · {restaurant.cuisine}
            </span>
          </div>
        </div>

        {/* Content */}
        <div className="p-5">
          {/* Name + Neighborhood */}
          <div className="flex items-start justify-between gap-2 mb-2">
            <h3 className="font-serif text-lg text-[#1C1C1C] leading-tight">
              {restaurant.name}
            </h3>
            <span className="text-xs text-stone-400 whitespace-nowrap mt-0.5">
              {restaurant.neighborhood}
            </span>
          </div>

          {/* Ambiance */}
          <p className="text-sm text-stone-500 leading-relaxed mb-3 line-clamp-2">
            {restaurant.ambiance}
          </p>

          {/* Must Order */}
          <div className="mb-3">
            <p className="text-xs text-[#C9A84C] font-medium uppercase tracking-wider mb-1">
              Must Order
            </p>
            <p className="text-xs text-stone-600 leading-relaxed">
              {restaurant.mustOrder}
            </p>
          </div>

          {/* Reservation Info */}
          <div className="bg-stone-50 rounded-xl p-3 mb-4 space-y-2">
            <p className="text-xs font-semibold text-stone-400 uppercase tracking-widest">
              Reservation Info
            </p>

            {/* Urgency pill */}
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`inline-flex items-center text-xs px-2.5 py-1 rounded-full font-semibold ${
                  urgencyStyles[ctx.urgencyTier]
                }`}
              >
                {ctx.urgencyTier === "today" && (
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5 animate-pulse" />
                )}
                {ctx.urgencyLabel}
              </span>
              {ctx.isActionable && (
                <span className="text-xs text-stone-400">
                  → Dine {ctx.targetDiningDateStr}
                </span>
              )}
            </div>

            <div className="flex items-start gap-2">
              <span className="text-stone-300 mt-0.5">◷</span>
              <p className="text-xs text-stone-600">
                {restaurant.advanceDays > 0
                  ? `${restaurant.advanceDays}-day advance window`
                  : "Rolling reservations"}
                {restaurant.bookingTime && (
                  <>
                    {" "}· opens at{" "}
                    <span className="font-medium">{restaurant.bookingTime}</span>
                  </>
                )}
              </p>
            </div>

            {restaurant.walkInOption && (
              <div className="flex items-start gap-2">
                <span className="text-stone-300 mt-0.5">↪</span>
                <p className="text-xs text-stone-600">{restaurant.walkInOption}</p>
              </div>
            )}
            {(settings.diningTimeStart || settings.diningTimeEnd) && (
              <div className="flex items-start gap-2">
                <span className="text-stone-300 mt-0.5">🕐</span>
                <p className="text-xs text-stone-500">
                  Targeting{" "}
                  <span className="font-medium">
                    {formatTime(settings.diningTimeStart)}
                    {settings.diningTimeEnd && ` – ${formatTime(settings.diningTimeEnd)}`}
                  </span>{" "}
                  ET
                </p>
              </div>
            )}
            <div className="flex items-start gap-2">
              <span className="text-stone-300 mt-0.5">💡</span>
              <p className="text-xs text-stone-500 italic leading-relaxed">
                {restaurant.bookingTip}
              </p>
            </div>
          </div>

          {/* Tags */}
          <div className="flex flex-wrap gap-1.5 mb-4">
            {restaurant.tags.slice(0, 4).map((tag) => (
              <span
                key={tag}
                className="text-xs px-2 py-0.5 bg-stone-100 text-stone-500 rounded-full"
              >
                {tag}
              </span>
            ))}
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            {/* Email Button */}
            <button
              onClick={() => {
                if (!settings.email) {
                  alert("Please configure your email in Settings first.");
                  return;
                }
                setShowModal(true);
              }}
              className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                hasEmail
                  ? "bg-[#1C1C1C] text-white hover:bg-[#333]"
                  : "bg-amber-500 text-white hover:bg-amber-600"
              }`}
            >
              {hasEmail ? "Send Email" : "Send Reminder"}
            </button>

            {/* Calendar Button — works without settings, disabled if window passed */}
            {restaurant.resyUrl && (
              <button
                onClick={downloadCalendarReminder}
                disabled={calendarLoading || !ctx.isActionable}
                title={
                  ctx.isActionable
                    ? `Set booking alert for ${ctx.bookingDateStr}${restaurant.bookingTime ? ` at ${restaurant.bookingTime}` : ""}`
                    : "Booking window has passed"
                }
                className="px-3 py-2.5 rounded-xl border border-stone-200 text-stone-500 hover:bg-stone-50 hover:text-stone-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {calendarLoading ? (
                  <span className="inline-block w-4 h-4 border-2 border-stone-300 border-t-stone-600 rounded-full animate-spin" />
                ) : (
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                    />
                  </svg>
                )}
              </button>
            )}

            {/* Resy Link — pre-filled with nearest preferred day + party size */}
            {restaurant.resyUrl && (
              <a
                href={buildResyUrl(
                  restaurant.resyUrl,
                  ctx.targetDiningDate,
                  settings.partySize,
                  settings.preferredDays ?? ["wednesday", "thursday", "friday", "saturday"]
                )}
                target="_blank"
                rel="noopener noreferrer"
                title={`Open on Resy — pre-filled for ${settings.partySize} guests`}
                className="px-3 py-2.5 rounded-xl border border-stone-200 text-stone-500 hover:bg-stone-50 hover:text-stone-700 transition-colors"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                  />
                </svg>
              </a>
            )}
          </div>

          {/* Email type label */}
          <p className="text-xs text-center text-stone-400 mt-2">
            {hasEmail
              ? `→ ${restaurant.reservationEmail ?? restaurant.contactEmail}`
              : "→ Reminder email sent to you"}
          </p>
        </div>
      </div>

      {showModal && draft && (
        <EmailModal
          draft={draft}
          restaurantName={restaurant.name}
          settings={settings}
          onClose={() => setShowModal(false)}
          onSent={() => onSent(restaurant.id)}
        />
      )}
    </>
  );
}
