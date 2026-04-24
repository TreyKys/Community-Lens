import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { Toaster } from "@/components/ui/toaster";
import { OnboardingIntercept } from "@/components/OnboardingIntercept";
import { BottomTabBar } from "@/components/BottomTabBar";
import Script from "next/script";

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
  title: "Odds.ng — Nigeria's Event-Derivative Market",
  description: "Take positions on football, politics, pop culture and crypto. Smart-money traders. Instant Naira settlement. Cryptographically sealed on Polygon.",
  openGraph: {
    title: "Odds.ng",
    description: "Nigeria's first cryptographically transparent event-derivative market. Trade positions. Earn yield.",
    siteName: "Odds.ng",
  },
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
        {/* Paystack inline JS — loaded here so it's available app-wide */}
        <Script
          src="https://js.paystack.co/v1/inline.js"
          strategy="afterInteractive"
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-saira antialiased`}
        suppressHydrationWarning
      >
        <Providers>
          <Navbar />
          <main className="min-h-screen">
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
