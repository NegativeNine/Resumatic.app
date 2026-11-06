import { base64url } from "../../src/worker/crypto";

/** An RSA key pair that signs RS256 tokens and publishes its public half as a JSON Web Key Set. */
export async function rsaSigner(kid = crypto.randomUUID()) {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  async function signRaw(json: string, header: Record<string, unknown> = {}): Promise<string> {
    const head = encode({ alg: "RS256", typ: "JWT", kid, ...header });
    const body = base64url(new TextEncoder().encode(json));
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${base64url(signature)}`;
  }
  return {
    kid,
    jwks: { keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] },
    signRaw,
    async sign(claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
      return signRaw(JSON.stringify(claims), header);
    },
  };
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);
