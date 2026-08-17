import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Solo Marketing OS",
};

/**
 * Root document. The app shell itself (left rail, command bar, contextual
 * inspector) lives in (app)/layout.tsx -- this only sets the document up.
 *
 * globals.css is imported here because it is the only place that applies to
 * every route, including /login which sits outside the (app) group.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
