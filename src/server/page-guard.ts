import { forbidden, notFound } from "next/navigation";
import { ForbiddenError, NotFoundError } from "./errors";

/**
 * Wraps a page so authorization errors thrown by services while it loads render the
 * 403 / 404 pages instead of the generic error boundary. Route handlers and server
 * actions keep receiving the typed errors.
 */
export function guardPage<P>(Page: (props: P) => Promise<React.ReactNode>) {
  return async function GuardedPage(props: P) {
    try {
      return await Page(props);
    } catch (e) {
      if (e instanceof ForbiddenError) forbidden();
      if (e instanceof NotFoundError) notFound();
      throw e;
    }
  };
}
