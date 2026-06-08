import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { Toaster } from "@/components/ui/toaster";
import { OnboardingIntercept } from "@/components/OnboardingIntercept";
import { BottomTabBar } from "@/components/BottomTabBar";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Opinions.ng — Nigeria's Event-Prediction Market",
  description: "Predict football, politics, pop culture and the economy. Smart-money traders. Instant Naira settlement. Cryptographically sealed on Polygon.",
  openGraph: {
    title: "Opinions.ng",
    description: "Nigeria's first cryptographically transparent event-prediction market. Take positions. Earn yield.",
    siteName: "Opinions.ng",
  },
};

// Without this Android Chrome renders the page at ~980px desktop width and
// shrinks the whole layout to fit the device, which compresses 10-11px labels
// into sub-pixel rows and surfaces them as horizontal "no signal" scanlines.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Saira+Stencil:wght@100..900&display=swap" rel="stylesheet" />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-saira antialiased`}
        suppressHydrationWarning
      >
        <Providers>
          {/* Living emerald gradient backdrop, anchored behind every page */}
          <div className="opinions-bg" aria-hidden="true" />
          <Navbar />
          <main className="min-h-screen relative">
            {children}
          </main>
          <Footer />
          <BottomTabBar />
          <Toaster />
          <OnboardingIntercept />
        </Providers>
      </body>
    </html>
  );
}
