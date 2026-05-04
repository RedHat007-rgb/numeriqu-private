import type { Metadata } from "next";
import { DM_Sans, JetBrains_Mono, Instrument_Serif } from "next/font/google";
import { Providers } from "./providers";
import "./globals.css";

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-instrument-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "NumeriQu | Strategic Financial Intelligence",
  description: "NumeriQu transforms financial complexity into real-time strategic clarity — connecting every data source, eliminating hidden leakages, and giving leadership the confidence to move faster.",
  openGraph: {
    title: "NumeriQu | Strategic Financial Intelligence",
    description: "Real-time financial intelligence for modern CFOs.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${dmSans.variable} ${jetbrainsMono.variable} ${instrumentSerif.variable} font-sans antialiased bg-void text-text-primary`}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
