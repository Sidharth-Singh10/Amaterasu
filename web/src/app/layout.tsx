import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "Amaterasu",
  description: "INDmoney charts with an embedded drawing agent",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="h-full">{children}</body>
    </html>
  )
}
