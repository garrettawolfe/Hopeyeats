"use client";

import { useState } from "react";

interface Props {
  onLogin: (username: string) => void;
}

export default function LoginPage({ onLogin }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const name = username.trim();
    if (!name) {
      setError("Please enter your first name.");
      return;
    }

    if (password !== "garrettisthebest") {
      setError("Incorrect password. Please try again.");
      return;
    }

    onLogin(name);
  };

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="font-serif text-4xl text-charcoal tracking-tight">
            WolfePack Eats
          </h1>
          <p className="text-stone-400 text-sm mt-1">
            Restaurant Reservation Monitor
          </p>
        </div>

        {/* Login card */}
        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-2xl shadow-lg border border-stone-200 p-6 space-y-5"
        >
          {/* Username */}
          <div>
            <label
              htmlFor="username"
              className="text-xs font-semibold text-charcoal uppercase tracking-wider block mb-2"
            >
              First Name
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter your first name"
              autoFocus
              className="w-full px-4 py-3 border border-stone-200 rounded-xl text-sm text-charcoal placeholder:text-stone-300 focus:outline-none focus:ring-2 focus:ring-gold/50 focus:border-gold/30 transition-shadow"
            />
          </div>

          {/* Password */}
          <div>
            <label
              htmlFor="password"
              className="text-xs font-semibold text-charcoal uppercase tracking-wider block mb-2"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              className="w-full px-4 py-3 border border-stone-200 rounded-xl text-sm text-charcoal placeholder:text-stone-300 focus:outline-none focus:ring-2 focus:ring-gold/50 focus:border-gold/30 transition-shadow"
            />
          </div>

          {/* Error */}
          {error && (
            <p className="text-xs text-red-500 text-center">{error}</p>
          )}

          {/* Submit */}
          <button
            type="submit"
            className="w-full py-3 bg-charcoal text-white rounded-xl text-sm font-semibold hover:bg-charcoal/90 transition-colors"
          >
            Sign In
          </button>

          <p className="text-[11px] text-stone-400 text-center leading-relaxed">
            You can configure your Resy token after signing in via Settings.
          </p>
        </form>
      </div>
    </div>
  );
}
