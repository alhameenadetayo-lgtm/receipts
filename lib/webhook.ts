// PayPal webhook verification by postback (POST /v1/notifications/verify-webhook-signature).
// The raw body is spliced in byte-for-byte: parsing and re-stringifying it breaks the signature.

export type PaypalSignatureHeaders = {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
};

type HeaderSource = { get(name: string): string | null };

export function readSignatureHeaders(headers: HeaderSource): PaypalSignatureHeaders {
  const pick = (name: string) => {
    const v = headers.get(name);
    if (!v) throw new Error(`missing header ${name}`);
    return v;
  };
  const h = {
    authAlgo: pick('paypal-auth-algo'),
    certUrl: pick('paypal-cert-url'),
    transmissionId: pick('paypal-transmission-id'),
    transmissionSig: pick('paypal-transmission-sig'),
    transmissionTime: pick('paypal-transmission-time'),
  };
  const cert = new URL(h.certUrl);
  if (cert.protocol !== 'https:' || !(cert.hostname === 'paypal.com' || cert.hostname.endsWith('.paypal.com'))) {
    throw new Error('cert url is not a paypal.com https url');
  }
  return h;
}

export function buildVerifyBody(rawBody: string, h: PaypalSignatureHeaders, webhookId: string): string {
  JSON.parse(rawBody); // refuse anything that is not JSON before splicing it in
  const head = JSON.stringify({
    auth_algo: h.authAlgo,
    cert_url: h.certUrl,
    transmission_id: h.transmissionId,
    transmission_sig: h.transmissionSig,
    transmission_time: h.transmissionTime,
    webhook_id: webhookId,
  });
  return `${head.slice(0, -1)},"webhook_event":${rawBody}}`;
}

// post() is injected so the logic can be tested without PayPal. It must return PayPal's JSON reply.
export async function verifyWebhook(
  rawBody: string,
  headers: HeaderSource,
  webhookId: string,
  post: (path: string, body: string) => Promise<{ verification_status?: string }>,
): Promise<{ ok: boolean; reason: string }> {
  let h: PaypalSignatureHeaders;
  try {
    h = readSignatureHeaders(headers);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  let body: string;
  try {
    body = buildVerifyBody(rawBody, h, webhookId);
  } catch {
    return { ok: false, reason: 'body is not JSON' };
  }
  try {
    const res = await post('/v1/notifications/verify-webhook-signature', body);
    return res.verification_status === 'SUCCESS'
      ? { ok: true, reason: 'verified' }
      : { ok: false, reason: `verification_status ${res.verification_status ?? 'missing'}` };
  } catch (e) {
    return { ok: false, reason: `verify call failed: ${(e as Error).message}` }; // fail closed
  }
}
