import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider, UserButton, SignedIn, SignedOut, SignInButton } from "@clerk/nextjs";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Agent Observability Platform",
  description: "Monitor your AI development spend and performance",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body
          className={`${geistSans.variable} ${geistMono.variable} antialiased`}
        >
          <header className="border-b border-gray-200 bg-white px-6 py-3">
            <div className="mx-auto flex max-w-5xl items-center justify-between">
              <div className="flex items-center gap-6">
                <span className="text-sm font-semibold text-gray-900">
                  Agent Observability
                </span>
                <nav className="flex gap-4 text-sm text-gray-600">
                  <a
                    href="/dashboard"
                    className="hover:text-gray-900"
                  >
                    Org Dashboard
                  </a>
                  <SignedIn>
                    <a
                      href="/me"
                      className="hover:text-gray-900"
                    >
                      My Activity
                    </a>
                  </SignedIn>
                </nav>
              </div>
              <div>
                <SignedOut>
                  <SignInButton>
                    <button className="rounded-md bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700">
                      Sign in
                    </button>
                  </SignInButton>
                </SignedOut>
                <SignedIn>
                  <UserButton />
                </SignedIn>
              </div>
            </div>
          </header>
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
