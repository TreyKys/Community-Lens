import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";
import { Toaster } from "@/components/ui/toaster";
import { OnboardingIntercept } from "@/components/OnboardingIntercept";
import { WelcomeModal } from "@/components/WelcomeModal";
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
  // metadataBase resolves all relative OG / Twitter URLs (including the
  // auto-generated opengraph-image.tsx) against this canonical origin.
  // Without it, share previews break on non-production domains.
  metadataBase: new URL('https://opinionsng.com'),
  title: {
    default: "Opinions.ng — Nigeria's Event-Prediction Market",
    template: '%s — Opinions.ng',
  },
  description: "Predict football, politics, pop culture and the economy. Smart-money traders. Instant Naira settlement. Cryptographically sealed on Polygon.",
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    locale: 'en_NG',
    url: 'https://opinionsng.com',
    title: "Opinions.ng — Nigeria's Event-Prediction Market",
    description: "Nigeria's first cryptographically transparent event-prediction market. Take positions. Earn yield.",
    siteName: 'Opinions.ng',
  },
  twitter: {
    card: 'summary_large_image',
    site: '@opinions_ng',
    title: "Opinions.ng — Nigeria's Event-Prediction Market",
    description: "Predict football, politics, pop culture and the economy. Sealed on Polygon, settled in Naira.",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
};

// JSON-LD Organization schema. This is the structured-data signal
// Google uses to build the knowledge panel + corporate sidebar for
// branded searches ("opinions ng", "opinionsng.com"). Without it, even
// a perfectly SEO'd site shows up as a list of blue links with no
// "this is a real company" affordance. sameAs entries connect the
// brand to its verified social profiles, which is what links the
// X/Instagram accounts to the website in Google's graph.
const organizationJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Opinions.ng',
  url: 'https://opinionsng.com',
  logo: 'https://opinionsng.com/opengraph-image',
  description: "Nigeria's first cryptographically transparent event-prediction market. Predict football, politics, pop culture and the economy.",
  sameAs: [
    'https://x.com/opinions_ng',
    'https://www.instagram.com/opinionshq_ng',
  ],
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
        {/* JSON-LD Organization schema — see note above the constant. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
        />
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
          {/* Profile-completion intercept fires for signed-in users; */}
          {/* Welcome modal fires for unauth visitors. They're mutually */}
          {/* exclusive by design — both checks gate on session. */}
          <OnboardingIntercept />
          <WelcomeModal />
        </Providers>
      </body>
    </html>
  );
}
