"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export default function AppNav() {
  const pathname = usePathname();
  const tabs = [
    { href: "/", label: "Live", icon: "●" },
    { href: "/snipe", label: "Snipe", icon: "⚡" },
    { href: "/notify", label: "Notify", icon: "🔔" },
  ];
  return (
    <nav className="flex gap-1 px-3 sm:px-6 py-2 border-b border-stone-700 bg-charcoal">
      {tabs.map(({ href, label, icon }) => {
        const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
              isActive
                ? label === "Snipe" ? "bg-red-600 text-white"
                  : label === "Notify" ? "bg-orange-500 text-white"
                  : "bg-white/20 text-white"
                : "text-stone-400 hover:text-white hover:bg-white/10"
            }`}
          >
            {icon} {label}
          </Link>
        );
      })}
    </nav>
  );
}
