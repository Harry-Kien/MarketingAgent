import { PageState } from "../../ui/PageState.tsx";

/**
 * Next.js App Router convention: this renders automatically inside the
 * Suspense boundary Next creates around this route group while an async
 * Server Component (layout or page) is still resolving -- the `loading`
 * member of the seven required PageStates (Global Constraint: "Mọi trang có
 * đủ 7 state"), without every individual page needing to wire up its own
 * Suspense fallback.
 */
export default function Loading() {
  return <PageState kind="loading" />;
}
