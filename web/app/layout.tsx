import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Receipts",
  description: "Freelance work PayPal can see: money reserved up front, released stage by stage, defended with evidence.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <a href="/" className="brand" style={{ color: "inherit", textDecoration: "none" }}>Receipts</a>
          <nav>
            <a href="/">Jobs</a>
            <a href="/console">Console</a>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
