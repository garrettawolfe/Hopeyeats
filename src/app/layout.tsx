import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WolfePack Eats — Restaurant Reservation Monitor",
  description:
    "Monitor and auto-book restaurant reservations across NYC, Miami, and the Hamptons.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#FAF7F2] font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
