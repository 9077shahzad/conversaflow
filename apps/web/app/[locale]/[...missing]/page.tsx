import { notFound } from 'next/navigation';

/** Any path under /en or /ar that has no page: show the localised, per-request not-found page (status 404). */
export default function Missing(): never {
  notFound();
}
