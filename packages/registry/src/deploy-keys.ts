/**
 * Pure ed25519 deploy-key generator. Produces an OpenSSH-format private
 * key + an `ssh-ed25519` wire-format public key, ready to register as a
 * GitHub deploy key and use with `ssh -i <keyfile>`.
 *
 * Lives in @render-harness/registry (not the wizard) because two
 * consumers need it without inheriting Octokit:
 *
 *   1. The wizard's scaffold flow, which pairs this with a
 *      `repos.createDeployKey` call (see `apps/wizard/src/deploy-keys.ts`).
 *   2. The `create-render-agent deploy-key` CLI subcommand, which prints
 *      a keypair for CLI-scaffolded harnesses to wire up edit-in-UI.
 *
 * Why OpenSSH format and not PKCS#8 PEM: the OpenSSH client refuses
 * ed25519 keys in PKCS#8 PEM form and only loads them from the native
 * `-----BEGIN OPENSSH PRIVATE KEY-----` envelope. PKCS#8 works for RSA
 * or EC, not for ed25519. The format spec is the openssh-portable
 * PROTOCOL.key document.
 */

import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";

export interface DeployKeypair {
  /** OpenSSH-format public key, e.g. `ssh-ed25519 AAAA... render-harness`. */
  publicSshKey: string;
  /** OpenSSH-format private key PEM, suitable for `ssh -i`. */
  privatePem: string;
  /** SHA256 fingerprint, e.g. `SHA256:abc...` (matches `ssh-keygen -l -E sha256`). */
  fingerprint: string;
}

const SSH_KEY_TYPE = "ssh-ed25519";
const OPENSSH_PRIVATE_MAGIC = "openssh-key-v1";

export function generateDeployKeypair(comment = "render-harness"): DeployKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubJwk = publicKey.export({ format: "jwk" });
  const privJwk = privateKey.export({ format: "jwk" });
  if (!pubJwk.x || !privJwk.d) {
    throw new Error("ed25519 key export missing required jwk fields");
  }
  const pubBytes = Buffer.from(pubJwk.x, "base64url");
  const privSeed = Buffer.from(privJwk.d, "base64url");
  if (pubBytes.length !== 32) {
    throw new Error(`unexpected ed25519 public key length ${pubBytes.length}`);
  }
  if (privSeed.length !== 32) {
    throw new Error(`unexpected ed25519 private seed length ${privSeed.length}`);
  }
  const trimmed = comment.replace(/\s+/g, " ").trim();
  return {
    publicSshKey: formatPublicKey(pubBytes, trimmed),
    privatePem: formatPrivateKey(pubBytes, privSeed, trimmed),
    fingerprint: sha256Fingerprint(pubBytes),
  };
}

function formatPublicKey(pubBytes: Buffer, comment: string): string {
  const wire = Buffer.concat([wireString(Buffer.from(SSH_KEY_TYPE, "utf8")), wireString(pubBytes)]);
  const suffix = comment ? ` ${comment}` : "";
  return `${SSH_KEY_TYPE} ${wire.toString("base64")}${suffix}`;
}

function formatPrivateKey(pubBytes: Buffer, privSeed: Buffer, comment: string): string {
  const publicKeySection = Buffer.concat([
    wireString(Buffer.from(SSH_KEY_TYPE, "utf8")),
    wireString(pubBytes),
  ]);

  // ed25519 OpenSSH private blobs are 64 bytes: 32-byte seed concatenated
  // with the 32-byte public key, per the libsodium / OpenSSH convention.
  const concatenatedPriv = Buffer.concat([privSeed, pubBytes]);

  const checkInt = randomBytes(4);
  const privateKeySection = Buffer.concat([
    checkInt,
    checkInt,
    wireString(Buffer.from(SSH_KEY_TYPE, "utf8")),
    wireString(pubBytes),
    wireString(concatenatedPriv),
    wireString(Buffer.from(comment, "utf8")),
  ]);
  const padded = padTo8(privateKeySection);

  const body = Buffer.concat([
    Buffer.from(`${OPENSSH_PRIVATE_MAGIC}\0`, "utf8"),
    wireString(Buffer.from("none", "utf8")), // ciphername
    wireString(Buffer.from("none", "utf8")), // kdfname
    wireString(Buffer.alloc(0)), // kdfoptions
    uint32(1), // number of keys
    wireString(publicKeySection),
    wireString(padded),
  ]);

  const base64 = body.toString("base64");
  const wrapped = base64.match(/.{1,70}/g)?.join("\n") ?? base64;
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

function wireString(bytes: Buffer): Buffer {
  return Buffer.concat([uint32(bytes.length), bytes]);
}

function uint32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value, 0);
  return buf;
}

function padTo8(buf: Buffer): Buffer {
  const remainder = buf.length % 8;
  if (remainder === 0) return buf;
  const padLen = 8 - remainder;
  const pad = Buffer.alloc(padLen);
  for (let i = 0; i < padLen; i++) pad[i] = i + 1;
  return Buffer.concat([buf, pad]);
}

function sha256Fingerprint(pubBytes: Buffer): string {
  const wire = Buffer.concat([wireString(Buffer.from(SSH_KEY_TYPE, "utf8")), wireString(pubBytes)]);
  const hash = createHash("sha256").update(wire).digest();
  return `SHA256:${hash.toString("base64").replace(/=+$/, "")}`;
}
