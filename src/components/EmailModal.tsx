"use client";

import { useState } from "react";
import type { EmailDraft } from "@/lib/emailTemplates";
import type { UserSettings } from "@/lib/emailTemplates";

interface Props {
  draft: EmailDraft;
  restaurantName: string;
  settings: UserSettings;
  onClose: () => void;
  onSent: () => void;
}

export default function EmailModal({
  draft,
  restaurantName,
  settings,
  onClose,
  onSent,
}: Props) {
  const [to, setTo] = useState(draft.to);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [status, setStatus] = useState<"idle" | "sending" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function send() {
    if (!settings.email || !settings.gmailAppPassword) {
      setErrorMsg(
        "Please add your Gmail address and App Password in Settings before sending."
      );
      setStatus("error");
      return;
    }

    setStatus("sending");
    setErrorMsg("");

    try {
      const res = await fetch("/api/send-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to,
          subject,
          body,
          gmailUser: settings.email,
          gmailAppPassword: settings.gmailAppPassword,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setStatus("success");
        setTimeout(() => {
          onSent();
          onClose();
        }, 1500);
      } else {
        setErrorMsg(data.message);
        setStatus("error");
      }
    } catch {
      setErrorMsg("Network error — please try again.");
      setStatus("error");
    }
  }

  const labelColor = draft.isDirectToRestaurant
    ? "bg-emerald-100 text-emerald-700"
    : "bg-amber-100 text-amber-700";
  const labelText = draft.isDirectToRestaurant
    ? "Email to Restaurant"
    : "Reminder to Yourself";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="bg-[#1C1C1C] px-6 py-4 flex items-center justify-between">
          <div>
            <p className="text-stone-400 text-xs uppercase tracking-widest mb-1">
              {restaurantName}
            </p>
            <span
              className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${labelColor}`}
            >
              {labelText}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-stone-400 hover:text-white transition-colors text-2xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Email Fields */}
        <div className="p-6 space-y-4 overflow-y-auto flex-1">
          <div>
            <label className="block text-xs font-semibold text-stone-400 uppercase tracking-widest mb-1">
              To
            </label>
            <input
              type="text"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#C9A84C]/50 font-mono"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-stone-400 uppercase tracking-widest mb-1">
              Subject
            </label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#C9A84C]/50"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-stone-400 uppercase tracking-widest mb-1">
              Body
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#C9A84C]/50 resize-none font-mono leading-relaxed"
            />
          </div>

          {status === "error" && (
            <p className="text-red-600 text-sm bg-red-50 px-4 py-3 rounded-lg">
              {errorMsg}
            </p>
          )}
          {status === "success" && (
            <p className="text-emerald-700 text-sm bg-emerald-50 px-4 py-3 rounded-lg font-medium">
              Email sent successfully!
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 pb-6 flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2.5 text-sm text-stone-600 border border-stone-200 rounded-lg hover:bg-stone-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={send}
            disabled={status === "sending" || status === "success"}
            className="px-6 py-2.5 text-sm font-medium text-white bg-[#1C1C1C] rounded-lg hover:bg-[#333] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {status === "sending" ? (
              <>
                <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Sending…
              </>
            ) : status === "success" ? (
              "Sent!"
            ) : (
              "Send Email"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
