"use client";

interface Props {
  sentCount: number;
  totalCount: number;
  onSettingsOpen: () => void;
}

export default function Header({ sentCount, totalCount, onSettingsOpen }: Props) {
  return (
    <header className="sticky top-0 z-40 bg-[#1C1C1C] text-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
        <div>
          <h1 className="font-serif text-2xl tracking-tight">HopeYeats</h1>
          <p className="text-stone-400 text-xs mt-0.5 tracking-wide">
            NYC Dining · Reservation Command Center
          </p>
        </div>
        <div className="flex items-center gap-4">
          {sentCount > 0 && (
            <span className="text-xs text-emerald-400 bg-emerald-400/10 px-3 py-1.5 rounded-full">
              {sentCount} / {totalCount} contacted
            </span>
          )}
          <button
            onClick={onSettingsOpen}
            className="flex items-center gap-2 text-sm text-stone-300 hover:text-white transition-colors border border-stone-700 hover:border-stone-500 px-4 py-2 rounded-lg"
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
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            Settings
          </button>
        </div>
      </div>
    </header>
  );
}
