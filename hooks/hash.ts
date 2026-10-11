// Copyright (c) 2026 Parag Pandya. MIT License, see LICENSE.
// Panda Redline: https://github.com/paragpandyareal/panda-redline
// Based on Lazy Panda Panel: https://github.com/paragpandyareal/lazy-panda-panel

/**
 * A content key for a file: two independent 32-bit hashes of its base64 text
 * and its length, so two files share a key only when they are the same bytes.
 * Used to store each version's content once, never for security.
 */
export function contentKey(text: string): string {
  let h1 = 0xdeadbeef ^ text.length
  let h2 = 0x41c6ce57 ^ text.length
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0')
  return `${hex(h1)}${hex(h2)}${text.length.toString(36)}`
}

/** A short key for a string (a folder, a row's text): 8 hex digits. */
export function shortKey(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return (h >>> 0).toString(16).padStart(8, '0')
}
