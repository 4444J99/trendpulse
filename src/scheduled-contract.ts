export interface ScheduledAuthority {
  PRODUCT_RELEASE_SHA?: string;
  OPS_EXECUTION_AUTH?: {
    claim(payload: unknown): Promise<{authorized: boolean}>;
    complete(payload: unknown, receipt: unknown): Promise<boolean>;
  };
}
/** Service Binding identity is necessary; the durable admitted dispatch is also required. */
export async function protectScheduledInvocation(
  request: Request, env: ScheduledAuthority, target: string, capability: string,
  execute: () => Promise<Response>,
): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method Not Allowed', {status:405});
  const payload = await request.clone().json().catch(() => null) as Record<string,unknown> | null;
  if (!payload || payload.target !== target || payload.capability !== capability) {
    return Response.json({ok:false,error:'invalid_dispatch_identity'}, {status:400});
  }
  const authority = env.OPS_EXECUTION_AUTH;
  if (!authority) return Response.json({ok:false,error:'execution_authority_unavailable'}, {status:503});
  if (!env.PRODUCT_RELEASE_SHA || payload.targetSourceSha !== env.PRODUCT_RELEASE_SHA) {
    return Response.json({ok:false,error:'product_source_mismatch'}, {status:403});
  }
  try {
    if (!(await authority.claim(payload)).authorized) {
      return Response.json({ok:false,error:'dispatch_not_authorized'}, {status:403});
    }
    const response = await execute();
    const outcome = await response.json() as Record<string,unknown>;
    if (typeof outcome.ok !== 'boolean') throw new Error('invalid_product_receipt');
    const receipt = {...outcome,
      state: outcome.ok ? (outcome.state === 'accepted' ? 'accepted' : 'completed') : 'failed',
      runId:payload.runId,attempt:payload.attempt,fencingToken:payload.fencingToken,
      admissionGeneration:payload.admissionGeneration,sourceSha:payload.sourceSha,
      targetSourceSha:env.PRODUCT_RELEASE_SHA,
      resultRef:'ops-run:'+String(payload.runId)+':'+String(payload.attempt),
    };
    if (!await authority.complete(payload,receipt)) throw new Error('receipt_custody_failed');
    return Response.json(receipt);
  } catch {
    // An acquired claim is retained. This is ambiguous, never permission to replay.
    return Response.json({ok:false,error:'execution_or_receipt_unobserved'}, {status:503});
  }
}

