import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HopeYeats — NYC Dining Reservation Command Center",
  description:
    "Manage reservation outreach for the best restaurants in New York City.",
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
