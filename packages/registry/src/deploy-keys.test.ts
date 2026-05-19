import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateDeployKeypair } from "./deploy-keys.js";

/**
 * Parse the binary body of an `-----BEGIN OPENSSH PRIVATE KEY-----`
 * envelope into its constituent wire-format fields. Mirrors the read
 * side of openssh-portable's PROTOCOL.key so the round-trip test can
 * check that what we wrote round-trips back to the same raw bytes.
 */
function parseOpenSshPrivateKey(pem: string): {
  pubKeyRaw: Buffer;
  privSeed: Buffer;
  comment: string;
} {
  const base64 = pem
    .replace("-----BEGIN OPENSSH PRIVATE KEY-----", "")
    .replace("-----END OPENSSH PRIVATE KEY-----", "")
    .replaceAll(/\s+/g, "");
  const body = Buffer.from(base64, "base64");
  let off = 0;
  const magic = body.slice(off, off + 15).toString("utf8");
  off += 15;
  if (magic !== "openssh-key-v1\0") throw new Error("bad magic");
  const readString = (): Buffer => {
    const len = body.readUInt32BE(off);
    off += 4;
    const out = body.slice(off, off + len);
    off += len;
    return out;
  };
  readString(); // ciphername
  readString(); // kdfname
  readString(); // kdfoptions
  const nkeys = body.readUInt32BE(off);
  off += 4;
  if (nkeys !== 1) throw new Error(`expected 1 key, got ${nkeys}`);
  readString(); // wrapped public-key section
  const privSection = readString();
  let poff = 0;
  const check1 = privSection.readUInt32BE(poff);
  poff += 4;
  const check2 = privSection.readUInt32BE(poff);
  poff += 4;
  if (check1 !== check2) throw new Error("check ints mismatch");
  const innerString = (): Buffer => {
    const len = privSection.readUInt32BE(poff);
    poff += 4;
    const out = privSection.slice(poff, poff + len);
    poff += len;
    return out;
  };
  innerString(); // keytype
  const pubKeyRaw = innerString();
  const privConcat = innerString();
  const comment = innerString().toString("utf8");
  // privConcat is 64 bytes: 32-byte seed + 32-byte public key.
  return { pubKeyRaw, privSeed: privConcat.slice(0, 32), comment };
}

describe("generateDeployKeypair", () => {
  it("returns an ssh-ed25519 public key with the requested comment", () => {
    const { publicSshKey } = generateDeployKeypair("alice@laptop");
    expect(publicSshKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=* alice@laptop$/);
  });

  it("omits the comment when none is supplied (empty string)", () => {
    const { publicSshKey } = generateDeployKeypair("");
    // No trailing space if comment is empty
    expect(publicSshKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=*$/);
  });

  it("collapses internal whitespace in the comment", () => {
    const { publicSshKey } = generateDeployKeypair("  hello   world  ");
    expect(publicSshKey.endsWith(" hello world")).toBe(true);
  });

  it("wraps the private key in the OpenSSH PEM envelope", () => {
    const { privatePem } = generateDeployKeypair();
    expect(privatePem.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----\n")).toBe(true);
    expect(privatePem.endsWith("\n-----END OPENSSH PRIVATE KEY-----\n")).toBe(true);
  });

  it("emits a SHA256: fingerprint without base64 padding", () => {
    const { fingerprint } = generateDeployKeypair();
    expect(fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(fingerprint.endsWith("=")).toBe(false);
  });

  it("the public key wire format decodes to a 32-byte ed25519 key", () => {
    const { publicSshKey } = generateDeployKeypair();
    const base64 = publicSshKey.split(/\s+/)[1] ?? "";
    const wire = Buffer.from(base64, "base64");
    // string("ssh-ed25519") then string(<32 bytes>)
    const typeLen = wire.readUInt32BE(0);
    expect(typeLen).toBe(11);
    expect(wire.slice(4, 4 + typeLen).toString("utf8")).toBe("ssh-ed25519");
    const keyLen = wire.readUInt32BE(4 + typeLen);
    expect(keyLen).toBe(32);
  });

  it("the OpenSSH private envelope round-trips back to the same raw seed and public key", () => {
    // Node's createPrivateKey doesn't accept the OpenSSH envelope, so
    // we hand-parse the binary body and rebuild a Node KeyObject from
    // the raw bytes via JWK. If sign/verify works through that
    // reconstruction then the bytes we wrote into the OpenSSH envelope
    // are consistent with an actual ed25519 keypair that `ssh -i` would
    // accept.
    const { publicSshKey, privatePem } = generateDeployKeypair("alice@host");
    const { pubKeyRaw, privSeed, comment } = parseOpenSshPrivateKey(privatePem);
    expect(comment).toBe("alice@host");

    // The public-key wire format that we emit must match the public-key
    // bytes embedded inside the private envelope.
    const wirePub = Buffer.from(publicSshKey.split(/\s+/)[1] ?? "", "base64");
    expect(wirePub.slice(wirePub.length - 32).equals(pubKeyRaw)).toBe(true);

    // Reconstruct via JWK and round-trip a signature.
    const priv = createPrivateKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: pubKeyRaw.toString("base64url"),
        d: privSeed.toString("base64url"),
      },
      format: "jwk",
    });
    const pub = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: pubKeyRaw.toString("base64url") },
      format: "jwk",
    });
    const message = Buffer.from("hello render harness");
    const sig = sign(null, message, priv);
    const ok = verify(null, message, pub, sig);
    expect(ok).toBe(true);
  });

  it("two consecutive generations produce distinct keys", () => {
    const a = generateDeployKeypair();
    const b = generateDeployKeypair();
    expect(a.publicSshKey).not.toBe(b.publicSshKey);
    expect(a.privatePem).not.toBe(b.privatePem);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});
