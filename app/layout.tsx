import type { Metadata } from "next";
import "./globals.css";
import HelpPanel from "./help-panel";

export const metadata: Metadata = {
  title: "Travel Planner",
  description: "Chat with Claude to plan your next trip",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <footer className="site-footer">
          <HelpPanel />
          <a href="/privacy">Privacy</a>
        </footer>
      </body>
    </html>
  );
}
