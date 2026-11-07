"use strict";

// Encryption for the public board, shared by the add-on (encrypts) and the board page (decrypts).
// gzip, then AES-GCM with a 256-bit key derived from the passphrase (PBKDF2-SHA256). Only the
// encrypted file is ever uploaded.

const KDF_ITERATIONS = 600000;

function b64enc(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
const b64dec = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function pipe(u8, stream) {
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(stream)).arrayBuffer());
}

async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function encryptJson(obj, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, KDF_ITERATIONS);
  const packed = await pipe(new TextEncoder().encode(JSON.stringify(obj)), new CompressionStream("gzip"));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, packed));
  return { v: 1, kdf: "PBKDF2-SHA256", iter: KDF_ITERATIONS, zip: "gzip", salt: b64enc(salt), iv: b64enc(iv), ct: b64enc(ct) };
}

// Throws on a wrong passphrase (AES-GCM fails to authenticate).
async function decryptJson(file, passphrase) {
  if (!file || file.v !== 1) throw new Error("Unknown board file format.");
  const key = await deriveKey(passphrase, b64dec(file.salt), file.iter);
  const packed = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64dec(file.iv) }, key, b64dec(file.ct)));
  return JSON.parse(new TextDecoder().decode(await pipe(packed, new DecompressionStream("gzip"))));
}

async function sha256Hex(text) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...d].map(b => b.toString(16).padStart(2, "0")).join("");
}
