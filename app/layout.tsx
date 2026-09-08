import type { Metadata } from "next";
import { Archivo, Fraunces, Source_Serif_4 } from "next/font/google";
import "./globals.css";

const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces" });
const sourceSerif = Source_Serif_4({ subsets: ["latin"], variable: "--font-source-serif" });
const archivo = Archivo({ subsets: ["latin"], variable: "--font-archivo" });

export const metadata: Metadata = {
  title: "Read Deeper",
  description: "Understand any document, one highlight at a time.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        className={`${fraunces.variable} ${sourceSerif.variable} ${archivo.variable} min-h-screen`}
      >
        {children}
      </body>
    </html>
  );
}
