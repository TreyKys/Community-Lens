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
  title: "TruthMarket — Nigeria's Prediction Market",
  description: "Bet on football, politics, economics and more. Community-set odds, on-chain transparency, instant Naira payouts.",
  openGraph: {
    title: "TruthMarket",
    description: "Nigeria's first decentralised prediction market. Bet on anything. Get paid instantly.",
    siteName: "TruthMarket",
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
        <link href="https://fonts.googleapis.com/css2?family=Saira+Stencil:ital,wght@0,100..900;1,100..900&display=swap" rel="stylesheet" />
        <link href="https://fonts.googleapis.com/css2?family=Rufina:wght@400;700&display=swap" rel="stylesheet" />
        {/* Paystack inline JS — loaded here so it's available app-wide */}
        <Script
          src="https://js.paystack.co/v1/inline.js"
          strategy="afterInteractive"
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-rufina antialiased`}
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
