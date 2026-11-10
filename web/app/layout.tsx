import "./globals.css";
import type { Metadata } from "next";
import { JetBrains_Mono, Schibsted_Grotesk } from "next/font/google";

const sans = Schibsted_Grotesk({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Receipts",
  description: "Freelance work PayPal can see: money reserved up front, released stage by stage, defended with evidence.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <header className="top">
          <a href="/" className="brand" style={{ textDecoration: "none" }}>Receipts</a>
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
