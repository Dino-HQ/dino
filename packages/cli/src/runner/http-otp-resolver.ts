/**
 * #1759 Spec B3b — HTTP-backed OTP read for runner scans (wraps CfInboxOtpResolver).
 */

import { CfInboxOtpResolver } from '@dino/auth';
import type { OtpResolver } from '@dino/auth';

export type OtpReadResult = {
  text: string;
  receivedAt: number;
};

/** Poll-safe HTTP client for GET /v1/runners/:id/otp. */
export interface OtpHttpClient {
  readOtp(address: string): Promise<OtpReadResult | null>;
}

export function createHttpOtpResolver(opts: {
  otpClient: OtpHttpClient;
  address: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  extractPattern?: string;
  pollIntervalMs?: number;
  /** INV-3: reject OTP messages received before this timestamp (ms). Set at resolve() if omitted. */
  windowStartMs?: number;
}): OtpResolver {
  let windowStart = opts.windowStartMs;

  const inner = new CfInboxOtpResolver({
    address: opts.address,
    readOtp: async (addr) => {
      const msg = await opts.otpClient.readOtp(addr);
      if (msg === null) {
        return null;
      }
      const start = windowStart ?? opts.now();
      if (msg.receivedAt < start) {
        return null;
      }
      return { text: msg.text };
    },
    ...(opts.extractPattern === undefined ? {} : { extractPattern: opts.extractPattern }),
    ...(opts.pollIntervalMs === undefined ? {} : { pollIntervalMs: opts.pollIntervalMs }),
    now: opts.now,
    sleep: opts.sleep,
  });

  return {
    resolve: async (ctx) => {
      windowStart ??= opts.windowStartMs ?? opts.now();
      return inner.resolve(ctx);
    },
  };
}
