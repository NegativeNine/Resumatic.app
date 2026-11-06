export function extractionConfiguration(
  strategies: string[],
  environment: string,
  opts?: { root?: string; priceOverrides?: Record<string, [number, number]> },
): { models: Record<string, string>; hash: string };
