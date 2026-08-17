// A 429 is rejected before the SSE stream opens, so it arrives as a plain HTTP
// status on the streaming fetches. This carries the server's message past the
// generic "something went wrong" fallbacks in the catch blocks.
export class LimitError extends Error {}

export async function limitErrorFrom(response: Response): Promise<LimitError> {
  const body = await response.json().catch(() => null);
  return new LimitError(
    body?.message ?? "You've reached your usage limit. Try again later.",
  );
}
