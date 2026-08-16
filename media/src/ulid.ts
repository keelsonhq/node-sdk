/**
 * Minimal ULID generator (Crockford Base32, no dependencies).
 */

import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeCrockford(value: bigint, length: number): string {
  const chars: string[] = new Array(length).fill("0");
  for (let i = length - 1; i >= 0; i--) {
    chars[i] = CROCKFORD[Number(value & 31n)];
    value >>= 5n;
  }
  return chars.join("");
}

export function newUlid(): string {
  const millis = BigInt(Date.now());
  const rand = randomBytes(10);
  let entropy = 0n;
  for (const byte of rand) {
    entropy = (entropy << 8n) | BigInt(byte);
  }
  return `${encodeCrockford(millis, 10)}${encodeCrockford(entropy, 16)}`;
}
