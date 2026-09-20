import { describe, expect, it } from 'vitest';
import { clientAddress } from './limiter.ts';

describe('clientAddress', () => {
  it('ignores X-Forwarded-For entirely when no proxy is trusted', () => {
    expect(clientAddress('10.0.0.9', '203.0.113.7', 0)).toBe('10.0.0.9');
  });

  it('takes the entry our own proxy appended, not the one the caller typed', () => {
    // The caller sent `X-Forwarded-For: 1.2.3.4`; our proxy appended the truth.
    expect(clientAddress('10.0.0.2', '1.2.3.4, 198.51.100.23', 1)).toBe('198.51.100.23');
  });

  it('counts back by the number of trusted hops', () => {
    expect(clientAddress('10.0.0.2', '1.2.3.4, 198.51.100.23, 10.0.0.5', 2)).toBe('198.51.100.23');
  });

  it('falls back to the socket when the header is shorter than the trusted chain', () => {
    expect(clientAddress('10.0.0.2', '198.51.100.23', 2)).toBe('10.0.0.2');
    expect(clientAddress('10.0.0.2', undefined, 1)).toBe('10.0.0.2');
    expect(clientAddress('10.0.0.2', ' , ', 1)).toBe('10.0.0.2');
  });

  it('handles the header arriving as repeated fields', () => {
    expect(clientAddress('10.0.0.2', ['1.2.3.4', '198.51.100.23'], 1)).toBe('198.51.100.23');
  });

  it('never returns an empty key', () => {
    expect(clientAddress(undefined, undefined, 0)).toBe('unknown');
  });
});
