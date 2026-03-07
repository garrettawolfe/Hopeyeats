"use client";

import { useState } from "react";
import Image from "next/image";
import type { Restaurant } from "@/data/restaurants";
import type { UserSettings } from "@/lib/emailTemplates";
import { generateEmail, getBookingDate } from "@/lib/emailTemplates";
import EmailModal from "./EmailModal";

interface Props {
  restaurant: Restaurant;
  settings: UserSettings;
  isSent: boolean;
  onSent: (id: string) => void;
}

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
  const draft = settings.email
    ? generateEmail(restaurant, settings)
    : null;

  // Calculate booking date if user has set a dining date
  const bookingInfo =
    settings.diningDateStart && restaurant.advanceDays
      ? getBookingDate(settings.diningDateStart, restaurant.advanceDays)
      : null;

  async function downloadCalendarReminder() {
    if (!settings.diningDateStart) {
      alert("Please set your dining date in Settings first.");
      return;
    }

    setCalendarLoading(true);
    try {
      const target = new Date(settings.diningDateStart);
      const bookingDate = new Date(target);
      bookingDate.setDate(target.getDate() - restaurant.advanceDays);
      const bookingDateStr = bookingDate.toISOString().split("T")[0];

      const res = await fetch("/api/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          restaurantId: restaurant.id,
          restaurantName: restaurant.name,
          bookingDate: bookingDateStr,
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
        }`}
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
          <div className="bg-stone-50 rounded-xl p-3 mb-4 space-y-1.5">
            <p className="text-xs font-semibold text-stone-400 uppercase tracking-widest mb-2">
              Reservation Info
            </p>
            <div className="flex items-start gap-2">
              <span className="text-stone-300 mt-0.5">◷</span>
              <div>
                <p className="text-xs text-stone-700">
                  {restaurant.advanceDays > 0
                    ? `Opens ${restaurant.advanceDays} days in advance`
                    : "Rolling reservations"}
                  {restaurant.bookingTime && (
                    <> · <span className="font-medium">{restaurant.bookingTime}</span></>
                  )}
                </p>
                {bookingInfo && (
                  <p className="text-xs text-[#C9A84C] font-medium mt-0.5">
                    Book on {bookingInfo.fullDate}
                    {restaurant.bookingTime && ` at ${restaurant.bookingTime}`}
                  </p>
                )}
              </div>
            </div>
            {restaurant.walkInOption && (
              <div className="flex items-start gap-2">
                <span className="text-stone-300 mt-0.5">↪</span>
                <p className="text-xs text-stone-600">{restaurant.walkInOption}</p>
              </div>
            )}
            <div className="flex items-start gap-2 pt-1">
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

            {/* Calendar Button */}
            {restaurant.resyUrl && (
              <button
                onClick={downloadCalendarReminder}
                disabled={calendarLoading}
                title="Download calendar reminder (fires 15 min before booking opens)"
                className="px-3 py-2.5 rounded-xl border border-stone-200 text-stone-500 hover:bg-stone-50 hover:text-stone-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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

            {/* Resy Link */}
            {restaurant.resyUrl && (
              <a
                href={restaurant.resyUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="Open on Resy"
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
