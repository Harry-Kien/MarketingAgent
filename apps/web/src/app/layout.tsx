import type { ReactNode } from "react";

export const metadata = {
  title: "Solo Marketing OS",
};

/**
 * Placeholder shell for P0. P3 replaces this with the real app shell: left
 * rail, command bar and contextual inspector.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
