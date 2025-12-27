import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SessionProvider } from "@/components/auth/SessionProvider";
import { SonnerToaster } from "@/components/ui/SonnerToaster";
import { ConsoleNoiseFilter } from "@/components/dev/ConsoleNoiseFilter";
import { AppShell } from "@/components/app/AppShell";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Backranq",
  description: "Train chess puzzles from your own games",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "backranq",
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-96x96.png", sizes: "96x96", type: "image/png" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180" },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}
      >
        <SessionProvider>
          <ConsoleNoiseFilter />
          <AppShell>{children}</AppShell>
          <SonnerToaster />
        </SessionProvider>
      </body>
    </html>
  );
}
