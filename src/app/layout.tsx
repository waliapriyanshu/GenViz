import type { Metadata, Viewport } from "next";
import { Gabarito } from "next/font/google";
import { cn } from "@/lib/utils";
import "@/style/globals.css";
import { Providers } from "./providers";

const gabarito = Gabarito({ subsets: ["latin"], variable: "--font-gabarito" });

export const metadata: Metadata = {
  title: "Genviz — talk to your data",
  description:
    "Upload a CSV or connect PostgreSQL, ask questions in plain English, and get answers with charts.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={cn("bg-background font-sans antialiased", gabarito.variable)}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
